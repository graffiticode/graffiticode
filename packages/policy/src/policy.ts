// The policy authority's decisions. A connection's owner may use every
// registered function against its backend, unless they have narrowed their own
// use to a list (connections.js ownerPermissions); another account may use the
// delegable functions a live grant from the owner names (grants.js). There are
// no execution modes and no intents: running the program is the action, and
// the grant is the authority.
//
//   invocation  once per logical invocation, by the gateway before dispatch
//             (see invocations.js): a durable id that retries share and an
//             intentional rerun does not, in a token the compiler forwards.
//   snapshot  once per compile: which protected functions this invocation may
//             use through the selected connection. Returns the allowed set
//             (for the compiler's admission pass) and a session token binding
//             it to the user, connection, language, invocation and
//             composition stage.
//   preview-session  once per compile with NO user connection: a session on
//             the Graffiticode-owned system connection for the language's
//             backend (POLICY_SYSTEM_CONNECTIONS), carrying only the
//             language's system-preview functions (implicit, view-safe
//             signing). No user and no invocation; it can sign a render and
//             never write or open the Author Site.
//   mint      once per broker operation: re-checks live state and the full
//             lang/fn/op/backend relationship against the registry, and
//             issues a short execution token scoped to that one request. The
//             operation id is invocation/stage/occurrence, so a retry of the
//             same invocation reaches the same write receipt. A mint under a
//             system preview session takes a token from this instance's
//             bucket (rate-limit.js; `rate-limited` when it is empty) and
//             carries the session's expiry as `sexp`, which Broker's
//             per-session signature slots are retained by.
//   admission (contract v2, capability plan W4) once per chain, by the
//             gateway, before any stage executes: every stage's preflight
//             manifest, pinned to approved compiler revisions, decided in one
//             consistent read. Denying any stage denies the chain. The plan
//             (by its digest) binds every later snapshot, mint and
//             authorization for the invocation. Stored-artifact reads may
//             sign through view-safe functions without executing a plan.
//             `planLookup` gives a retry the plan before it
//             resolves any compiler URL.
//
// Callers are authenticated before reaching here: `user` is the verified end
// user and `caller.lang` the language bound to the verified calling service.
// Every decision, allowed or denied, is audited.

import {
  REGISTRY_VERSION,
  REGISTRY_WINDOW,
  isAcceptedRegistryVersion,
  isOperationAllowed,
  protectedFunctionsForLang,
  systemPreviewFunctionsForLang,
  viewSafeFunctionsForLang,
  isStepRegistered,
  PROTECTED_FUNCTIONS
} from "@graffiticode/common/protected-registry";
import { createHash, randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { decodeChainId } from "@graffiticode/common/chain";
import { CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSIONS, manifestProblems, pinnedStage, planDigest as digestOf, stageBinding, sameStage } from "@graffiticode/common/contract";
import { issueToken, verifyToken } from "./tokens.js";
import { grantIdFor, isExpired } from "./grants.js";
import { InvocationConflict, AdmissionRefused, ProtocolMismatch } from "./invocations.js";
import { CommandRefused, COMMAND_ID_RE, WORKER_RE, commandSummary, ownerRefusal, requestProblem } from "./commands.js";
import { RUNTIME_PREFIX, runtimeOccurrenceId } from "./command-records.js";
import { newPublicationId } from "./publications.js";
import { MAINTENANCE, admission } from "./maintenance.js";
import { SYSTEM_PREVIEW_SUBJECT, sessionProvenance, provenanceRefusal } from "./provenance.js";
import { DEFAULT_SYSTEM_SIGNING, createTokenBucket } from "./rate-limit.js";

export class PolicyDenied extends Error {
  declare reason: string;
  // Seconds after which a retry may succeed (`rate-limited` only).
  declare retryAfter?: number;
  constructor(reason: string, { retryAfter }: { retryAfter?: number } = {}) {
    super(`policy denied: ${reason}`);
    this.reason = reason;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

// Protected execution is switched off (maintenance.js): not a judgement on the
// request, which may be retried once it is back on.
export class PolicyMaintenance extends PolicyDenied {
  constructor() {
    super(MAINTENANCE);
  }
}

const ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;
// An operation id is `<invocation>/<stage>/<occurrence>` (issueExecution).
export const opidParts = opid => {
  const parts = typeof opid === "string" ? opid.split("/") : [];
  return parts.length === 3 ? { invocationId: parts[0], stage: parts[1] } : {};
};
const DIGEST_RE = /^[a-f0-9]{64}$/;
const isId = v => typeof v === "string" && ID_RE.test(v);
const isTaskId = v => typeof v === "string" && v.length > 0 && v.length <= 4096;
const isLang = v => typeof v === "string" && /^\d{4}$/.test(v);
// Every view of one publication shares one invocation, keyed by this input.
const VIEW_INPUT = createHash("sha256").update("publication-view").digest("hex");
export { SYSTEM_PREVIEW_SUBJECT };

// After a command occurrence's last execution token expires, how long Broker
// may still be finishing a claim it made in time (B5 §7): only past this can
// an unclaimed occurrence be recorded as never written.
export const COMMAND_SETTLE_GRACE_MS = 120_000;
// Expansion bounds an intent may declare (B5 §4).
export const MAX_INTENT_OCCURRENCES = 10_000;

// A stage model's declared effect intents (B5 §4), checked against the
// registry, the stage's admitted functions and the connection's backend.
// Returns { intents } or { refusal }.
export const modelIntents = ({ modelText, lang, requiredFunctions, backend }) => {
  let model;
  try {
    model = JSON.parse(modelText);
  } catch {
    return { refusal: "bad-request" };
  }
  const declared = model?.intents ?? [];
  if (!Array.isArray(declared)) return { refusal: "bad-request" };
  const ids = new Set();
  const intents = [];
  for (const i of declared) {
    if (!i || typeof i.id !== "string" || !/^[A-Za-z0-9_:.-]{1,128}$/.test(i.id) || ids.has(i.id)) return { refusal: "bad-request" };
    ids.add(i.id);
    const spec = protectedFunctionsForLang(lang)?.[i.fn];
    if (!spec || !requiredFunctions.includes(i.fn) || typeof i.op !== "string" || !isOperationAllowed({ lang, fn: i.fn, op: i.op, backend })) {
      return { refusal: "intent-not-registered" };
    }
    const runtime = i.runtime === true;
    const occurrences = runtime ? [] : i.occurrences;
    if (!runtime && (!Array.isArray(occurrences) || !occurrences.length || !occurrences.every(o => typeof o === "string" && /^[A-Za-z0-9_:.-]{1,200}$/.test(o) && !o.startsWith(RUNTIME_PREFIX)))) {
      return { refusal: "bad-request" };
    }
    const max = runtime ? i.bounds?.maxOccurrences : occurrences.length;
    if (!Number.isInteger(max) || max < 1 || max > MAX_INTENT_OCCURRENCES) return { refusal: "bad-request" };
    if (i.scope !== undefined && typeof i.scope !== "string") return { refusal: "bad-request" };
    intents.push({ id: i.id, fn: i.fn, op: i.op, runtime, ...(runtime ? {} : { occurrences: [...occurrences] }), bounds: { maxOccurrences: max }, ...(i.scope !== undefined ? { scope: i.scope } : {}) });
  }
  return { intents };
};

// How old an admission's consistent read may be when its plan is written.
export const ADMISSION_MAX_AGE_MS = 5000;

export const createPolicy = ({
  signer, jwks, connections, invocations, publications, grants = null, systemConnections = {}, protectedSwitch, audit,
  // Command records (B5), when configured: the store (allocation, leases),
  // the records (everything after), and Broker's receipt read for settlement.
  commands = null, commandRecords = null, brokerReceipts = null,
  // Reconciliation (WRITE-02, W5): Broker's admin call, when configured.
  brokerReconcile = null,
  // Contract v2 (W4): the approved-revisions reader and the lease fence, and
  // the lowest contract version accepted (1 until the cutover).
  approvals = null, fence = null, minContractVersion = 1, admissionMaxAgeMs = ADMISSION_MAX_AGE_MS, now = () => Date.now(),
  // The per-instance bucket on system preview mints (config.js
  // parseSystemSigningLimits), on the same clock.
  systemSigning = DEFAULT_SYSTEM_SIGNING,
  // The registry this instance runs under, and the earlier versions it still
  // accepts during a bump's rollout (P1b). Injectable for tests.
  registryVersion = REGISTRY_VERSION, registryWindow = REGISTRY_WINDOW,
}) => {
  const acceptedRegistry = v => isAcceptedRegistryVersion(v, { current: registryVersion, window: registryWindow });
  // No default: a policy built without the switch would run ungated.
  if (!protectedSwitch || typeof protectedSwitch.state !== "function") throw new Error("createPolicy needs a protectedSwitch");
  const systemSignings = createTokenBucket({ perMinute: systemSigning?.perMinute, burst: systemSigning?.burst, now });
  const deny = async (reason, record, { retryAfter }: { retryAfter?: number } = {}) => {
    await audit({ ...record, outcome: "denied", reason });
    throw new PolicyDenied(reason, { retryAfter });
  };
  // Every protected entry point asks first, before reading or issuing
  // anything. `principal` is verified identity only (the authenticated user,
  // or a verified token's claims): while paused, it admits the canary.
  // `fresh` reads the flag past the switch's short cache: authorize-execution
  // decides an effect that is about to happen, so it never reuses a read.
  const requireProtectedExecution = async (record, principal = {}, { fresh = false } = {}) => {
    const admitted = admission(await protectedSwitch.state({ fresh }), principal);
    if (admitted === "enabled") return;
    if (admitted === "canary") {
      await audit({ ...record, outcome: "allowed", reason: "canary-during-maintenance" });
      return;
    }
    await audit({ ...record, outcome: "denied", reason: MAINTENANCE });
    throw new PolicyMaintenance();
  };

  // Who may use a connection, read live: its owner, or a recipient with an
  // unexpired grant from that owner. `ownerUid` pins the owner a session or
  // publication was issued under, so a changed owner stops it.
  // A configured system connection serves only system preview sessions: no
  // user, publication or grant reaches it, its owner included, so it can never
  // write, sign Author or back a publication.
  const isSystemConnection = connectionId => Object.values(systemConnections).includes(connectionId);
  const accessFor = async (connection, uid, { ownerUid, readTime }: { ownerUid?: string, readTime?: unknown } = {}) => {
    if (!connection) return { refusal: "connection-not-found" };
    if (isSystemConnection(connection.connectionId)) return { refusal: "system-connection" };
    if (connection.status !== "active") return { refusal: "connection-disabled" };
    if (ownerUid !== undefined && connection.ownerUid !== ownerUid) return { refusal: "owner-changed" };
    if (connection.ownerUid === uid) return { owner: true, permissions: connection.ownerPermissions ?? null };
    const grant = grants && uid
      ? await grants.get(grantIdFor({ connectionId: connection.connectionId, recipientUid: uid }), readTime ? { readTime } : undefined)
      : null;
    if (!grant || isExpired(grant) || grant.ownerUid !== connection.ownerUid) return { refusal: "not-owner" };
    return { grant };
  };
  // A grant reaches the (language, function) pairs it names that the registry
  // marks delegable, plus that language's implicit delegable functions (signing
  // every render), which also may be named on their own. The owner reaches
  // every registered function, or, once they have narrowed their own use, the
  // ones their list names by the same rule, delegable or not. A list without
  // permissions reaches nothing.
  const mayUse = (access, lang, fn) => {
    const spec = protectedFunctionsForLang(lang)?.[fn];
    if (!spec) return false;
    if (access.owner && access.permissions === null) return true;
    const key = String(lang ?? "").replace(/^L/i, "").padStart(4, "0");
    const list = access.owner ? access.permissions : access.grant?.permissions;
    const inLang = (list ?? []).filter(p => p.lang === key);
    const permitted = inLang.some(p => p.fn === fn) || (spec.implicit === true && inLang.length > 0);
    return permitted && (access.owner || spec.delegable === true);
  };

  const allocateInvocation = async ({ caller, user, connectionId, taskId, inputDigest, idempotencyKey = null, admission = false }) => {
    // callerRole is the verified caller's (the app's identifyCaller).
    const record = { event: "invocation", uid: user?.uid, connectionId, callerRole: caller?.role };
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (!user?.uid) return deny("no-user", record);
    if (!isId(connectionId) || !isTaskId(taskId) || typeof inputDigest !== "string" || !DIGEST_RE.test(inputDigest)) {
      return deny("bad-request", record);
    }
    if (idempotencyKey !== null && !isId(idempotencyKey)) return deny("bad-request", record);
    if (typeof admission !== "boolean") return deny("bad-request", record);
    const connection = await connections.get(connectionId);
    const access = await accessFor(connection, user.uid);
    if (access.refusal) return deny(access.refusal, { ...record, ownerUid: connection?.ownerUid });
    let allocated;
    try {
      // From the cutover every new invocation requires a plan to execute
      // source. Stored-artifact reads can only use view-safe functions.
      allocated = await invocations.allocate({ uid: user.uid, connectionId, taskId, inputDigest, idempotencyKey, admission: admission || minContractVersion >= 2 });
    } catch (e) {
      if (e instanceof InvocationConflict) return deny("idempotency-key-reused", record);
      // D2a: a key a command holds is served from its command record, never
      // by a legacy compile.
      if (e instanceof ProtocolMismatch) return deny("command-protocol", record);
      throw e;
    }
    const { invocationId, seq, reused } = allocated;
    // The invocation's own marker (a retry can't change it): 2 means source
    // execution requires an admitted plan.
    const contract = allocated.contract ?? 1;
    const invocationToken = await issueToken(signer, "invocation", { sub: user.uid, conn: connectionId, inv: invocationId, seq, cv: contract });
    await audit({ ...record, ownerUid: connection.ownerUid, invocationId, outcome: "allowed", reason: reused ? "reused" : "new" });
    // The owner and sequence go back to the gateway, which binds the private
    // result of this invocation to them.
    return { invocationToken, invocationId, seq, reused, ownerUid: connection.ownerUid, contract, planDigest: allocated.planDigest ?? null, minContractVersion, protocol: allocated.protocol ?? "legacy" };
  };

  // Commands (B5, docs/b5-commands-plan.md §3). Allocation is the only call
  // that takes the user's token: it checks the user may use the connection
  // now, and allocates the command, its key and its invocation at once. A key
  // the legacy path allocated first stays legacy (D2a), and is answered with
  // its protocol so the gateway serves it there.
  const allocateCommand = async ({ caller, user, connectionId, taskId, inputDigest, idempotencyKey, lang, request, worker }) => {
    const record = { event: "command", uid: user?.uid, connectionId, callerRole: caller?.role };
    if (!commands) return deny("unavailable", record);
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (!user?.uid) return deny("no-user", record);
    if (!isId(connectionId) || !isTaskId(taskId) || typeof inputDigest !== "string" || !DIGEST_RE.test(inputDigest) ||
      !isId(idempotencyKey) || !isLang(lang) || typeof worker !== "string" || !WORKER_RE.test(worker)) {
      return deny("bad-request", record);
    }
    const problem = requestProblem(request);
    if (problem) return deny(problem, record);
    const connection = await connections.get(connectionId);
    const access = await accessFor(connection, user.uid);
    if (access.refusal) return deny(access.refusal, { ...record, ownerUid: connection?.ownerUid });
    let allocated;
    try {
      allocated = await commands.allocate({ uid: user.uid, connectionId, taskId, inputDigest, idempotencyKey, lang, request, worker, now: now() });
    } catch (e) {
      if (e instanceof InvocationConflict) return deny("idempotency-key-reused", record);
      throw e;
    }
    if (allocated.protocol === "legacy") {
      await audit({ ...record, invocationId: allocated.invocationId, outcome: "allowed", reason: "legacy-key" });
      return { protocol: "legacy", invocationId: allocated.invocationId, seq: allocated.seq };
    }
    const { command, reused } = allocated;
    await audit({ ...record, commandId: command.commandId, invocationId: command.invocationId, outcome: "allowed", reason: reused ? "reused" : "new" });
    // A new command is owned by the worker that allocated it, at generation 1.
    return { ...commandSummary(command), reused, owned: !reused, ownerUid: connection.ownerUid };
  };

  // The lease, renewed by its owner or taken over once expired. Service only:
  // no user token, so recovery never depends on one (decision 3).
  const leaseCommand = async ({ caller, commandId, worker, generation, takeOver = false }) => {
    const record = { event: "command-lease", callerRole: caller?.role };
    if (!commands) return deny("unavailable", record);
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (typeof commandId !== "string" || !COMMAND_ID_RE.test(commandId) || typeof worker !== "string" || !WORKER_RE.test(worker) ||
      !Number.isInteger(generation) || generation < 1 || typeof takeOver !== "boolean") {
      return deny("bad-request", record);
    }
    try {
      const command = takeOver
        ? await commands.takeOver({ commandId, worker, expectedGeneration: generation, now: now() })
        : await commands.renewLease({ commandId, worker, generation, now: now() });
      if (takeOver) await audit({ ...record, commandId, invocationId: command.invocationId, outcome: "allowed", reason: "takeover" });
      return commandSummary(command);
    } catch (e) {
      // A refused owner request changes nothing; it is not audited as a decision.
      if (e instanceof CommandRefused) throw new PolicyDenied(e.reason);
      throw e;
    }
  };

  // Owner writes and bookkeeping on a command (B5 slice 2). Service only: the
  // gateway's identity, the command id and the generation, never a user
  // token. Each is fenced in the records (a live lease and exactly the
  // current generation); a refusal changes nothing. `fn` names the records'
  // operation; `args` are its arguments beside commandId and generation.
  const COMMAND_WRITES = new Set(["installModel", "installInput", "observation", "bindOccurrence", "closeStage", "markNotReached", "recordLost", "finish", "published"]);
  const commandWrite = async ({ caller, commandId, generation, fn, args = {} }) => {
    const record = { event: "command-write", callerRole: caller?.role };
    if (!commands || !commandRecords) return deny("unavailable", record);
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (!COMMAND_WRITES.has(fn) || typeof commandId !== "string" || !COMMAND_ID_RE.test(commandId) || !Number.isInteger(generation) || generation < 1) {
      return deny("bad-request", record);
    }
    try {
      const out = await commandRecords[fn]({ ...args, commandId, generation });
      if (fn === "finish") {
        await audit({ ...record, commandId, invocationId: out.invocationId, outcome: "allowed", reason: out.status });
        return commandSummary(out);
      }
      if (fn === "published") return commandSummary(out);
      return out;
    } catch (e) {
      if (e instanceof CommandRefused) throw new PolicyDenied(e.reason);
      throw e;
    }
  };

  // Settlement (§7): outcomes recorded from Broker's receipts for the
  // command's invocation. Bookkeeping: no live permission, no token minted,
  // so a revoked connection never stops the record of what already ran.
  const settleCommand = async ({ caller, commandId, generation }) => {
    const record = { event: "command-settle", callerRole: caller?.role };
    if (!commands || !commandRecords || !brokerReceipts) return deny("unavailable", record);
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (typeof commandId !== "string" || !COMMAND_ID_RE.test(commandId) || !Number.isInteger(generation) || generation < 1) return deny("bad-request", record);
    const command = await commands.get(commandId);
    if (!command) return deny("command-not-found", record);
    let read;
    try {
      read = await brokerReceipts({ invocationId: command.invocationId });
    } catch {
      return deny("unavailable", { ...record, commandId });
    }
    try {
      const { recorded } = await commandRecords.recordFromReceipts({ commandId, generation, operations: read.operations ?? [] });
      return { recorded: recorded.length, operations: recorded.map(o => ({ stage: o.stage, occurrenceId: o.occurrenceId, outcome: o.outcome, final: o.final })) };
    } catch (e) {
      if (e instanceof CommandRefused) throw new PolicyDenied(e.reason);
      throw e;
    }
  };

  // What recovery reads to continue a command (service only).
  const COMMAND_READS = { state: "state", request: "request", models: "models", input: "input", result: "result", occurrences: "occurrences", outcomes: "outcomes" };
  const commandRead = async ({ caller, commandId, what, stage = null }) => {
    const record = { event: "command-read", callerRole: caller?.role };
    if (!commands || !commandRecords) return deny("unavailable", record);
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (typeof commandId !== "string" || !COMMAND_ID_RE.test(commandId) || !COMMAND_READS[what]) return deny("bad-request", record);
    const command = await commands.get(commandId);
    if (!command) return deny("command-not-found", record);
    // What the worker continues from: the record's phase, admission, stages,
    // status, result and publication, and the connection's owner, whom the
    // artifact is bound to. Never the request or any payload.
    if (what === "state") {
      const connection = await connections.get(command.connectionId);
      const { commandId: id, uid, invocationId, seq, lang, taskId, connectionId, phase, admission, stages, status, result, publication, counts } = command;
      return { commandId: id, uid, invocationId, seq, lang, taskId, connectionId, phase, admission, stages, status, result, publication, counts, generation: command.owner.generation, leaseExpiresAt: command.owner.leaseExpiresAt, ownerUid: connection?.ownerUid ?? null };
    }
    if (what === "request") return { text: await commands.getRequest(commandId) };
    if (what === "models") return { models: await commandRecords.getModels(commandId) };
    if (what === "input") {
      if (typeof stage !== "string" || !/^s\d{1,3}$/.test(stage)) return deny("bad-request", record);
      return { input: await commandRecords.getInput(commandId, stage) };
    }
    if (what === "result") return { result: await commandRecords.getResult(commandId) };
    if (what === "occurrences") return { occurrences: await commandRecords.listOccurrences(commandId) };
    return { outcomes: await commandRecords.listOutcomes(commandId) };
  };

  // Extension point (Track E2): a fenced transition with an optional
  // scheduling intent. B5 carries no intent.
  const transitionCommand = async ({ caller, commandId, generation, intent = null }) => {
    const record = { event: "command-write", callerRole: caller?.role };
    if (!commands) return deny("unavailable", record);
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (intent !== null) return deny("not-supported", record);
    if (typeof commandId !== "string" || !COMMAND_ID_RE.test(commandId) || !Number.isInteger(generation)) return deny("bad-request", record);
    const command = await commands.get(commandId);
    const refusal = ownerRefusal(command, { generation, now: now() });
    if (refusal) throw new PolicyDenied(refusal);
    return commandSummary(command);
  };

  // A command's first admission (B5 §6 step 2), service-authorized under the
  // command's stored principal. The models it binds are the ones installed
  // on the command, never the caller's; their intents come from the models.
  // The plan is written as for any chain (admitChain), then recorded on the
  // command once. A retry of the same admission is acknowledged.
  const admitCommand = async ({ caller, commandId, generation, taskIds, stages }) => {
    const record = { event: "command-admission", callerRole: caller?.role, registryVersion, commandId };
    if (!commands || !commandRecords) return deny("unavailable", record);
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (typeof commandId !== "string" || !COMMAND_ID_RE.test(commandId) || !Number.isInteger(generation)) return deny("bad-request", record);
    const command = await commands.get(commandId);
    const fenced = ownerRefusal(command, { generation, now: now() });
    if (fenced) throw new PolicyDenied(fenced);
    Object.assign(record, { uid: command.uid });
    const invocation = await invocations.get(command.invocationId);
    if (!invocation) return deny("invocation-incompatible", record);
    if (!Array.isArray(stages)) return deny("bad-request", record);
    const models = new Map<string, { text: string, digest: string }>((await commandRecords.getModels(commandId)).map(m => [m.stage, m]));
    if (stages.some((m, i) => !models.has(`s${i}`))) return deny("models-missing", record);
    const admitted = await admitChain({ record, uid: command.uid, invocation, taskIds, stages });
    type AdmittedStage = { lang: string, modelDigest: string, revision: string, tagUrl: string, intents: unknown[] };
    const admission: { planDigest: string, stages: Record<string, AdmittedStage> } = { planDigest: admitted.planDigest, stages: {} };
    for (const [i, pinned] of admitted.plan.stages.entries()) {
      const model = models.get(`s${i}`);
      const declared = modelIntents({ modelText: model.text, lang: pinned.lang, requiredFunctions: pinned.requiredFunctions, backend: admitted.backend });
      if (declared.refusal) return deny(declared.refusal, record);
      admission.stages[pinned.stage] = { lang: pinned.lang, modelDigest: model.digest, revision: pinned.revision, tagUrl: admitted.stages[i].tagUrl, intents: declared.intents };
    }
    try {
      await commandRecords.admit({ commandId, generation, admission });
    } catch (e) {
      if (e instanceof CommandRefused) throw new PolicyDenied(e.reason);
      throw e;
    }
    await audit({ ...record, ownerUid: admitted.ownerUid, planDigest: admitted.planDigest, outcome: "allowed", reason: admitted.created ? "new" : "reused" });
    return { planDigest: admitted.planDigest, stages: Object.entries(admission.stages).map(([stage, a]) => ({ stage, lang: a.lang, revision: a.revision, tagUrl: a.tagUrl, modelDigest: a.modelDigest })) };
  };

  // A command stage's session (B5 §6 step 3), service-authorized for the
  // current owner. A dispatch action: live permission is checked now. The
  // session names the command and the owner's generation, which mint and
  // authorize-execution check on every token it yields.
  const commandSession = async ({ caller, commandId, generation, stage }) => {
    const record = { event: "command-session", callerRole: caller?.role, commandId, stage };
    if (!commands || !commandRecords) return deny("unavailable", record);
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (typeof commandId !== "string" || !COMMAND_ID_RE.test(commandId) || !Number.isInteger(generation) || typeof stage !== "string" || !/^s\d{1,3}$/.test(stage)) {
      return deny("bad-request", record);
    }
    const command = await commands.get(commandId);
    const fenced = ownerRefusal(command, { generation, now: now() });
    if (fenced) throw new PolicyDenied(fenced);
    Object.assign(record, { uid: command.uid, connectionId: command.connectionId, invocationId: command.invocationId });
    await requireProtectedExecution(record, { uid: command.uid, connectionId: command.connectionId });
    if (command.phase !== "admitted") return deny("not-admitted", record);
    const plan = await invocations.getPlan(command.admission.planDigest);
    const pinned = plan?.stages?.find(st => st.stage === stage);
    if (!pinned || !command.admission.stages[stage]) return deny("plan-binding-mismatch", record);
    if (!acceptedRegistry(plan.registryVersion)) return deny("registry-version-changed", record);
    if (!(await revisionAvailable(pinned.lang, pinned.revision))) return deny("pinned-revision-unavailable", record);
    const connection = await connections.get(command.connectionId);
    const access = await accessFor(connection, command.uid);
    if (access.refusal) return deny(access.refusal, { ...record, ownerUid: connection?.ownerUid });
    const registered = protectedFunctionsForLang(pinned.lang) || {};
    const allowed = pinned.requiredFunctions.filter(fn => registered[fn]?.backend === connection.backend && mayUse(access, pinned.lang, fn));
    const sessionToken = await issueToken(signer, "session", {
      sub: command.uid,
      own: connection.ownerUid,
      conn: command.connectionId,
      backend: connection.backend,
      lang: pinned.lang,
      inv: command.invocationId,
      stg: stage,
      rv: plan.registryVersion,
      fns: allowed,
      cv: CONTRACT_VERSION,
      pld: command.admission.planDigest,
      bind: stageBinding(pinned),
      cmd: commandId,
      fg: generation,
    });
    await audit({ ...record, lang: pinned.lang, ownerUid: connection.ownerUid, planDigest: command.admission.planDigest, outcome: "allowed" });
    return { allowed, sessionToken, lang: pinned.lang, tagUrl: command.admission.stages[stage].tagUrl };
  };

  // A command's operation, checked at mint and at every step (B5 §4, §7): the
  // claims name this command, its invocation, principal and an admitted
  // stage, at the owner's current generation with a live lease; the
  // occurrence is bound, its arguments are the bound ones, and it is an
  // admitted intent's, for that intent's function, operation and scope.
  // Returns { refusal, definite? } or { command, occurrence }.
  const commandOperation = async ({ claims, stage, occurrenceId, fn, op, argsDigest }) => {
    if (!commands || !commandRecords) return { refusal: "unavailable" };
    const command = typeof claims.cmd === "string" && COMMAND_ID_RE.test(claims.cmd) ? await commands.get(claims.cmd) : null;
    if (!command || command.invocationId !== claims.inv || command.uid !== claims.sub || command.connectionId !== claims.conn) return { refusal: "plan-binding-mismatch" };
    const fenced = ownerRefusal(command, { generation: claims.fg, now: now() });
    if (fenced) return { refusal: fenced };
    const admitted = command.admission?.stages?.[stage];
    if (command.phase !== "admitted" || !admitted || command.admission.planDigest !== claims.pld) return { refusal: "plan-binding-mismatch" };
    const occurrence = await commandRecords.getOccurrence(command.commandId, stage, occurrenceId);
    if (!occurrence) return { refusal: "occurrence-not-bound", command };
    const intent = admitted.intents.find(i => i.id === occurrence.intentId);
    const runtime = occurrenceId.startsWith(RUNTIME_PREFIX);
    const encoded = runtime ? occurrenceId === runtimeOccurrenceId(occurrence.intentId, occurrence.expansionKey) : (intent?.occurrences ?? []).includes(occurrenceId);
    if (!intent || !encoded) return { refusal: "occurrence-mismatch", definite: true, command, occurrence };
    if (intent.fn !== fn || intent.op !== op || (intent.scope !== undefined && intent.scope !== claims.conn)) return { refusal: "intent-mismatch", definite: true, command, occurrence };
    if (occurrence.argd !== argsDigest) return { refusal: "args-mismatch", definite: true, command, occurrence };
    return { command, occurrence };
  };

  // A definite refusal of a command's occurrence, from its current owner, is
  // recorded `failed` only when no attempt wrote or can still write (B5 §7):
  // a receipt decides if there is one; otherwise every token ever issued for
  // it must be past use. Anything unsure records nothing: the sweeper comes
  // back. Never throws: the refusal itself is what the caller gets.
  const settleRefusal = async ({ command, generation, stage, occurrenceId, occurrence, reason }) => {
    if (!brokerReceipts || !occurrence) return;
    const opid = `${command.invocationId}/${stage}/${occurrenceId}`;
    try {
      const read = await brokerReceipts({ invocationId: command.invocationId, operationIds: [opid] });
      if ((read.operations ?? []).length) {
        await commandRecords.recordFromReceipts({ commandId: command.commandId, generation, operations: read.operations });
        return;
      }
      // Read the time after the receipts: a claim made since then needed a
      // token that is still usable now, and that keeps this from recording.
      const usable = (occurrence.minted ?? []).some(m => m.exp * 1000 + COMMAND_SETTLE_GRACE_MS > now());
      if (usable) return;
      await commandRecords.recordRefusal({ commandId: command.commandId, generation, stage, occurrenceId, reason });
    } catch {
      // Unsure (Broker unreachable, or the owner changed): record nothing.
    }
  };

  // A command stage's compiler binds its occurrences and records its
  // observations (B5 §4, §5) under the stage's session: the session names the
  // command, the owner's generation and the stage, and the records fence the
  // write to that owner. Only the stage's own language may.
  const commandSessionClaims = async ({ caller, sessionToken, record }) => {
    let session;
    try {
      ({ claims: session } = await verifyToken(jwks, "session", sessionToken));
    } catch {
      return { refusal: await deny("bad-session", record) };
    }
    Object.assign(record, { uid: session.sub, lang: session.lang, invocationId: session.inv, stage: session.stg, connectionId: session.conn });
    if (caller?.role !== "compiler" || !caller.lang || caller.lang !== session.lang) return { refusal: await deny("caller-language-mismatch", record) };
    if (session.cmd === undefined || !Number.isInteger(session.fg)) return { refusal: await deny("command-claims-required", record) };
    if (!commands || !commandRecords) return { refusal: await deny("unavailable", record) };
    return { session };
  };
  const commandBind = async ({ caller, sessionToken, occurrenceId, intentId, expansionKey = null, args, argd, observations = [] }) => {
    const record = { event: "command-bind", callerRole: caller?.role };
    const { session } = await commandSessionClaims({ caller, sessionToken, record });
    try {
      return await commandRecords.bindOccurrence({ commandId: session.cmd, generation: session.fg, stage: session.stg, occurrenceId, intentId, expansionKey, args, argd, observations });
    } catch (e) {
      if (e instanceof CommandRefused) throw new PolicyDenied(e.reason);
      throw e;
    }
  };
  const commandObserve = async ({ caller, sessionToken, key, text = undefined }) => {
    const record = { event: "command-observe", callerRole: caller?.role };
    const { session } = await commandSessionClaims({ caller, sessionToken, record });
    try {
      return await commandRecords.observation({ commandId: session.cmd, generation: session.fg, stage: session.stg, key, text });
    } catch (e) {
      if (e instanceof CommandRefused) throw new PolicyDenied(e.reason);
      throw e;
    }
  };

  // Is this invocation a command's (D2a)? Then its tokens must say so.
  const isCommandInvocation = async invocationId => isId(invocationId) && (await invocations.get(invocationId))?.protocol === "command";

  // A command's summary: for the gateway itself, or for the signed-in user
  // whose command it is.
  const getCommand = async ({ caller, user = null, commandId }) => {
    const record = { event: "command-read", uid: user?.uid, callerRole: caller?.role };
    if (!commands) return deny("unavailable", record);
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (typeof commandId !== "string" || !COMMAND_ID_RE.test(commandId)) return deny("bad-request", record);
    const command = await commands.get(commandId);
    if (!command) return deny("command-not-found", record);
    if (user && user.uid !== command.uid) return deny("command-not-found", record);
    return commandSummary(command);
  };

  // The invocation comes only from a policy-issued invocation token for this
  // connection, never from the compiler's own say-so.
  const invocationClaims = async ({ invocationToken, connectionId }) => {
    try {
      const { claims } = await verifyToken(jwks, "invocation", invocationToken);
      return claims.conn === connectionId && isId(claims.inv) && typeof claims.sub === "string" ? claims : null;
    } catch {
      return null;
    }
  };

  // Live state of a publication, checked at publishing, at every view and at
  // every mint. Owner-only: the publisher must own the connection, and it must
  // be active. Returns { refusal } or { publication, connection }.
  const publicationState = async (publicationId, { publisherUid, connectionId, lang }: { publisherUid?: string, connectionId?: string, lang?: string } = {}) => {
    const publication = isId(publicationId) ? await publications.get(publicationId) : null;
    if (!publication) return { refusal: "publication-not-found" };
    if ((publisherUid !== undefined && publication.publisherUid !== publisherUid) ||
        (connectionId !== undefined && publication.connectionId !== connectionId) ||
        (lang !== undefined && publication.lang !== lang)) {
      return { refusal: "publication-mismatch" };
    }
    const connection = await connections.get(publication.connectionId);
    const access = await accessFor(connection, publication.publisherUid, { ownerUid: publication.ownerUid });
    if (access.refusal) return { refusal: access.refusal };
    // Only the owner publishes; a grant never includes publishing.
    if (access.grant) return { refusal: "publish-not-granted" };
    return { publication, connection, access };
  };

  // Publishing: the gateway has checked that the artifact is this user's
  // current result for the task and connection; policy checks the authority.
  const createPublication = async ({ caller, user, connectionId, taskId, lang, artifactInvocationId }) => {
    const record = { event: "publication-create", uid: user?.uid, connectionId, lang, callerRole: caller?.role };
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (!user?.uid) return deny("no-user", record);
    if (!isId(connectionId) || !isTaskId(taskId) || !isLang(lang) || !isId(artifactInvocationId)) {
      return deny("bad-request", record);
    }
    const connection = await connections.get(connectionId);
    const access = await accessFor(connection, user.uid);
    if (access.refusal) return deny(access.refusal, { ...record, ownerUid: connection?.ownerUid });
    // Published views spend the owner's credential on viewers the owner never
    // named, so a recipient needs a grant that says so.
    if (access.grant) return deny("publish-not-granted", { ...record, ownerUid: connection.ownerUid });
    const publication = await publications.create({
      publicationId: newPublicationId(),
      publisherUid: user.uid,
      ownerUid: connection.ownerUid,
      connectionId,
      lang,
      taskId,
      artifactInvocationId,
      createdAt: new Date().toISOString(),
    });
    await audit({ ...record, ownerUid: connection.ownerUid, publicationId: publication.publicationId, outcome: "allowed" });
    return { publicationId: publication.publicationId };
  };

  const deletePublication = async ({ caller, user, publicationId }) => {
    const record = { event: "publication-delete", uid: user?.uid, callerRole: caller?.role };
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (!user?.uid) return deny("no-user", record);
    const publication = isId(publicationId) ? await publications.get(publicationId) : null;
    if (!publication) return deny("publication-not-found", record);
    if (publication.publisherUid !== user.uid) return deny("not-publisher", record);
    await publications.delete(publicationId);
    await audit({ ...record, connectionId: publication.connectionId, publicationId: publication.publicationId, outcome: "allowed" });
    return { publicationId, deleted: true };
  };

  // A view of a published item: no user. Policy re-checks the publication
  // live and issues an invocation token bound to the publisher and marked with
  // the publication, which confines its session to viewSafe functions.
  const authorizeView = async ({ caller, publicationId }) => {
    const record = { event: "publication-view", callerRole: caller?.role };
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    const state = await publicationState(publicationId);
    if (state.refusal) return deny(state.refusal, record);
    const { publication } = state;
    const { invocationId, seq } = await invocations.allocate({
      uid: publication.publisherUid,
      connectionId: publication.connectionId,
      taskId: publication.taskId,
      inputDigest: VIEW_INPUT,
      idempotencyKey: `view.${publication.publicationId}`,
    });
    const invocationToken = await issueToken(signer, "invocation", {
      sub: publication.publisherUid,
      conn: publication.connectionId,
      inv: invocationId,
      seq,
      pub: publication.publicationId,
    });
    await audit({ ...record, uid: publication.publisherUid, connectionId: publication.connectionId, publicationId: publication.publicationId, outcome: "allowed" });
    const { publisherUid, connectionId, lang, taskId, artifactInvocationId } = publication;
    return { invocationToken, publisherUid, connectionId, lang, taskId, artifactInvocationId };
  };

  // A publication session: the publisher's authority, confined to viewSafe
  // functions.
  const publicationSnapshot = async ({ record, claims, lang, connectionId, fns, stage }) => {
    const state = await publicationState(claims.pub, { publisherUid: claims.sub, connectionId, lang });
    if (state.refusal) return deny(state.refusal, record);
    const { connection, access } = state;
    const registered = protectedFunctionsForLang(lang) || {};
    const viewSafe = new Set(viewSafeFunctionsForLang(lang));
    const allowed = [...new Set<string>(fns)].filter(fn =>
      viewSafe.has(fn) && registered[fn].backend === connection.backend && mayUse(access, lang, fn));
    const sessionToken = await issueToken(signer, "session", {
      sub: claims.sub,
      own: connection.ownerUid,
      conn: connectionId,
      backend: connection.backend,
      lang,
      inv: claims.inv,
      stg: stage,
      pub: claims.pub,
      rv: registryVersion,
      fns: allowed,
      // A publication's v2 binding is the publication itself (`pub`).
      cv: CONTRACT_VERSION,
    });
    await audit({ ...record, uid: claims.sub, ownerUid: connection.ownerUid, outcome: "allowed", reason: "publication" });
    return { allowed, sessionToken };
  };

  // Why an unbound user-provenance proof can't run (W4), or null: a marked
  // invocation runs only under its plan, whatever the minimum (plan-required);
  // from minimum 2, an unmarked one, started before the cutover, can't be
  // resumed at all (invocation-incompatible: a new run is needed).
  const planRefusal = async invocationId => {
    const invocation = isId(invocationId) ? await invocations.get?.(invocationId) : null;
    if (invocation?.contract === 2) return "plan-required";
    return minContractVersion >= 2 ? "invocation-incompatible" : null;
  };
  // Is the pinned revision still runnable? Read live: retirement blocks it
  // from `retiring` on.
  const revisionAvailable = async (lang, revision) => {
    if (!approvals) return false;
    const record = await approvals.current(lang, revision);
    return record?.status === "approved";
  };
  // A user-provenance session's plan binding: the admission token, the plan
  // it names, and the stage this compiler is executing, which must match what
  // the compiler reports about itself. Returns { refusal } or { plan, stage }.
  const planBinding = async ({ admissionToken, invocationId, uid, connectionId, lang, stage, manifest }) => {
    let claims;
    try {
      ({ claims } = await verifyToken(jwks, "admission", admissionToken));
    } catch {
      return { refusal: "bad-token" };
    }
    if (claims.cv !== CONTRACT_VERSION || claims.inv !== invocationId || claims.sub !== uid || claims.conn !== connectionId) {
      return { refusal: "plan-binding-mismatch" };
    }
    const plan = await invocations.getPlan(claims.pld);
    const pinned = plan?.stages?.find(s => s.stage === stage);
    if (!plan || plan.invocationId !== invocationId || !pinned || pinned.lang !== lang) return { refusal: "plan-binding-mismatch" };
    if (manifestProblems(manifest, stage).length || !sameStage(manifest, pinned)) return { refusal: "plan-binding-mismatch" };
    if (!(await revisionAvailable(lang, pinned.revision))) return { refusal: "pinned-revision-unavailable" };
    // A plan keeps the registry version it was admitted under (P1b). Once
    // that version leaves the window nothing new executes under it, but a
    // retry may still recover its writes' recorded outcomes: replay only.
    return { planDigest: claims.pld, stage: pinned, registryVersion: plan.registryVersion, replayOnly: !acceptedRegistry(plan.registryVersion) };
  };

  const snapshot = async ({ caller, user, lang, connectionId, fns, invocationToken, stage, admissionToken = null, manifest = null }) => {
    const record = { event: "snapshot", uid: user?.uid, lang, connectionId, registryVersion, callerRole: caller?.role };
    // The user is verified; the connection is checked against it below, as
    // for anyone.
    await requireProtectedExecution(record, { uid: user?.uid, connectionId });
    if (caller?.role !== "compiler" || !caller.lang || caller.lang !== lang) return deny("caller-language-mismatch", record);
    if (!isId(connectionId) || typeof invocationToken !== "string" || !isId(stage)) return deny("bad-request", record);
    if (!Array.isArray(fns) || !fns.every(f => typeof f === "string")) return deny("bad-request", record);
    const claims = await invocationClaims({ invocationToken, connectionId });
    if (!claims) return deny("bad-invocation", record);
    if (claims.pub) return publicationSnapshot({ record, claims, lang, connectionId, fns, stage });
    if (!user?.uid) return deny("no-user", record);
    if (claims.sub !== user.uid) return deny("bad-invocation", record);
    const invocationId = claims.inv;
    // From here the invocation is verified: its id and the compiler's stage.
    Object.assign(record, { invocationId, stage });

    // A read signs stored data only. Like a publication, its session is
    // confined to view-safe functions; it cannot authorize another save.
    const reading = stage === "read" && admissionToken === null;
    const viewSafe = reading ? new Set(viewSafeFunctionsForLang(lang)) : null;
    // Executing a program requires its admitted plan. An unmarked
    // invocation keeps the per-stage path (v1) until the cutover.
    let bound = null;
    if (admissionToken !== null) {
      if (typeof admissionToken !== "string") return deny("bad-request", record);
      bound = await planBinding({ admissionToken, invocationId, uid: user.uid, connectionId, lang, stage, manifest });
      if (bound.refusal) return deny(bound.refusal, record);
      Object.assign(record, { planDigest: bound.planDigest });
    } else if (!reading) {
      const refusal = await planRefusal(invocationId);
      if (refusal) return deny(refusal, record);
    }

    const connection = await connections.get(connectionId);
    const access = await accessFor(connection, user.uid);
    if (access.refusal) return deny(access.refusal, { ...record, ownerUid: connection?.ownerUid });

    // The owner holds every registered function of this language that runs
    // against this connection's backend (or those their own list names); a
    // recipient, the delegable ones their
    // grant names. A write runs whenever the program calls it; its identity is
    // the invocation's.
    const registered = protectedFunctionsForLang(lang) || {};
    // Under a plan a snapshot may only narrow it: never a function the plan
    // didn't admit for this stage.
    const admitted = bound ? new Set(bound.stage.requiredFunctions) : null;
    // A replay-only session (P1b) recovers recorded writes: only a write has
    // a receipt to return, so only writes are in it.
    const replayOnly = Boolean(bound?.replayOnly);
    const allowed = [...new Set(fns)].filter(fn => {
      const spec = Object.prototype.hasOwnProperty.call(registered, fn) ? registered[fn] : null;
      return Boolean(spec && spec.backend === connection.backend && mayUse(access, lang, fn) && (!admitted || admitted.has(fn)) && (!viewSafe || viewSafe.has(fn)) &&
        (!replayOnly || spec.kind === "write"));
    });

    const sessionToken = await issueToken(signer, "session", {
      sub: user.uid,
      own: connection.ownerUid,
      conn: connectionId,
      backend: connection.backend,
      lang,
      inv: invocationId,
      stg: stage,
      rv: bound ? bound.registryVersion : registryVersion,
      fns: allowed,
      ...(bound ? { cv: CONTRACT_VERSION, pld: bound.planDigest, bind: stageBinding(bound.stage) } : { cv: reading ? CONTRACT_VERSION : 1 }),
      ...(replayOnly ? { rpl: true } : {}),
    });
    await audit({ ...record, ownerUid: connection.ownerUid, outcome: "allowed", ...(replayOnly ? { reason: "replay-only" } : {}) });
    return { allowed, sessionToken };
  };

  // The one backend a language's system-preview functions run against, or
  // null when there are none (or, defensively, more than one).
  const systemPreviewBackend = lang => {
    const registered = protectedFunctionsForLang(lang) || {};
    const backends = new Set(systemPreviewFunctionsForLang(lang).map(fn => registered[fn].backend));
    return backends.size === 1 ? [...backends][0] : null;
  };
  const systemConnectionFor = backend =>
    backend && Object.prototype.hasOwnProperty.call(systemConnections, backend) ? systemConnections[backend] : null;
  // Live state of a system connection: still the one configured for its
  // backend, present, active, same backend, same owner.
  const systemConnectionRefusal = async ({ connectionId, backend, ownerUid }: { connectionId: string, backend: string, ownerUid?: string }) => {
    if (systemConnectionFor(backend) !== connectionId) return { refusal: "not-system-connection" };
    const connection = await connections.get(connectionId);
    if (!connection) return { refusal: "connection-not-found" };
    if (connection.status !== "active") return { refusal: "connection-disabled" };
    if (connection.backend !== backend) return { refusal: "backend-changed" };
    if (ownerUid !== undefined && connection.ownerUid !== ownerUid) return { refusal: "owner-changed" };
    return { connection };
  };

  // A compile with no user connection: the compiler asks for a session on
  // the system connection. No user, no invocation; the session carries only
  // the system-preview functions and is marked `sys`, which mint confines to
  // them.
  const previewSession = async ({ caller, lang }) => {
    const record = { event: "preview-session", lang, registryVersion, callerRole: caller?.role };
    await requireProtectedExecution(record);
    if (caller?.role !== "compiler" || !caller.lang || caller.lang !== lang) return deny("caller-language-mismatch", record);
    if (!isLang(lang)) return deny("bad-request", record);
    const fns = systemPreviewFunctionsForLang(lang);
    const backend = systemPreviewBackend(lang);
    if (fns.length === 0 || !backend) return deny("no-system-preview-functions", record);
    const connectionId = systemConnectionFor(backend);
    if (!connectionId) return deny("no-system-connection", record);
    const state = await systemConnectionRefusal({ connectionId, backend });
    if (state.refusal) return deny(state.refusal, { ...record, connectionId });
    const { connection } = state;
    // The system session's own id: there is no gateway invocation.
    const systemInvocation = `sys-${randomUUID()}`;
    const sessionToken = await issueToken(signer, "session", {
      sub: SYSTEM_PREVIEW_SUBJECT,
      own: connection.ownerUid,
      conn: connectionId,
      backend,
      lang,
      // No invocation: signing writes nothing, so the operation id only needs
      // to be unique to this session.
      inv: systemInvocation,
      stg: "preview",
      sys: true,
      rv: registryVersion,
      fns,
      // A system session's v2 binding is the system connection itself.
      cv: CONTRACT_VERSION,
    });
    await audit({ ...record, connectionId, ownerUid: connection.ownerUid, invocationId: systemInvocation, stage: "preview", outcome: "allowed", reason: "system-preview" });
    return { allowed: fns, sessionToken };
  };

  // Is `fn` still reachable, right now, by this authority? Re-reads live
  // state on every call (spec EXEC-02, REVOKE-01): the connection, its owner
  // and backend, the grant or the owner's own restrictions, the enablement
  // gate, and the publication or system connection the authority rests on.
  // `authority` is the authority's claims with its checked provenance
  // (provenance.js): { provenance, sub, own, conn, backend, lang, pub? }.
  // Returns a refusal reason, or null.
  // Mint calls it before issuing an execution token; W2's
  // authorize-execution will call it before each effect.
  const liveRefusal = async (authority, fn) => {
    // A system preview session has no user and no grant: it reaches only the
    // language's system-preview functions, through the connection still
    // configured as the system connection for its backend.
    if (authority.provenance === "system") {
      if (!systemPreviewFunctionsForLang(authority.lang).includes(fn)) return "not-system-preview";
      const state = await systemConnectionRefusal({ connectionId: authority.conn, backend: authority.backend, ownerUid: authority.own });
      return state.refusal ?? null;
    }
    // A publication re-checks the publication on every call, and can only
    // ever reach viewSafe functions. Then every user check below applies to
    // its publisher as well.
    if (authority.provenance === "publication") {
      if (!viewSafeFunctionsForLang(authority.lang).includes(fn)) return "not-view-safe";
      const state = await publicationState(authority.pub, { publisherUid: authority.sub, connectionId: authority.conn, lang: authority.lang });
      if (state.refusal) return state.refusal;
    }

    // A connection disabled, deleted or re-owned since the authority was
    // issued stops the next protected call.
    const connection = await connections.get(authority.conn);
    const access = await accessFor(connection, authority.sub, { ownerUid: authority.own });
    if (access.refusal) return access.refusal;
    if (connection.backend !== authority.backend) return "backend-changed";
    // A grant revoked or narrowed since the snapshot stops this call.
    if (!mayUse(access, authority.lang, fn)) return "not-granted";
    return null;
  };

  const mint = async ({ caller, sessionToken, fn, op, occurrenceId, argsDigest }) => {
    let session;
    try {
      ({ claims: session } = await verifyToken(jwks, "session", sessionToken));
    } catch {
      // Paused takes precedence over a bad token: say so first.
      await requireProtectedExecution({ event: "mint", fn, op });
      return deny("bad-session", { event: "mint", fn, op });
    }
    await requireProtectedExecution({ event: "mint", uid: session.sub, connectionId: session.conn, fn, op }, { uid: session.sub, connectionId: session.conn });
    const record = {
      event: "mint",
      uid: session.sub,
      ownerUid: session.own,
      lang: session.lang,
      connectionId: session.conn,
      fn,
      op,
      registryVersion: session.rv,
      // From the verified session.
      invocationId: session.inv,
      stage: session.stg,
      callerRole: caller?.role,
    };
    if (caller?.role !== "compiler" || !caller.lang || caller.lang !== session.lang) return deny("caller-language-mismatch", record);
    // A replay-only session (P1b) mints replay tokens for writes, whatever
    // its plan's version; anything else needs a version still accepted.
    const replayOnly = session.rpl === true;
    if (replayOnly) {
      if (protectedFunctionsForLang(session.lang)?.[fn]?.kind !== "write") return deny("replay-only", record);
    } else if (!acceptedRegistry(session.rv)) {
      return deny("registry-version-changed", record);
    }
    if (!Array.isArray(session.fns) || !session.fns.includes(fn)) return deny("fn-not-in-session", record);
    if (!isOperationAllowed({ lang: session.lang, fn, op, backend: session.backend })) {
      return deny("operation-not-allowed", record);
    }
    if (!isId(occurrenceId) || typeof argsDigest !== "string" || !DIGEST_RE.test(argsDigest)) {
      return deny("bad-request", record);
    }
    // Which authority the session rests on; the token carries it (`prv`).
    const checked = sessionProvenance(session);
    if (checked.refusal) return deny(checked.refusal, record);
    const { provenance } = checked;
    const live = { ...record, provenance };
    const contractRefusal = await contractRefusalFor({ claims: session, provenance, fn, invocationId: session.inv, stage: session.stg, lang: session.lang });
    if (contractRefusal) return deny(contractRefusal, { ...live, planDigest: session.pld });
    // Every system-session mint takes a token, before the live reads it would
    // cost, so repeated sessions or `init`s can't multiply signatures past
    // it. Connection and publication mints are never limited.
    if (provenance === "system") {
      const taken = systemSignings.take();
      if (!taken.ok) return deny("rate-limited", live, { retryAfter: taken.retryAfter });
    }
    // A command's token (B5): its claims are mandatory and checked here, with
    // the occurrence it is for.
    let commandOp = null;
    if (session.cmd !== undefined) {
      commandOp = await commandOperation({ claims: session, stage: session.stg, occurrenceId, fn, op, argsDigest });
      if (commandOp.refusal) {
        if (commandOp.definite) await settleRefusal({ command: commandOp.command, generation: session.fg, stage: session.stg, occurrenceId, occurrence: commandOp.occurrence, reason: commandOp.refusal });
        return deny(commandOp.refusal, { ...live, commandId: session.cmd });
      }
    } else if (provenance === "user" && await isCommandInvocation(session.inv)) {
      return deny("command-claims-required", live);
    }
    const refusal = await liveRefusal({ ...session, provenance }, fn);
    if (refusal) {
      if (commandOp) await settleRefusal({ command: commandOp.command, generation: session.fg, stage: session.stg, occurrenceId, occurrence: commandOp.occurrence, reason: refusal });
      return deny(refusal, live);
    }
    return issueExecution({ session, provenance, fn, op, argsDigest, occurrenceId, replayOnly, record: { ...live, planDigest: session.pld }, commandOp });
  };

  // The contract checks shared by mint and authorize-execution (W4). `claims`
  // is the verified session or execution token: its `cv` must be supported
  // and at least the minimum; a user-provenance token bound to a plan must
  // name a stored plan for this invocation whose stage `stage` is in
  // `lang`, admits `fn`, and pins a revision still runnable; an unbound
  // user-provenance token is refused when the invocation requires a plan.
  // Stored-artifact reads are confined to view-safe functions. Publication
  // and system tokens are bound by their own authority.
  const contractRefusalFor = async ({ claims, provenance, fn, invocationId, stage, lang }) => {
    const cv = claims.cv ?? 1;
    if (!SUPPORTED_CONTRACT_VERSIONS.includes(cv)) return "contract-version-unsupported";
    if (cv < minContractVersion) return "contract-version-unsupported";
    if (provenance !== "user") return null;
    if (!claims.pld) {
      if (stage === "read" && viewSafeFunctionsForLang(lang).includes(fn)) return null;
      return planRefusal(invocationId);
    }
    const plan = await invocations.getPlan(claims.pld);
    const pinned = plan?.stages?.find(s => s.stage === stage);
    if (!plan || plan.invocationId !== invocationId || !pinned || pinned.lang !== lang || !pinned.requiredFunctions.includes(fn)) {
      return "plan-binding-mismatch";
    }
    if (claims.bind && !(claims.bind.requiredFunctions ?? []).includes(fn)) return "plan-binding-mismatch";
    if (!(await revisionAvailable(lang, pinned.revision))) return "pinned-revision-unavailable";
    return null;
  };

  const issueExecution = async ({ session, provenance, fn, op, argsDigest, occurrenceId, replayOnly = false, record, commandOp = null }) => {
    // The invocation is durable and shared by its retries, and the stage and
    // occurrence are stable within it, so a retry reaches the same receipt.
    const operationId = `${session.inv}/${session.stg}/${occurrenceId}`;
    // A replay-only session's token is a replay token: same claims, its own
    // typ, good only for returning a recorded receipt (P1b).
    const executionToken = await issueToken(signer, replayOnly ? "replay" : "execution", {
      sub: session.sub,
      own: session.own,
      conn: session.conn,
      backend: session.backend,
      lang: session.lang,
      fn,
      op,
      sid: session.jti,
      opid: operationId,
      argd: argsDigest,
      rv: session.rv,
      prv: provenance,
      ...(provenance === "publication" ? { pub: session.pub } : {}),
      // The system session's expiry, signed: Broker keeps the session's
      // signature slots until every token it can produce has expired.
      ...(provenance === "system" ? { sexp: session.exp } : {}),
      cv: session.cv ?? 1,
      ...(session.pld ? { pld: session.pld, stg: session.stg } : {}),
      ...(session.cmd !== undefined ? { cmd: session.cmd, fg: session.fg } : {}),
    });
    // A command's token leaves Policy only once its jti and expiry are
    // committed to the occurrence's issuance log, by the current owner
    // (B5 §7): an empty log then proves no token ever existed.
    if (commandOp) {
      const { jti, exp } = decodeJwt(executionToken);
      try {
        await commandRecords.logIssuance({ commandId: session.cmd, generation: session.fg, stage: session.stg, occurrenceId, jti, exp });
      } catch (e) {
        if (e instanceof CommandRefused) return deny(e.reason, { ...record, commandId: session.cmd });
        throw e;
      }
    }
    await audit({ ...record, opid: operationId, outcome: "allowed", ...(replayOnly ? { reason: "replay-only" } : {}), ...(session.cmd !== undefined ? { commandId: session.cmd } : {}) });
    return { executionToken, operationId };
  };

  // Broker asks immediately before each effect: each provider request, each
  // local signature, each receipt replay (spec EXEC-02, API-02). One decision
  // authorizes one step of one operation, now; Broker never caches or reuses
  // it. `step`, `purpose` and `after` (the dispatch step taken before, or
  // null) come from Broker's own operation definition. The token is verified
  // with its execution profile (Broker's audience) on this route only.
  const authorizeExecution = async ({ caller, executionToken, op, argsDigest, step, purpose, after = null }) => {
    // `op`, `step` and `purpose` are the request's until the token verifies;
    // the audit validators record them only if the registry knows them.
    const base = { event: "authorize-execution", op, step, purpose, callerRole: caller?.role };
    if (caller?.role !== "broker") return deny("caller-not-broker", base);
    let claims;
    let replayOnly = false;
    try {
      ({ claims } = await verifyToken(jwks, "execution", executionToken));
    } catch (e) {
      // A replay token (P1b) authorizes one thing: returning a write's
      // recorded receipt.
      try {
        ({ claims } = await verifyToken(jwks, "replay", executionToken));
        replayOnly = true;
      } catch {
        return deny(e?.code === "ERR_JWT_EXPIRED" ? "token-expired" : "bad-token", base);
      }
    }
    const record = {
      ...base,
      uid: claims.sub,
      ownerUid: claims.own,
      lang: claims.lang,
      connectionId: claims.conn,
      fn: claims.fn,
      registryVersion: claims.rv,
      jti: claims.jti,
      opid: claims.opid,
      provenance: claims.prv,
      // Invocation and stage, from the verified operation id.
      ...opidParts(claims.opid),
    };
    // Paused: never authorize the next effect. A fresh read, never the cache.
    await requireProtectedExecution(record, { uid: claims.sub, connectionId: claims.conn }, { fresh: true });
    // The request is for the operation the token was minted for, with its
    // arguments, under this registry.
    if (claims.op !== op) return deny("operation-mismatch", record);
    if (claims.argd !== argsDigest) return deny("args-mismatch", record);
    if (replayOnly) {
      if (purpose !== "replay" || step !== "receipt") return deny("replay-only", record);
    } else if (!acceptedRegistry(claims.rv)) {
      return deny("registry-version-changed", record);
    }
    if (!isOperationAllowed({ lang: claims.lang, fn: claims.fn, op, backend: claims.backend })) {
      return deny("operation-not-allowed", record);
    }
    // Checked here whatever the shared token schema still tolerates.
    const badProvenance = provenanceRefusal(claims);
    if (badProvenance) return deny(badProvenance, record);
    if (!isStepRegistered({ op, step, purpose, after })) return deny("step-not-registered", record);
    // The plan, resolved from the token's own digest (W4): its invocation and
    // stage must agree with the operation id the receipt hangs off.
    const { invocationId: opInvocation, stage: opStage } = opidParts(claims.opid) as { invocationId?: string, stage?: string };
    if (claims.pld && claims.stg !== opStage) return deny("plan-binding-mismatch", { ...record, planDigest: claims.pld });
    const contractRefusal = await contractRefusalFor({ claims, provenance: claims.prv, fn: claims.fn, invocationId: opInvocation, stage: opStage, lang: claims.lang });
    if (contractRefusal) return deny(contractRefusal, { ...record, planDigest: claims.pld });
    // A command's step (B5): the owner is still current, the occurrence still
    // the bound one, and this token one Policy logged for it.
    if (claims.cmd !== undefined) {
      const occurrenceId = String(claims.opid).split("/")[2];
      const checked = await commandOperation({ claims: { ...claims, inv: opInvocation }, stage: opStage, occurrenceId, fn: claims.fn, op, argsDigest });
      if (checked.refusal) return deny(checked.refusal, { ...record, commandId: claims.cmd });
      if (!(checked.occurrence.minted ?? []).some(m => m.jti === claims.jti)) return deny("token-not-logged", { ...record, commandId: claims.cmd });
    } else if (claims.prv === "user" && await isCommandInvocation(opInvocation)) {
      return deny("command-claims-required", record);
    }
    // The same live checks as mint, re-read now.
    const refusal = await liveRefusal({ ...claims, provenance: claims.prv }, claims.fn);
    if (refusal) return deny(refusal, record);
    const decisionId = randomUUID();
    await audit({ ...record, decisionId, outcome: "allowed", planDigest: claims.pld });
    return { decisionId };
  };

  // Verifies an invocation token the gateway holds and the invocation behind
  // it, for this user: { refusal } or { claims, invocation }. A wrong owner, a
  // publication's token and an unknown invocation get the same refusal.
  const gatewayInvocation = async ({ invocationToken, user }) => {
    let claims;
    try {
      ({ claims } = await verifyToken(jwks, "invocation", invocationToken));
    } catch {
      return { refusal: "bad-invocation" };
    }
    if (claims.pub || claims.sub !== user.uid || !isId(claims.inv)) return { refusal: "bad-invocation" };
    const invocation = await invocations.get(claims.inv);
    if (!invocation || invocation.uid !== user.uid || invocation.connectionId !== claims.conn) return { refusal: "bad-invocation" };
    return { claims, invocation };
  };

  // Before resolving any compiler URL, a retry asks for its invocation's plan
  // (W4 decision 3): with one, it preflights the pinned revisions; without,
  // the revisions serving now.
  const planLookup = async ({ caller, user, invocationToken }) => {
    const record = { event: "plan-lookup", uid: user?.uid, callerRole: caller?.role };
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (!user?.uid) return deny("no-user", record);
    if (typeof invocationToken !== "string") return deny("bad-request", record);
    const found = await gatewayInvocation({ invocationToken, user });
    if (found.refusal) return deny(found.refusal, record);
    const { invocation } = found;
    Object.assign(record, { invocationId: invocation.invocationId, connectionId: invocation.connectionId });
    if (!invocation.planDigest) {
      await audit({ ...record, outcome: "allowed" });
      return { contract: invocation.contract, plan: null };
    }
    const plan = await invocations.getPlan(invocation.planDigest);
    const stages = await Promise.all(plan.stages.map(async s => {
      const current = approvals ? await approvals.current(s.lang, s.revision) : null;
      return { stage: s.stage, lang: s.lang, revision: s.revision, tagUrl: current?.tagUrl ?? null, available: current?.status === "approved" };
    }));
    await audit({ ...record, planDigest: invocation.planDigest, outcome: "allowed" });
    return { contract: invocation.contract, plan: { planDigest: invocation.planDigest, stages } };
  };

  // Chain admission (W4, ADMIT-01/02): one decision for every stage, before
  // any executes. `taskIds` is the chain in order; `stages[i]` is the
  // preflight manifest of task i, stage `s<i>`, from its compiler. Every stage
  // is pinned: its revision must be approved for its language at one
  // consistent read, together with the connection and grants.
  const admit = async ({ caller, user, invocationToken, taskIds, stages }) => {
    const record = { event: "admission", uid: user?.uid, callerRole: caller?.role, registryVersion };
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (!user?.uid) return deny("no-user", record);
    if (typeof invocationToken !== "string") return deny("bad-request", record);
    const found = await gatewayInvocation({ invocationToken, user });
    if (found.refusal) return deny(found.refusal, record);
    const admitted = await admitChain({ record, uid: user.uid, invocation: found.invocation, taskIds, stages });
    const { invocationId, connectionId } = found.invocation;
    const admissionToken = await issueToken(signer, "admission", { sub: user.uid, conn: connectionId, inv: invocationId, pld: admitted.planDigest, cv: CONTRACT_VERSION });
    await audit({ ...record, ownerUid: admitted.ownerUid, outcome: "allowed", reason: admitted.created ? "new" : "reused" });
    return { planDigest: admitted.planDigest, admissionToken, stages: admitted.stages };
  };

  // The body of chain admission, shared by the gateway's admit (a user's
  // invocation token) and a command's (its stored principal, B5): one
  // decision for every stage at one consistent read, and the plan written.
  // Returns { planDigest, plan, stages, ownerUid, created }, or denies.
  const admitChain = async ({ record, uid, invocation, taskIds, stages }) => {
    const { invocationId, connectionId } = invocation;
    Object.assign(record, { invocationId, connectionId });
    await requireProtectedExecution(record, { uid, connectionId });
    if (!approvals || !fence) return deny("unavailable", record);
    if (invocation.contract !== 2) return deny("invocation-incompatible", record);
    if (!Array.isArray(taskIds) || !taskIds.length || !taskIds.every(t => typeof t === "string" && t.length > 0) ||
        !Array.isArray(stages) || stages.length !== taskIds.length || stages.some((m, i) => manifestProblems(m, `s${i}`).length)) {
      return deny("bad-request", record);
    }
    // The chain is the invocation's own (by its canonical task list).
    let invocationChain;
    try {
      invocationChain = decodeChainId(invocation.taskId);
    } catch {
      return deny("plan-binding-mismatch", record);
    }
    if (JSON.stringify(invocationChain) !== JSON.stringify(taskIds)) return deny("plan-binding-mismatch", record);
    // A stage reports the registry version its language's declarations were
    // written for, or 0 for a language with none (L0000), which needs no
    // redeploy when the registry changes. A plan has one version (P1b): a
    // retry keeps the one its plan was admitted under; a new plan takes its
    // protected stages' version, which must be accepted and shared by all of
    // them, or the instance's when it has none.
    const isProtectedLang = lang => Object.keys(protectedFunctionsForLang(lang) || {}).length > 0;
    if (stages.some(m => !isProtectedLang(m.lang) && m.registryVersion !== 0)) return deny("registry-version-mismatch", record);
    const reported = stages.filter(m => isProtectedLang(m.lang)).map(m => m.registryVersion);
    const stored = invocation.planDigest ? await invocations.getPlan(invocation.planDigest) : null;
    let planRegistry;
    if (stored) {
      // A retry keeps its plan's version even after it leaves the window: its
      // sessions are then replay-only (snapshot), so nothing new executes,
      // but its writes' recorded outcomes can still be returned.
      planRegistry = stored.registryVersion;
    } else {
      planRegistry = reported.length ? reported[0] : registryVersion;
      if (!acceptedRegistry(planRegistry)) return deny("registry-version-mismatch", record);
    }
    if (reported.some(v => v !== planRegistry)) return deny("registry-version-mismatch", record);
    Object.assign(record, { registryVersion: planRegistry });
    // A function the registry doesn't list for the stage's language can't be
    // admitted; a language without protected functions requires none.
    for (const m of stages) {
      const registered = protectedFunctionsForLang(m.lang) || {};
      if (m.requiredFunctions.some(fn => !Object.prototype.hasOwnProperty.call(registered, fn))) return deny("bad-request", record);
    }
    const plan = {
      contractVersion: CONTRACT_VERSION as 2,
      invocationId,
      taskIds,
      connectionId,
      inputDigest: invocation.inputDigest,
      registryVersion: planRegistry,
      stages: stages.map(pinnedStage),
    };
    const digest = digestOf(plan);
    Object.assign(record, { planDigest: digest });
    const retry = Boolean(invocation.planDigest);
    if (retry && invocation.planDigest !== digest) return deny("plan-mismatch", record);

    // The fence (W4 section A): the lease first, then every read at a time no
    // earlier than it, then the plan write that consumes it.
    const revisions = [...new Set(plan.stages.map(s => s.revision))];
    const lease = await fence.register(revisions);
    const approved = await approvals.read(plan.stages.map(s => ({ lang: s.lang, revision: s.revision })), lease.readTime);
    for (const [i, { record: rev, languageKnown }] of approved.entries()) {
      const m = plan.stages[i];
      if (!languageKnown) return deny("stage-not-pinnable", record);
      if (!rev || rev.lang !== m.lang) return deny(retry ? "pinned-revision-unavailable" : "revision-not-approved", record);
      if (rev.status !== "approved") {
        return deny(retry ? "pinned-revision-unavailable" : rev.status === "retiring" ? "revision-retiring" : "revision-not-approved", record);
      }
      if (rev.imageDigest !== m.imageDigest) return deny("plan-binding-mismatch", record);
      if (!(rev.contractVersions ?? []).includes(CONTRACT_VERSION)) return deny("contract-version-unsupported", record);
    }
    const connection = await connections.get(connectionId, { readTime: lease.readTime });
    const access = await accessFor(connection, uid, { readTime: lease.readTime });
    if (access.refusal) return deny(access.refusal, { ...record, ownerUid: connection?.ownerUid });
    for (const m of plan.stages) {
      const registered = protectedFunctionsForLang(m.lang) || {};
      for (const fn of m.requiredFunctions) {
        if (registered[fn].backend !== connection.backend || !mayUse(access, m.lang, fn)) {
          return deny("not-granted", { ...record, ownerUid: connection.ownerUid });
        }
      }
    }
    let committed;
    try {
      committed = await invocations.commitPlan({ leaseId: lease.id, invocationId, planDigest: digest, plan, revisions, readTime: lease.readTime, maxAgeMs: admissionMaxAgeMs, now });
    } catch (e) {
      if (e instanceof AdmissionRefused) return deny(e.reason, { ...record, ownerUid: connection.ownerUid });
      throw e;
    }
    return {
      planDigest: digest,
      plan,
      ownerUid: connection.ownerUid,
      backend: connection.backend,
      created: committed.created,
      stages: plan.stages.map((m, i) => ({ stage: m.stage, lang: m.lang, revision: m.revision, tagUrl: approved[i].record.tagUrl })),
    };
  };

  // Reconciliation (spec WRITE-02, W5 stage 3), asked from the console by the
  // signed-in user, for one save: the exact attempt, named by the idempotency
  // key it used (the user's own) or its invocation id. Allowed for the
  // connection's owner, or for the user who made the save while their grant
  // still covers a write. Broker then reads the provider and appends what it
  // found; nothing is written to the provider and nothing re-executes.
  const mayWrite = access => Object.entries(PROTECTED_FUNCTIONS).some(([lang, fns]) =>
    Object.entries(fns).some(([fn, spec]) => spec.kind === "write" && mayUse(access, lang, fn)));
  const reconcile = async ({ caller, user, connectionId, idempotencyKey = null, invocationId = null }) => {
    const record = { event: "reconcile-request", uid: user?.uid, connectionId, callerRole: caller?.role };
    if (caller?.role !== "console") return deny("caller-not-entry-point", record);
    if (!user?.uid) return deny("no-user", record);
    if (!brokerReconcile) return deny("unavailable", record);
    if ((idempotencyKey === null) === (invocationId === null)) return deny("bad-request", record);
    if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 256)) return deny("bad-request", record);
    const connection = typeof connectionId === "string" ? await connections.get(connectionId) : null;
    const access = await accessFor(connection, user.uid);
    if (access.refusal) return deny(access.refusal, { ...record, ownerUid: connection?.ownerUid });
    const invocation = idempotencyKey !== null ? await invocations.findByKey(user.uid, idempotencyKey) : await invocations.get(invocationId);
    if (!invocation || invocation.connectionId !== connectionId) return deny("invocation-not-found", { ...record, ownerUid: connection.ownerUid });
    if (!access.owner && !(invocation.uid === user.uid && mayWrite(access))) return deny("not-granted", { ...record, ownerUid: connection.ownerUid });
    const decisionId = randomUUID();
    const live = { ...record, ownerUid: connection.ownerUid, invocationId: invocation.invocationId, decisionId };
    let result;
    try {
      result = await brokerReconcile({ connectionId, invocationId: invocation.invocationId, decisionId });
    } catch (e) {
      return deny(typeof e?.reason === "string" ? e.reason : "unavailable", live);
    }
    await audit({ ...live, outcome: "allowed" });
    return result;
  };

  // For the operator and candidate checks: on or off, and why. Never the flag's
  // other fields.
  const protectedExecution = async () => {
    const { enabled, source } = await protectedSwitch.state();
    return { enabled, source };
  };

  return { allocateInvocation, allocateCommand, leaseCommand, getCommand, commandWrite, settleCommand, commandRead, transitionCommand, admitCommand, commandSession, commandBind, commandObserve, createPublication, deletePublication, authorizeView, snapshot, previewSession, mint, authorizeExecution, planLookup, admit, reconcile, protectedExecution };
};
