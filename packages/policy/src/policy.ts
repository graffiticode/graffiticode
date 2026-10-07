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
//             same invocation reaches the same write receipt.
//   admission (contract v2, capability plan W4) once per chain, by the
//             gateway, before any stage executes: every stage's preflight
//             manifest, pinned to approved compiler revisions, decided in one
//             consistent read. Denying any stage denies the chain. The plan
//             (by its digest) binds every later snapshot, mint and
//             authorization for the invocation; a marked invocation never
//             runs without it. `planLookup` gives a retry the plan before it
//             resolves any compiler URL.
//
// Callers are authenticated before reaching here: `user` is the verified end
// user and `caller.lang` the language bound to the verified calling service.
// Every decision, allowed or denied, is audited.

import {
  REGISTRY_VERSION,
  isOperationAllowed,
  protectedFunctionsForLang,
  systemPreviewFunctionsForLang,
  viewSafeFunctionsForLang,
  isGatedFunction,
  isStepRegistered
} from "@graffiticode/common/protected-registry";
import { createHash, randomUUID } from "node:crypto";
import { decodeChainId } from "@graffiticode/common/chain";
import { CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSIONS, manifestProblems, pinnedStage, planDigest as digestOf, stageBinding, sameStage } from "@graffiticode/common/contract";
import { issueToken, verifyToken } from "./tokens.js";
import { grantIdFor, isExpired } from "./grants.js";
import { InvocationConflict, AdmissionRefused } from "./invocations.js";
import { newPublicationId } from "./publications.js";
import { MAINTENANCE, admission } from "./maintenance.js";
import { SYSTEM_PREVIEW_SUBJECT, sessionProvenance, provenanceRefusal } from "./provenance.js";

export class PolicyDenied extends Error {
  declare reason: string;
  constructor(reason: string) {
    super(`policy denied: ${reason}`);
    this.reason = reason;
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

// How old an admission's consistent read may be when its plan is written.
export const ADMISSION_MAX_AGE_MS = 5000;

export const createPolicy = ({
  signer, jwks, connections, invocations, publications, grants = null, systemConnections = {}, enabledGated = new Set(), protectedSwitch, audit,
  // Contract v2 (W4): the approved-revisions reader and the lease fence, and
  // the lowest contract version accepted (1 until the cutover).
  approvals = null, fence = null, minContractVersion = 1, admissionMaxAgeMs = ADMISSION_MAX_AGE_MS, now = () => Date.now(),
}) => {
  // No default: a policy built without the switch would run ungated.
  if (!protectedSwitch || typeof protectedSwitch.state !== "function") throw new Error("createPolicy needs a protectedSwitch");
  const deny = async (reason, record) => {
    await audit({ ...record, outcome: "denied", reason });
    throw new PolicyDenied(reason);
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
  // An enablement-gated function (AUTHOR-01) is reachable only when this
  // deployment enables it; owner permissions cannot bypass that.
  const gateOpen = (lang, fn) =>
    !isGatedFunction(lang, fn) || enabledGated.has(`${String(lang ?? "").replace(/^L/i, "").padStart(4, "0")}:${fn}`);
  const mayUse = (access, lang, fn) => {
    const spec = protectedFunctionsForLang(lang)?.[fn];
    if (!spec || !gateOpen(lang, fn)) return false;
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
      // From the cutover every new invocation is admitted under a plan.
      allocated = await invocations.allocate({ uid: user.uid, connectionId, taskId, inputDigest, idempotencyKey, admission: admission || minContractVersion >= 2 });
    } catch (e) {
      if (e instanceof InvocationConflict) return deny("idempotency-key-reused", record);
      throw e;
    }
    const { invocationId, seq, reused } = allocated;
    // The invocation's own marker (a retry can't change it): 2 means it runs
    // only under an admitted plan.
    const contract = allocated.contract ?? 1;
    const invocationToken = await issueToken(signer, "invocation", { sub: user.uid, conn: connectionId, inv: invocationId, seq, cv: contract });
    await audit({ ...record, ownerUid: connection.ownerUid, invocationId, outcome: "allowed", reason: reused ? "reused" : "new" });
    // The owner and sequence go back to the gateway, which binds the private
    // result of this invocation to them.
    return { invocationToken, invocationId, seq, reused, ownerUid: connection.ownerUid, contract, planDigest: allocated.planDigest ?? null, minContractVersion };
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
      rv: REGISTRY_VERSION,
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
    return { planDigest: claims.pld, stage: pinned };
  };

  const snapshot = async ({ caller, user, lang, connectionId, fns, invocationToken, stage, admissionToken = null, manifest = null }) => {
    const record = { event: "snapshot", uid: user?.uid, lang, connectionId, registryVersion: REGISTRY_VERSION, callerRole: caller?.role };
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

    // Contract v2: bound to the admitted plan, or refused if the invocation
    // requires one. An unmarked invocation keeps the per-stage path (v1)
    // until the cutover.
    let bound = null;
    if (admissionToken !== null) {
      if (typeof admissionToken !== "string") return deny("bad-request", record);
      bound = await planBinding({ admissionToken, invocationId, uid: user.uid, connectionId, lang, stage, manifest });
      if (bound.refusal) return deny(bound.refusal, record);
      Object.assign(record, { planDigest: bound.planDigest });
    } else {
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
    const allowed = [...new Set(fns)].filter(fn => {
      const spec = Object.prototype.hasOwnProperty.call(registered, fn) ? registered[fn] : null;
      return Boolean(spec && spec.backend === connection.backend && mayUse(access, lang, fn) && (!admitted || admitted.has(fn)));
    });

    const sessionToken = await issueToken(signer, "session", {
      sub: user.uid,
      own: connection.ownerUid,
      conn: connectionId,
      backend: connection.backend,
      lang,
      inv: invocationId,
      stg: stage,
      rv: REGISTRY_VERSION,
      fns: allowed,
      ...(bound ? { cv: CONTRACT_VERSION, pld: bound.planDigest, bind: stageBinding(bound.stage) } : { cv: 1 }),
    });
    await audit({ ...record, ownerUid: connection.ownerUid, outcome: "allowed" });
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
    const record = { event: "preview-session", lang, registryVersion: REGISTRY_VERSION, callerRole: caller?.role };
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
      rv: REGISTRY_VERSION,
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
    // Re-checked on every user call, whatever the session lists (AUTHOR-01).
    // System and publication sessions never reach a gated function: their
    // sets (system-preview, viewSafe) exclude them by registry construction.
    if (!gateOpen(authority.lang, fn)) return "fn-not-enabled";
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
    if (session.rv !== REGISTRY_VERSION) return deny("registry-version-changed", record);
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
    const refusal = await liveRefusal({ ...session, provenance }, fn);
    if (refusal) return deny(refusal, live);
    return issueExecution({ session, provenance, fn, op, argsDigest, occurrenceId, record: { ...live, planDigest: session.pld } });
  };

  // The contract checks shared by mint and authorize-execution (W4). `claims`
  // is the verified session or execution token: its `cv` must be supported
  // and at least the minimum; a user-provenance token bound to a plan must
  // name a stored plan for this invocation whose stage `stage` is in
  // `lang`, admits `fn`, and pins a revision still runnable; an unbound
  // user-provenance token is refused when the invocation requires a plan.
  // Publication and system tokens are bound by their own authority.
  const contractRefusalFor = async ({ claims, provenance, fn, invocationId, stage, lang }) => {
    const cv = claims.cv ?? 1;
    if (!SUPPORTED_CONTRACT_VERSIONS.includes(cv)) return "contract-version-unsupported";
    if (cv < minContractVersion) return "contract-version-unsupported";
    if (provenance !== "user") return null;
    if (!claims.pld) return planRefusal(invocationId);
    const plan = await invocations.getPlan(claims.pld);
    const pinned = plan?.stages?.find(s => s.stage === stage);
    if (!plan || plan.invocationId !== invocationId || !pinned || pinned.lang !== lang || !pinned.requiredFunctions.includes(fn)) {
      return "plan-binding-mismatch";
    }
    if (claims.bind && !(claims.bind.requiredFunctions ?? []).includes(fn)) return "plan-binding-mismatch";
    if (!(await revisionAvailable(lang, pinned.revision))) return "pinned-revision-unavailable";
    return null;
  };

  const issueExecution = async ({ session, provenance, fn, op, argsDigest, occurrenceId, record }) => {
    // The invocation is durable and shared by its retries, and the stage and
    // occurrence are stable within it, so a retry reaches the same receipt.
    const operationId = `${session.inv}/${session.stg}/${occurrenceId}`;
    const executionToken = await issueToken(signer, "execution", {
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
      cv: session.cv ?? 1,
      ...(session.pld ? { pld: session.pld, stg: session.stg } : {}),
    });
    await audit({ ...record, opid: operationId, outcome: "allowed" });
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
    try {
      ({ claims } = await verifyToken(jwks, "execution", executionToken));
    } catch (e) {
      return deny(e?.code === "ERR_JWT_EXPIRED" ? "token-expired" : "bad-token", base);
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
    if (claims.rv !== REGISTRY_VERSION) return deny("registry-version-changed", record);
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
    const record = { event: "admission", uid: user?.uid, callerRole: caller?.role, registryVersion: REGISTRY_VERSION };
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (!user?.uid) return deny("no-user", record);
    if (typeof invocationToken !== "string") return deny("bad-request", record);
    const found = await gatewayInvocation({ invocationToken, user });
    if (found.refusal) return deny(found.refusal, record);
    const { invocation } = found;
    const { invocationId, connectionId } = invocation;
    Object.assign(record, { invocationId, connectionId });
    await requireProtectedExecution(record, { uid: user.uid, connectionId });
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
    // written for: the current one, or 0 for a language with none (L0000),
    // which needs no redeploy when the registry changes.
    const expectedRegistry = m => (Object.keys(protectedFunctionsForLang(m.lang) || {}).length ? REGISTRY_VERSION : 0);
    if (stages.some(m => m.registryVersion !== expectedRegistry(m))) return deny("registry-version-mismatch", record);
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
      registryVersion: REGISTRY_VERSION,
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
    const access = await accessFor(connection, user.uid, { readTime: lease.readTime });
    if (access.refusal) return deny(access.refusal, { ...record, ownerUid: connection?.ownerUid });
    for (const m of plan.stages) {
      const registered = protectedFunctionsForLang(m.lang) || {};
      for (const fn of m.requiredFunctions) {
        if (registered[fn].backend !== connection.backend || !mayUse(access, m.lang, fn)) {
          return deny(gateOpen(m.lang, fn) ? "not-granted" : "fn-not-enabled", { ...record, ownerUid: connection.ownerUid });
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
    const admissionToken = await issueToken(signer, "admission", { sub: user.uid, conn: connectionId, inv: invocationId, pld: digest, cv: CONTRACT_VERSION });
    await audit({ ...record, ownerUid: connection.ownerUid, outcome: "allowed", reason: committed.created ? "new" : "reused" });
    return {
      planDigest: digest,
      admissionToken,
      stages: plan.stages.map((m, i) => ({ stage: m.stage, lang: m.lang, revision: m.revision, tagUrl: approved[i].record.tagUrl })),
    };
  };

  // For the operator and candidate checks: on or off, and why. Never the flag's
  // other fields.
  const protectedExecution = async () => {
    const { enabled, source } = await protectedSwitch.state();
    return { enabled, source };
  };

  return { allocateInvocation, createPublication, deletePublication, authorizeView, snapshot, previewSession, mint, authorizeExecution, planLookup, admit, protectedExecution };
};
