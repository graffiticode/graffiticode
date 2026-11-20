// C5d's staged drive (docs/c5d-snapshot-commands-plan.md, slice 3), judged as
// pure functions of what scripts/c5d-drive.js observed. The runner collects;
// only this module judges, so every judgment is tested offline
// (scripts/test/c5d-drive.test.js) and can be re-run on saved evidence.
//
//   driveTargets({ uid, runId })       every key, command id and fault target, before the run
//   driveNamesProblem(config)          null, or why the configured names aren't the drive's
//   judgePhase(phase, observations)    -> { phase, passed, checks: [{ id, title, ok, detail }] }
//   verdict(phases)                    -> { passed, phases }   every slice 3 phase judged and passed
//
// An observation that is missing fails its check ("not observed"), and a
// value that can't be read is never treated as unchanged (the #441 review):
// a counter or a generation must be readable on both sides before it is
// compared. Absence that was read is explicit, `{ absent: true }` (a 404),
// never `null` or a missing key.
//
// Observation shapes (plain JSON), by phase:
//
//   capture  { commandId, status, ownerGeneration, invocationId,
//              result: { item, url } | null,          L0013's own value (snapshot_value)
//              reservations: [{ stage, occurrenceId, item, captureSequence, publicCapture,
//                               state, generation, sha256, stagedGeneration, stagedAt }],
//              claim: { claimedAt, evidence: { bucket, object, item, captureSequence, sha256, commandId, staged } }
//                     | { absent: true },               Broker's claim of the first reservation
//              object: { generation, metadata: { captureSequence, commandId, sha256 } } | { absent: true } }
//   counter  { nextCaptureSequence }                 Policy's item-captures record
//   lines    [{ at, text }]                          log lines, in time order
//   audit    [{ at, service, event, outcome, reason, commandId, invocationId, opid, step, itemId }]
//
//   checks           { services: { broker, l0013r, l0176r, api: { env } }, l0013rStatus: { thumbnailBucket },
//                      bucket: { settings: { uniform, publicAccessPrevention }, bindings }, targets }
//   baseline         { thumbnails: [{ name, generation }] }
//   first-capture    { private: capture, public: capture, publicSubject }
//   direct-refused   { status, messages: [string], before: object, after: object }
//   exit-after-reserve { capture, faultLines: lines, counterBefore: counter, counterAfter: counter }
//   exit-after-stage { capture, faultLines: lines, renders: number, stagedAtExit: reservation }
//   drop-outcome     { brokerFaults: { BROKER_FAULTS, BROKER_FAULT_PRINCIPALS }, capture, operationId,
//                      claim: { evidence } | { absent: true }, outcomeAfterDrop: {...} | { absent: true },
//                      objectAfterDrop: object, stagedAfterDelete: { absent: true } | {...},
//                      stagedDeletedAt, droppedFinishedAt, retry: { commandId, outcome },
//                      reconcile: { status, timedOut, attempts, operations: [{ operationId, verdict, final, result }] },
//                      objectAfterRetry: object, executeSteps: audit }
//   stale-worker     { capture, policyAudit: audit, l0013Lines: lines, apiLines: lines }
//   staging-gone     { capture (the targeted one), faultLines: lines, stagedAtExit: reservation,
//                      stagedAfterDelete: { absent: true } | {...}, claim: { absent: true } | {...},
//                      objectBefore: object, objectAfter: object, renders: number, fresh: capture }
//   older-after-newer { older: capture, newer: capture, olderFaultLines: lines, olderSteps: [{ step, observed }],
//                       finalObject: object }
//   two-stage        { capture, distinctItems: capture, sameProgram: capture, scopes: [{ fn, itemId }] }
//   mixed            { capture, invocations, tokens: [{ fn, scopeKinds }] }
//   non-owner        { status, outcome, reason, reservations: [] }
//   rate-limit       { priorInWindow, attempted, allowed, refused, refusedAfterQuota,
//                      retired: { statuses, listedAfter } }
//   canary-snap      { exitCode, results: [{ name, ok }], commandId, expectedCommandId }
//   boundary         { commands: [{ commandId, invocationId } | { commandId, absent: true }],
//                      claimsByInvocation: { <invocation>: [operationId] },
//                      queries: [{ query, count, limit, nextPageToken? }], poll: { attempts, timedOut },
//                      brokerAudit: audit, reconcileBuckets: [{ opid, bucket }],
//                      thumbnailsBefore (baseline.json's): [{ name, generation }], thumbnailsAfter: [...],
//                      fixtures: [item], compilerCalls: [{ service }] }
//   cleanup          { commands: [{ commandId, status | "absent" }], due: [commandId], unresolvedIntents: [file] }
//   errors           { <observation>: message }    a read that failed fails its phase

import { createHash } from "node:crypto";
import { runAppService as runAppHost } from "./canary-env.js";

// ----------------------------------------------------------------- the drive

export const DRIVE = Object.freeze({
  broker: "broker-c5d-drive",
  l0013r: "l0013r-c5d-drive",
  l0176r: "l0176r-c5d-drive",
  api: "api-c5d-drive",
  bucket: "graffiticode-c5d-drive",
});
export const STAGING_BUCKET = "graffiticode-command-staging";
export const COMPILE_GENERATION = "c5d-drive-1";
// Production's services, B6's kept drive compiler (decision 3: untouched) and
// B6's deleted fault Broker (never recreated): the drive runs against none.
export const FORBIDDEN_SERVICES = Object.freeze(["api", "broker", "policy", "l0013r", "l0176r", "l0013", "l0176", "l0176r-drive", "broker-faults", "api-drive"]);
export const FORBIDDEN_BUCKETS = Object.freeze(["graffiticode-thumbnails", "graffiticode.appspot.com", STAGING_BUCKET]);
export const PUBLIC_CAPTURE_LIMIT = 12;
export const STALL_BOUND_MS = 240_000;
export const DIRECT_REFUSAL = "THUMBNAIL_BUCKET is not set: this server stores no captures";
export const FIXTURES = Object.freeze({ private: "7vwaCAIyMNCJEzgIfyYY", public: "wbyfys3akpc4yEGFrnuu" });
export const BROKER_RUN = "serviceAccount:broker-run@graffiticode.iam.gserviceaccount.com";

// Policy's command id (packages/policy/src/commands.ts commandIdFor).
export const commandIdFor = (uid, idempotencyKey) => `c:${createHash("sha256").update(JSON.stringify([uid, idempotencyKey])).digest("hex")}`;

// The run's keys, in one place: the targets are computed from them before the
// run (slice 1 item 3), and the fault maps are set once from these.
export const KEY_NAMES = Object.freeze([
  "first-private", "exit-after-reserve", "exit-after-stage", "drop-outcome", "stale-worker",
  "staging-gone", "staging-gone-fresh", "older", "newer", "two-stage", "two-stage-same", "mixed",
]);
export const driveKey = (runId, name) => `c5d-drive:${runId}:${name}`;
export const driveTargets = ({ uid, runId }) => {
  if (typeof uid !== "string" || !uid) throw new Error("driveTargets needs the canary uid");
  if (typeof runId !== "string" || !/^[a-z0-9]{4,32}$/.test(runId)) throw new Error("driveTargets needs a run id");
  const keys = Object.fromEntries(KEY_NAMES.map(n => [n, driveKey(runId, n)]));
  const ids = Object.fromEntries(KEY_NAMES.map(n => [n, commandIdFor(uid, keys[n])]));
  // Only these, each at generation 1 (the faults' own gating): in
  // older-after-newer only the older capture is targeted, never the newer.
  const l0013 = {
    [ids["exit-after-reserve"]]: "exit-after-reserve",
    [ids["exit-after-stage"]]: "exit-after-stage",
    [ids["stale-worker"]]: "stall-before-stage",
    [ids["staging-gone"]]: "exit-after-stage",
    [ids.older]: "exit-after-stage",
  };
  const api = { [ids["stale-worker"]]: "stop-renewal" };
  // canary.js --snap's own key (scripts/lib/canary.js: `canary:<runId>:snap`),
  // with the run id the drive passes it (--run-id), so its command id is
  // known, and journaled, before the subprocess starts.
  const canaryRunId = `c5d${runId}`;
  keys["canary-snap"] = `canary:${canaryRunId}:snap`;
  ids["canary-snap"] = commandIdFor(uid, keys["canary-snap"]);
  return { runId, uid, canaryRunId, keys, ids, faults: { L0013_CAPTURE_FAULTS: l0013, API_COMMAND_FAULT_TARGETS: api } };
};

// A Cloud Run URL's whole service name, by #441's rule (canary-env.js
// runAppService: only the trailing hash and region, or project number, are
// dropped, so `l0176r-c5d-drive` stays whole; a `<tag>---` prefix is the
// tag's). null for anything else: a custom domain names no service here.
export const runAppService = url => {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return runAppHost(host)?.service ?? null;
};

// A URL the runner sends to in a drive role must be that role's own drive
// service, stable or tagged: never a custom domain (api.graffiticode.org
// serves production), never another service, drive or not.
export const driveUrlProblem = (role, url) => {
  if (!DRIVE[role] || role === "bucket") throw new Error(`no drive role ${role}`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `${role}: ${url} isn't a URL`;
  }
  if (parsed.protocol !== "https:") return `${role}: ${url} isn't https`;
  const service = runAppService(url);
  if (!service) return `${role}: ${url} isn't a Cloud Run service URL (a custom domain is refused)`;
  return service === DRIVE[role] ? null : `${role}: ${url} is ${service}'s, not ${DRIVE[role]}'s`;
};

// The runner's configuration: every service and the bucket must be the
// drive's own, by exact name.
export const driveNamesProblem = config => {
  const c = config ?? {};
  for (const [role, name] of Object.entries({ broker: c.broker, l0013r: c.l0013r, l0176r: c.l0176r, api: c.api })) {
    if (FORBIDDEN_SERVICES.includes(name)) return `${role} is ${name}: the drive never runs against a production or B6 service`;
    if (name !== DRIVE[role]) return `${role} is ${name ?? "unset"}, not the drive's ${DRIVE[role]}`;
  }
  if (FORBIDDEN_BUCKETS.includes(c.bucket)) return `the bucket is ${c.bucket}: the drive never publishes there`;
  if (c.bucket !== DRIVE.bucket) return `the bucket is ${c.bucket ?? "unset"}, not the drive's ${DRIVE.bucket}`;
  // Each URL given for a role is checked before any request (#446 review).
  for (const [role, url] of [["api", c.apiUrl], ["l0013r", c.l0013rUrl], ["l0176r", c.l0176rUrl], ["broker", c.brokerUrl]]) {
    if (url === null || url === undefined) continue;
    const problem = driveUrlProblem(role, url);
    if (problem) return problem;
  }
  return null;
};

// The exact staged object of a reservation (Broker's stagedObjectName).
export const stagedObject = (commandId, reservation) => `gs://${STAGING_BUCKET}/${commandId}/${reservation.stage}/${reservation.occurrenceId}.png`;
// The operation id of a capture: `<invocation>/<stage>/<occurrence>`.
export const operationIdOf = (invocationId, reservation) => `${invocationId}/${reservation.stage}/${reservation.occurrenceId}`;
export const thumbnailUrl = ({ bucket, item, sha256 }) => `https://storage.googleapis.com/${bucket}/${item}.png?v=${sha256.slice(0, 16)}`;

// --------------------------------------------------------------- primitives

const isGeneration = g => typeof g === "string" && /^[1-9][0-9]*$/.test(g);
const isSeq = n => Number.isSafeInteger(n) && n >= 1;
const isSha = s => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const isAbsent = o => o !== null && typeof o === "object" && o.absent === true;
const isObject = o => o !== null && typeof o === "object" && !isAbsent(o) && isGeneration(o.generation);
const show = v => (v === undefined ? "not observed" : JSON.stringify(v));
const at = x => Date.parse(x?.at ?? "");
// An object read: present (with a readable generation), or read as absent.
const objectRead = (name, o) => {
  if (o === undefined || o === null) return `${name}: not observed`;
  if (isAbsent(o) || isObject(o)) return null;
  return `${name}: no readable generation (${show(o)})`;
};
const sameObject = (a, b) => (isAbsent(a) && isAbsent(b)) || (isObject(a) && isObject(b) && a.generation === b.generation);
const counterValue = c => (Number.isSafeInteger(c?.nextCaptureSequence) && c.nextCaptureSequence >= 1 ? c.nextCaptureSequence : null);
const faultLine = (lines, kind, commandId) => (lines ?? []).find(l => typeof l?.text === "string" && l.text.includes(`capture fault ${kind} command ${commandId}`));
const oneReservation = c => (Array.isArray(c?.reservations) && c.reservations.length === 1 ? c.reservations[0] : null);

// A capture published exactly as reserved: completed, one reservation, and
// the drive bucket's object naming the command and the reserved sequence and
// digest; the result the same capture.
export const captureProblem = (name, c, { bucket = DRIVE.bucket, item = null, publicCapture = null } = {}) => {
  if (!c) return `${name}: not observed`;
  if (c.status !== "completed") return `${name}: ${c.commandId ?? "no command"} is ${c.status ?? "not observed"}, not completed`;
  const r = oneReservation(c);
  if (!r) return `${name}: ${Array.isArray(c.reservations) ? c.reservations.length : "no"} reservations, expected 1`;
  if (item && r.item !== item) return `${name}: reserved ${r.item}, not ${item}`;
  if (!isSeq(r.captureSequence)) return `${name}: the reserved sequence isn't readable (${show(r.captureSequence)})`;
  if (!isSha(r.sha256)) return `${name}: the reservation has no staged digest`;
  if (publicCapture !== null && r.publicCapture !== publicCapture) return `${name}: publicCapture ${show(r.publicCapture)}, expected ${publicCapture}`;
  if (!isObject(c.object)) return `${name}: nothing readable published at gs://${bucket}/${r.item}.png (${show(c.object)})`;
  const m = c.object.metadata ?? {};
  if (m.captureSequence !== String(r.captureSequence)) return `${name}: published sequence ${show(m.captureSequence)}, reserved ${r.captureSequence}`;
  if (m.commandId !== c.commandId) return `${name}: the object names command ${show(m.commandId)}, not ${c.commandId}`;
  if (m.sha256 !== r.sha256) return `${name}: the object's digest ${show(m.sha256)} isn't the staged ${r.sha256}`;
  // The language's result: L0013 returns exactly { item, url }
  // (crates/core/src/lib.rs snapshot_value), the url Broker's thumbnailUrl of
  // the staged digest in this bucket.
  const res = c.result;
  if (!res || typeof res !== "object") return `${name}: no result (${show(res)})`;
  const keys = Object.keys(res).sort().join(",");
  if (keys !== "item,url") return `${name}: the result has fields ${keys}, expected item and url`;
  if (res.item !== r.item) return `${name}: the result's item ${show(res.item)} isn't the reserved ${r.item}`;
  const expected = thumbnailUrl({ bucket, item: r.item, sha256: r.sha256 });
  if (res.url !== expected) return `${name}: the result's url ${show(res.url)} isn't ${expected}`;
  // Broker's evidence, on its claim (gcs.ts thumbnailEvidence): the same
  // capture, in this bucket, for this command.
  const ev = c.claim?.evidence;
  if (!ev) return `${name}: Broker's claim evidence not observed`;
  if (ev.bucket !== bucket || ev.object !== `${r.item}.png` || ev.item !== r.item) return `${name}: the claim's evidence names ${show({ bucket: ev.bucket, object: ev.object, item: ev.item })}`;
  if (ev.captureSequence !== r.captureSequence || ev.sha256 !== r.sha256) return `${name}: the claim's evidence ${show({ captureSequence: ev.captureSequence, sha256: ev.sha256 })} isn't the reservation's`;
  if (ev.commandId !== c.commandId) return `${name}: the claim's evidence names command ${show(ev.commandId)}`;
  return null;
};

// Policy's command statuses (commands.ts; command-outcomes.ts aggregateStatus):
// `pending` until finished, then exactly one of these. Anything else is unknown.
export const TERMINAL_STATUSES = Object.freeze(["completed", "partial", "failed", "uncertain"]);
export const isTerminal = status => {
  if (status === "pending") return false;
  if (TERMINAL_STATUSES.includes(status)) return true;
  throw new Error(`unknown command status ${JSON.stringify(status)}`);
};

const ok = problem => problem || true;
const first = (...problems) => problems.find(Boolean) ?? null;

// ------------------------------------------------------------------- phases

// The invocations of a boundary's inventoried commands.
const invocationsOf = o => [...new Set((o.commands ?? []).map(c => c.invocationId).filter(i => typeof i === "string"))];

const envProblem = (name, env, expected) => {
  if (!env) return `${name}: environment not observed`;
  for (const [k, v] of Object.entries(expected)) {
    if (v === undefined) {
      if (Object.hasOwn(env, k)) return `${name}: ${k} is set (${env[k]}), expected unset`;
    } else if (typeof v === "function") {
      const p = v(env[k]);
      if (p) return `${name}: ${k} ${p}`;
    } else if (env[k] !== v) {
      return `${name}: ${k} is ${show(env[k])}, expected ${v}`;
    }
  }
  return null;
};
const namesService = service => url => (runAppService(url) === service ? null : `is ${show(url)}, not ${service}'s URL`);
const sameMap = expected => value => {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return `isn't JSON (${show(value)})`;
  }
  const a = JSON.stringify(Object.entries(parsed ?? {}).sort());
  const b = JSON.stringify(Object.entries(expected ?? {}).sort());
  return a === b ? null : `names ${a}, not the run's targets ${b}`;
};

// ------------------------------------------------------------ access probes

// The two public drive compilers, each probed as Step 32 §7 lists
// (languages/l0000/crates/server/src/lib.rs `preflight`, `compile`'s
// `form: "model"`, `interpret`'s `start`; gateway.rs `GoogleGateways::verify`):
//   gateway-control      POST /preflight, X-Caller-Identity: api-run's ID token for
//                        urn:graffiticode:<lang> -> 200 { status: "success", data: { manifest } }
//   no-identity          POST /preflight, no X-Caller-Identity -> 401 reason caller-rejected
//   malformed-identity   X-Caller-Identity: "not-a-token" -> 401 caller-rejected
//   non-gateway          console-run's ID token for the same audience -> 403 route-not-allowed-for-caller
//   model                POST /compile { code, data: {}, form: "model" } -> 200 { model with intents }
//   start-malformed-session / start-forged-session
//                        POST /interpret { model, input: {}, operation: "start", commandSession }
//                        -> 200 { data: null, errors: [{ code: "bad-session" }] }, no url, no occurrences
// Without the control, every refusal would prove nothing.
export const ACCESS_PROBE_COMPILERS = Object.freeze(["l0013r", "l0176r"]);
export const ACCESS_PROBES = Object.freeze(["gateway-control", "no-identity", "malformed-identity", "non-gateway", "model", "start-malformed-session", "start-forged-session"]);
const preflightRefused = (p, status, reason) => {
  if (!p) return "not observed";
  if (p.status !== status) return `answered ${show(p.status)}, expected ${status}`;
  if (p.body?.error?.reason !== reason) return `reason ${show(p.body?.error?.reason)}, expected ${reason}`;
  return p.body?.data == null ? null : "it answered data";
};
const carriesUrl = v => JSON.stringify(v ?? null).includes("storage.googleapis.com");
const startRefused = p => {
  if (!p) return "not observed";
  if (p.status !== 200) return `answered ${show(p.status)}, expected 200 with errors`;
  const errors = p.body?.errors;
  if (!Array.isArray(errors) || !errors.some(e => e?.code === "bad-session")) return `no bad-session error (${show(errors)})`;
  if (p.body?.data != null) return "it answered data";
  if (p.body?.occurrences !== undefined && !["{}", "[]", "null"].includes(JSON.stringify(p.body.occurrences))) return `it performed occurrences ${show(p.body.occurrences)}`;
  return carriesUrl(p.body) ? "its answer carries a storage url" : null;
};
const ACCESS_PROBE_JUDGES = {
  "gateway-control": p => {
    if (!p) return "not observed";
    if (p.status !== 200 || p.body?.status !== "success") return `answered ${show(p.status)} ${show(p.body?.status)}`;
    return p.body?.data?.manifest && typeof p.body.data.manifest === "object" ? null : "no manifest";
  },
  "no-identity": p => preflightRefused(p, 401, "caller-rejected"),
  "malformed-identity": p => preflightRefused(p, 401, "caller-rejected"),
  "non-gateway": p => preflightRefused(p, 403, "route-not-allowed-for-caller"),
  model: p => {
    if (!p) return "not observed";
    if (p.status !== 200 || !p.body?.model) return `answered ${show(p.status)} with no model`;
    return Array.isArray(p.body.model.intents) && p.body.model.intents.length ? null : "the model declares no intents, so a start would be refused no-intents, proving nothing";
  },
  "start-malformed-session": startRefused,
  "start-forged-session": startRefused,
};
const accessProbeChecks = compiler => ACCESS_PROBES.map(probe => [
  `${compiler}-${probe}`,
  `${DRIVE[compiler]}: ${probe}`,
  o => ok(ACCESS_PROBE_JUDGES[probe](o.compilers?.[compiler]?.[probe])),
]);

export const PHASES = Object.freeze({
  // Step 32's verification, read before any capture.
  checks: [
    ["broker-env", "broker-c5d-drive publishes to the drive bucket, stages from Policy's, and has no fault set", o =>
      ok(envProblem(DRIVE.broker, o.services?.broker?.env, { THUMBNAIL_BUCKET: DRIVE.bucket, COMMAND_STAGING_BUCKET: STAGING_BUCKET, BROKER_FAULTS: undefined }))],
    ["l0013r-env", "l0013r-c5d-drive has no THUMBNAIL_BUCKET (null at /egress), names the drive Broker, and its fault map is exactly the run's targets", o => ok(first(
      envProblem(DRIVE.l0013r, o.services?.l0013r?.env, { THUMBNAIL_BUCKET: undefined, BROKER_URL: namesService(DRIVE.broker), L0013_CAPTURE_FAULTS: sameMap(o.targets?.L0013_CAPTURE_FAULTS) }),
      o.l0013rStatus && Object.hasOwn(o.l0013rStatus, "thumbnailBucket") && o.l0013rStatus.thumbnailBucket === null ? null : `/egress thumbnailBucket ${show(o.l0013rStatus?.thumbnailBucket)}, expected null`,
    ))],
    ["l0176r-env", "l0176r-c5d-drive names the drive Broker", o =>
      ok(envProblem(DRIVE.l0176r, o.services?.l0176r?.env, { BROKER_URL: namesService(DRIVE.broker) }))],
    ["api-env", "api-c5d-drive: L0013 and L0176 commands, scopes and interpretation on, routed to the drive compilers, its sweeper on, its stop-renewal targets exactly the run's", o =>
      ok(envProblem(DRIVE.api, o.services?.api?.env, {
        COMMANDS_L0013: "on",
        COMMANDS_L0176: "on",
        COMMAND_SCOPES: "on",
        INTERPRETER_L0013: "on",
        COMPILE_GENERATION_L0013: COMPILE_GENERATION,
        BASE_URL_L0013: namesService(DRIVE.l0013r),
        BASE_URL_L0176: namesService(DRIVE.l0176r),
        API_COMMAND_FAULT_TARGETS: sameMap(o.targets?.API_COMMAND_FAULT_TARGETS),
        SWEEP_AUDIENCE: v => (typeof v === "string" && v ? null : "is unset: the drive's sweeper must be on"),
        SWEEP_CALLERS: v => (typeof v === "string" && v ? null : "is unset: the drive's sweeper must be on"),
      }))],
    ["bucket", "gs://graffiticode-c5d-drive is uniform and private, broker-run its only object user, with no condition and no public member", o => {
      const b = o.bucket;
      if (!b?.settings || !Array.isArray(b.bindings)) return "the bucket's settings or IAM not observed";
      if (b.settings.uniform !== true) return "uniform bucket-level access is off";
      if (b.settings.publicAccessPrevention !== "enforced") return `public access prevention is ${show(b.settings.publicAccessPrevention)}, expected enforced`;
      if (b.bindings.some(x => x.condition)) return "a binding has a condition";
      const members = b.bindings.flatMap(x => x.members ?? []);
      if (members.some(m => m === "allUsers" || m === "allAuthenticatedUsers")) return "a public member has a role";
      const users = b.bindings.filter(x => x.role === "roles/storage.objectUser").flatMap(x => x.members ?? []);
      if (users.length !== 1 || users[0] !== BROKER_RUN) return `objectUser is ${show(users)}, expected [${BROKER_RUN}]`;
      return true;
    }],
  ],

  // The public drive compilers' own access control, live (Step 32 §7): a
  // gateway's preflight works, nothing else's does, and protected work
  // without a session Policy signed is refused, with nothing written.
  "access-probes": [
    ...ACCESS_PROBE_COMPILERS.flatMap(c => accessProbeChecks(c)),
    ["drive-bucket-unchanged", "the drive bucket's listing is the same after the probes", o => {
      const [a, b] = [o.bucketBefore, o.bucketAfter];
      if (!Array.isArray(a) || !Array.isArray(b)) return "a drive bucket listing not observed";
      const key = l => JSON.stringify(l.map(x => [x.name, x.generation]).sort());
      return key(a) === key(b) ? true : "the drive bucket changed";
    }],
    ["policy-unchanged", "Policy holds no new command, and no fixture's capture counter moved", o => {
      const [a, b] = [o.policyBefore, o.policyAfter];
      if (!a || !b || !Array.isArray(a.commandIds) || !Array.isArray(b.commandIds)) return "Policy's commands not observed before and after";
      if (a.complete !== true || b.complete !== true) return "Policy's enumeration incomplete";
      const added = b.commandIds.filter(id => !a.commandIds.includes(id));
      if (added.length) return `new commands: ${added.join(", ")}`;
      for (const item of Object.values(FIXTURES)) {
        const [x, y] = [a.itemCaptures?.[item], b.itemCaptures?.[item]];
        const value = c => (c?.absent === true ? "absent" : Number.isSafeInteger(c?.nextCaptureSequence) ? c.nextCaptureSequence : null);
        if (value(x) === null || value(y) === null) return `${item}'s capture counter not readable before and after`;
        if (value(x) !== value(y)) return `${item}'s capture counter moved ${value(x)} -> ${value(y)}: something reserved`;
      }
      return true;
    }],
  ],

  baseline: [
    ["thumbnails-listed", "graffiticode-thumbnails' listing is recorded: names and generations, readable", o => {
      const t = o.thumbnails;
      if (!Array.isArray(t) || t.length === 0) return `the listing is ${Array.isArray(t) ? "empty" : "not observed"}`;
      const bad = t.find(x => typeof x?.name !== "string" || !isGeneration(x.generation));
      return bad ? `an entry has no readable generation: ${show(bad)}` : true;
    }],
  ],

  "first-capture": [
    ["private", "the owner's capture of the private fixture publishes with its reserved sequence", o =>
      ok(captureProblem("private", o.private, { item: FIXTURES.private, publicCapture: false }))],
    ["public-anonymous", "an anonymous capture of the public fixture publishes under the public-capture exception (test 1)", o => ok(first(
      captureProblem("public", o.public, { item: FIXTURES.public, publicCapture: true }),
      o.publicSubject === "anonymous" ? null : `the public capture's subject is ${show(o.publicSubject)}, not anonymous`,
    ))],
  ],

  "direct-refused": [
    ["refused", "a compile straight to l0013r-c5d-drive outside a command is refused with A1b's message", o => {
      const messages = Array.isArray(o.messages) ? o.messages : null;
      if (!messages) return "the compile's errors not observed";
      return messages.some(m => typeof m === "string" && m.includes(DIRECT_REFUSAL)) ? true : `no refusal "${DIRECT_REFUSAL}" in ${show(messages)}`;
    }],
    ["nothing-uploaded", "the item's object in the drive bucket is unchanged by it", o => ok(first(
      objectRead("before", o.before), objectRead("after", o.after),
      sameObject(o.before, o.after) ? null : `the object changed: ${show(o.before)} -> ${show(o.after)}`,
    ))],
  ],

  "exit-after-reserve": [
    ["fault-fired", "the targeted capture exited after reserve, at generation 1", o =>
      (faultLine(o.faultLines, "exit-after-reserve", o.capture?.commandId) ? true : `no "capture fault exit-after-reserve command ${o.capture?.commandId}" line`)],
    ["taken-over", "the sweeper took it over (generation 2 or later) and it completed", o => {
      const g = o.capture?.ownerGeneration;
      if (!Number.isSafeInteger(g)) return `the owner generation isn't readable (${show(g)})`;
      return g >= 2 ? ok(o.capture.status === "completed" ? null : `status ${o.capture.status}`) : `generation ${g}: no takeover`;
    }],
    ["same-reservation", "reserve answered the generation-1 reservation; nothing counted twice; the original sequence published", o => {
      const r = oneReservation(o.capture);
      if (!r) return `${o.capture?.reservations?.length ?? "no"} reservations, expected 1`;
      if (r.generation !== 1) return `reserved at generation ${show(r.generation)}, not 1`;
      const before = counterValue(o.counterBefore);
      const after = counterValue(o.counterAfter);
      if (before === null || after === null) return `the item's capture counter isn't readable (before ${show(o.counterBefore)}, after ${show(o.counterAfter)})`;
      if (after - before !== 1) return `the item's counter moved ${before} -> ${after}, expected exactly one reservation`;
      return ok(captureProblem("exit-after-reserve", o.capture));
    }],
  ],

  "exit-after-stage": [
    ["fault-fired", "the targeted capture exited after staging, before publish, at generation 1", o =>
      (faultLine(o.faultLines, "exit-after-stage", o.capture?.commandId) ? true : `no "capture fault exit-after-stage command ${o.capture?.commandId}" line`)],
    ["staged-reused", "the takeover reused the staged bytes: one render, the staged record unchanged, and those bytes published", o => {
      if (!Number.isSafeInteger(o.renders)) return `the render count isn't readable (${show(o.renders)})`;
      if (o.renders !== 1) return `${o.renders} renders, expected 1`;
      const r = oneReservation(o.capture);
      const s = o.stagedAtExit;
      if (!r || !s) return "the staged record at the exit or at the end not observed";
      if (s.state !== "staged" || s.stagedGeneration !== 1) return `at the exit: ${s.state} at generation ${show(s.stagedGeneration)}, expected staged at 1`;
      if (r.sha256 !== s.sha256 || r.stagedAt !== s.stagedAt || r.stagedGeneration !== 1) return "the staged record changed after the exit";
      if (!Number.isSafeInteger(o.capture.ownerGeneration) || o.capture.ownerGeneration < 2) return `generation ${show(o.capture.ownerGeneration)}: no takeover`;
      return ok(captureProblem("exit-after-stage", o.capture));
    }],
  ],

  // Both steps (the drop, then the deletion and the retry) are judged together.
  "drop-outcome": [
    ["fault-scoped", "BROKER_FAULTS=drop-outcome on broker-c5d-drive for this phase, for the canary only", o => {
      const f = o.brokerFaults;
      if (!f) return "broker-c5d-drive's faults not observed";
      if (f.BROKER_FAULTS !== "drop-outcome") return `BROKER_FAULTS is ${show(f.BROKER_FAULTS)}`;
      return f.BROKER_FAULT_PRINCIPALS === o.uid ? true : `BROKER_FAULT_PRINCIPALS is ${show(f.BROKER_FAULT_PRINCIPALS)}, not the canary`;
    }],
    ["dropped", "the capture published and its outcome was dropped: a claim with evidence in the drive bucket, no outcome", o => {
      if (!o.claim || isAbsent(o.claim)) return `no claim for ${o.operationId ?? "the operation"}`;
      if (o.claim.evidence?.bucket !== DRIVE.bucket) return `the claim's evidence names ${show(o.claim.evidence?.bucket)}`;
      if (!isAbsent(o.outcomeAfterDrop)) return `an outcome was recorded (${show(o.outcomeAfterDrop)})`;
      // Policy's own terminal outcome for a dropped write: uncertain, never
      // completed or failed (aggregateStatus).
      if (o.capture?.status !== "uncertain") return `the command finished ${show(o.capture?.status)}, expected uncertain`;
      return isObject(o.objectAfterDrop) ? true : `nothing readable published (${show(o.objectAfterDrop)})`;
    }],
    ["staging-deleted", "the operator deleted the staged object after the dropped request finished, before the retry", o => {
      if (!isAbsent(o.stagedAfterDelete)) return `the staged object is ${show(o.stagedAfterDelete)}, not deleted`;
      const deleted = Date.parse(o.stagedDeletedAt ?? "");
      const finished = Date.parse(o.droppedFinishedAt ?? "");
      if (!Number.isFinite(deleted) || !Number.isFinite(finished)) return "the deletion's or the dropped request's time not observed";
      return deleted > finished ? true : "deleted before the dropped request finished";
    }],
    ["replayed", "the retry is the same command, nothing re-read or published twice", o => {
      if (o.retry?.commandId !== o.capture?.commandId) return `the retry answered ${show(o.retry?.commandId)}, not ${o.capture?.commandId}`;
      if (!isObject(o.objectAfterDrop) || !isObject(o.objectAfterRetry)) return "the object's generation isn't readable before and after the retry";
      if (o.objectAfterDrop.generation !== o.objectAfterRetry.generation) return `published again: ${o.objectAfterDrop.generation} -> ${o.objectAfterRetry.generation}`;
      const publishes = (o.executeSteps ?? []).filter(e => e.opid === o.operationId && e.event === "execute-step" && e.step === "publish");
      if (!Array.isArray(o.executeSteps)) return "Broker's execute-step records not observed";
      return publishes.length === 1 ? true : `${publishes.length} publish steps for ${o.operationId}, expected 1`;
    }],
    ["reconciled", "reconciliation resolves applied, with exactly the dropped operation's own result: its reserved item and sequence, staged digest and claim evidence", o => {
      const r = oneReservation(o.capture);
      const ev = o.claim?.evidence;
      if (!r || !ev) return "the reservation or the claim's evidence not observed";
      const expected = { item: r.item, captureSequence: r.captureSequence, sha256: r.sha256, url: thumbnailUrl({ bucket: ev.bucket, item: r.item, sha256: r.sha256 }) };
      for (const k of ["item", "captureSequence", "sha256"]) if (ev[k] !== expected[k]) return `the claim's evidence ${k} ${show(ev[k])} isn't the reservation's ${show(expected[k])}`;
      if (ev.object !== `${r.item}.png`) return `the claim's evidence object ${show(ev.object)}`;
      if (o.reconcile?.timedOut === true) return `reconciliation still too-early at its bound (${show(o.reconcile.attempts?.length)} attempts)`;
      const op = (o.reconcile?.operations ?? []).find(x => x.operationId === o.operationId);
      if (o.reconcile?.status !== 200 || !op) return `reconcile ${show(o.reconcile?.status)}: no result for ${o.operationId}`;
      if (op.verdict !== "applied" || op.final !== true) return `verdict ${show(op.verdict)}, final ${show(op.final)}`;
      for (const k of Object.keys(expected)) if (op.result?.[k] !== expected[k]) return `result ${k} ${show(op.result?.[k])}, expected ${show(expected[k])}`;
      const extra = Object.keys(op.result ?? {}).filter(k => !(k in expected));
      return extra.length ? `the result has extra fields: ${extra.join(", ")}` : true;
    }],
  ],

  "stale-worker": [
    ["faults-fired", "stop-renewal on the api worker and stall-before-stage on the compiler, both at generation 1", o => {
      const id = o.capture?.commandId;
      if (!(o.apiLines ?? []).some(l => l.text?.includes(`WARN command ${id}: fault stop-renewal at generation 1`))) return "no stop-renewal line at generation 1";
      return faultLine(o.l0013Lines, "stall-before-stage", id) ? true : "no stall-before-stage line";
    }],
    ["takeover-first", "generation 2's lease came before generation 1's next call, which the compiler observed as the takeover", o => {
      const id = o.capture?.commandId;
      const audit = (o.policyAudit ?? []).filter(e => e.commandId === id);
      const takeover = audit.find(e => e.event === "command-lease" && e.outcome === "allowed" && e.reason === "takeover");
      const stale = audit.filter(e => e.outcome === "denied" && e.reason === "stale-generation").sort((a, b) => at(a) - at(b))[0];
      if (!takeover || !Number.isFinite(at(takeover))) return "no takeover lease in Policy's audit";
      if (!stale || !Number.isFinite(at(stale))) return "no stale-generation refusal in Policy's audit";
      if (!(at(takeover) < at(stale))) return "the stale call came before the takeover";
      const lines = o.l0013Lines ?? [];
      if (lines.some(l => /no-takeover|probe unanswered at the bound/.test(l.text ?? ""))) return "the stall reached its bound";
      return lines.some(l => l.text?.includes("takeover observed")) ? true : "the compiler never observed the takeover";
    }],
    ["stage-refused", "the stalled worker's stage was refused as a stale generation", o =>
      ((o.policyAudit ?? []).some(e => e.commandId === o.capture?.commandId && e.event === "command-stage" && e.outcome === "denied" && e.reason === "stale-generation") ? true : "no command-stage refusal stale-generation")],
    ["generation-2-published", "the published sequence and digest are generation 2's", o => {
      const r = oneReservation(o.capture);
      if (!r) return "no single reservation";
      if (!Number.isSafeInteger(r.stagedGeneration) || r.stagedGeneration < 2) return `staged at generation ${show(r.stagedGeneration)}, not 2 or later`;
      return ok(captureProblem("stale-worker", o.capture));
    }],
    ["old-worker-finished-nothing", "the generation-1 api worker stopped, finishing nothing", o =>
      ((o.apiLines ?? []).some(l => l.text?.includes(`WARN command ${o.capture?.commandId}: stopped,`)) ? true : "no stopped line from the generation-1 worker")],
  ],

  "staging-gone": [
    ["fault-fired", "the target exited after staging, at generation 1, its reservation staged", o => {
      if (!faultLine(o.faultLines, "exit-after-stage", o.capture?.commandId)) return "no exit-after-stage line";
      return o.stagedAtExit?.state === "staged" && o.stagedAtExit?.stagedGeneration === 1 ? true : `at the exit: ${show(o.stagedAtExit)}`;
    }],
    ["deleted-before-claim", "the operator's deletion came before any claim: Broker refused, definitely, with no receipt", o => {
      if (!isAbsent(o.stagedAfterDelete)) return `the staged object is ${show(o.stagedAfterDelete)}`;
      return isAbsent(o.claim) ? true : `a claim exists (${show(o.claim)})`;
    }],
    ["failed-nothing-published", "the takeover didn't render, the command failed, nothing published", o => {
      if (!Number.isSafeInteger(o.renders)) return `the render count isn't readable (${show(o.renders)})`;
      if (o.renders !== 1) return `${o.renders} renders: the takeover rendered`;
      if (o.capture?.status !== "failed") return `the command is ${show(o.capture?.status)}, not failed`;
      return ok(first(objectRead("before", o.objectBefore), objectRead("after", o.objectAfter),
        sameObject(o.objectBefore, o.objectAfter) ? null : "the item's object changed"));
    }],
    ["fresh-capture", "a new capture, a new command, then succeeds", o =>
      ok(first(o.fresh?.commandId && o.fresh.commandId !== o.capture?.commandId ? null : "no new command", captureProblem("fresh", o.fresh)))],
  ],

  "older-after-newer": [
    ["older-stopped", "the older capture, the only target, exited after staging", o =>
      (faultLine(o.olderFaultLines, "exit-after-stage", o.older?.commandId) ? true : "no exit-after-stage line for the older")],
    ["newer-published", "the newer capture of the same item ran untargeted to completion", o => ok(first(
      captureProblem("newer", o.newer),
      faultLine(o.olderFaultLines, "exit-after-stage", o.newer?.commandId) ? "the newer was targeted" : null,
    ))],
    ["older-newer-present", "the older's takeover published nothing: newer-present, completed with its own result, the newer still published", o => {
      const older = oneReservation(o.older);
      const newer = oneReservation(o.newer);
      if (!older || !newer) return "a reservation not observed";
      if (!(older.captureSequence < newer.captureSequence)) return `older ${older.captureSequence}, newer ${newer.captureSequence}`;
      if (o.older?.status !== "completed") return `the older is ${show(o.older?.status)}`;
      if (!(o.olderSteps ?? []).some(s => s.step === "publish" && s.observed === "newer-present")) return "no publish step observed newer-present";
      if (o.older.result?.captureSequence !== older.captureSequence) return "the older's result isn't its own capture";
      if (!isObject(o.finalObject)) return `the final object isn't readable (${show(o.finalObject)})`;
      const m = o.finalObject.metadata ?? {};
      return m.commandId === o.newer.commandId && m.captureSequence === String(newer.captureSequence) ? true : `the final object is ${show(m)}, not the newer's`;
    }],
  ],

  "two-stage": [
    ["one-invocation", "a chain capturing two items, and identical snap programs in two stages, each one invocation with a scope per intent, staged by stage (test 6)", o => {
      for (const name of ["distinctItems", "sameProgram"]) {
        const c = o[name];
        if (!c || c.status !== "completed") return `${name}: ${show(c?.status)}`;
        const rs = c.reservations ?? [];
        if (rs.length !== 2) return `${name}: ${rs.length} reservations, expected 2`;
        if (new Set(rs.map(r => r.stage)).size !== 2) return `${name}: both reservations in one stage`;
        if (name === "distinctItems" && new Set(rs.map(r => r.item)).size !== 2) return "distinctItems: one item";
        if (rs.some(r => !isSha(r.sha256))) return `${name}: a reservation wasn't staged`;
      }
      return true;
    }],
  ],

  mixed: [
    ["one-invocation-own-scopes", "a capture plus an L0176 save is one invocation, each token carrying only its own scope (test 6)", o => {
      if (o.invocations !== 1) return `${show(o.invocations)} invocations`;
      const snap = (o.tokens ?? []).filter(t => t.fn === "snap");
      const save = (o.tokens ?? []).filter(t => t.fn === "save-to-itembank");
      if (!snap.length || !save.length) return `tokens ${show(o.tokens)}`;
      if (snap.some(t => JSON.stringify(t.scopeKinds) !== "[\"item\"]")) return "a snap token carries another scope";
      if (save.some(t => JSON.stringify(t.scopeKinds) !== "[\"connection\"]")) return "a save token carries another scope";
      return ok(captureProblem("mixed", o.capture));
    }],
  ],

  "non-owner": [
    ["refused", "a private item is refused for a non-owner at allocation (test 4); nothing reserved", o => {
      if (o.reason !== "not-owner") return `reason ${show(o.reason)}`;
      if (!Array.isArray(o.reservations)) return "reservations not observed";
      return o.reservations.length === 0 ? true : `${o.reservations.length} reservations`;
    }],
  ],

  "rate-limit": [
    ["quota", "with the item's earlier public captures in the window counted, exactly the remaining slots are allowed and the next is refused rate-limited, after them", o => {
      const prior = o.priorInWindow;
      if (!Number.isSafeInteger(prior) || prior < 0 || prior >= PUBLIC_CAPTURE_LIMIT) return `the item's public captures in the window aren't readable, or leave no slot (${show(prior)})`;
      const remaining = PUBLIC_CAPTURE_LIMIT - prior;
      if (o.attempted !== remaining + 1) return `${show(o.attempted)} attempted, expected ${remaining + 1}`;
      if (o.allowed !== remaining) {
        // More allowed than counted: an earlier capture left the hour's window
        // during the burst. That needs a fresh run, not an explanation.
        const edge = o.allowed > remaining ? "; an earlier capture may have left the window during the burst: rerun the phase in a fresh run" : "";
        return `${show(o.allowed)} allowed, expected ${remaining} (${prior} earlier in the window)${edge}`;
      }
      if (o.refused !== 1 || o.refusedAfterQuota !== true) return `refused ${show(o.refused)}, after the quota ${show(o.refusedAfterQuota)}`;
      return true;
    }],
    ["retired", "its commands are retired (C5a's fixtures-retired rule): none pending, none due", o => {
      const s = o.retired?.statuses;
      if (!s || !Object.keys(s).length || !Array.isArray(o.retired?.listedAfter)) return "the burst's statuses or the due query not observed";
      const open = Object.entries(s).filter(([, v]) => v === "pending");
      if (open.length) return `still pending: ${open.map(([k]) => k).join(", ")}`;
      return o.retired.listedAfter.length ? `still due: ${o.retired.listedAfter.join(", ")}` : true;
    }],
  ],

  "canary-snap": [
    ["passed", "canary.js --snap against api-c5d-drive passes, every check", o => {
      if (o.exitCode !== 0) return `exit ${show(o.exitCode)}`;
      const rs = o.results ?? [];
      const want = ["snap command", "snap url", "snap sequence", "snap command id", "snap retry"];
      const missing = want.filter(n => !rs.some(r => r.name === n));
      if (missing.length) return `not run: ${missing.join(", ")}`;
      const failed = rs.filter(r => !r.ok);
      return failed.length ? `failed: ${failed.map(r => r.name).join(", ")}` : true;
    }],
    ["command-recorded", "its command id is parsed from its output, and is the one planned and journaled", o => {
      if (typeof o.commandId !== "string" || !/^c:[0-9a-f]{64}$/.test(o.commandId)) return `no command id in canary.js's output (${show(o.commandId)})`;
      return o.commandId === o.expectedCommandId ? true : `canary.js ran ${o.commandId}, not the planned ${show(o.expectedCommandId)}`;
    }],
  ],

  boundary: [
    ["audit-complete", "the evidence is complete: every inventoried command read, every one of their invocations' claims read, no audit query truncated, and ingestion polled to coverage", o => {
      if (!Array.isArray(o.commands) || !o.commands.length) return "the drive's command inventory not observed";
      const unread = o.commands.filter(c => !(c.absent === true || typeof c.invocationId === "string"));
      if (unread.length) return `commands not read: ${unread.map(c => c.commandId).join(", ")}`;
      const claims = o.claimsByInvocation;
      if (!claims || typeof claims !== "object") return "the claims per invocation not observed";
      const missing = invocationsOf(o).filter(inv => !Array.isArray(claims[inv]));
      if (missing.length) return `claims not read for ${missing.join(", ")}`;
      if (!Array.isArray(o.queries) || !o.queries.length) return "the audit queries not observed";
      const bad = o.queries.filter(q => !Number.isSafeInteger(q.count) || !Number.isSafeInteger(q.limit) || q.count >= q.limit || q.nextPageToken);
      if (bad.length) return `audit queries truncated or unreadable: ${bad.map(q => q.query ?? "?").join("; ")}`;
      if (o.poll?.timedOut !== false) return `the audit poll ${o.poll?.timedOut ? "timed out before coverage" : "wasn't observed"}`;
      // Watched past coverage for the whole observation period, then every
      // record recollected over the drive's window (observeAudit).
      if (!(Number.isFinite(o.poll.observedMs) && o.poll.observedMs >= AUDIT_OBSERVATION_MS)) return `the audit was watched ${show(o.poll.observedMs)} ms after coverage, less than ${AUDIT_OBSERVATION_MS}`;
      if (o.poll.recollected !== true) return "the audit wasn't recollected over the whole window after the observation period";
      return true;
    }],
    ["drive-broker-executes", "every claimed operation of every drive invocation has broker-c5d-drive's execute evidence, and no execute or execute-step is any other Broker's", o => {
      const inv = new Set(invocationsOf(o));
      if (!inv.size || !Array.isArray(o.brokerAudit)) return "the drive's invocations or Broker's audit not observed";
      const ours = o.brokerAudit.filter(e => inv.has(e.invocationId));
      const executes = ours.filter(e => e.event === "execute" || e.event === "execute-step");
      const elsewhere = executes.filter(e => e.service !== DRIVE.broker);
      if (elsewhere.length) return `${elsewhere.length} executes by ${[...new Set(elsewhere.map(e => e.service))].join(", ")}`;
      const ops = [...inv].flatMap(i => o.claimsByInvocation?.[i] ?? []);
      if (!ops.length) return "no claimed operation for the drive";
      const uncovered = ops.filter(op => !executes.some(e => e.opid === op));
      return uncovered.length ? `no broker-c5d-drive execute evidence for ${uncovered.join(", ")}` : true;
    }],
    ["production-broker-bookkeeping", "production broker's records for drive invocations are only receipts and reconcile, and every reconcile read is accounted for, naming the drive bucket", o => {
      const inv = new Set(invocationsOf(o));
      const prod = (o.brokerAudit ?? []).filter(e => inv.has(e.invocationId) && e.service === "broker");
      const other = prod.filter(e => e.event !== "receipts" && e.event !== "reconcile");
      if (other.length) return `production broker ${[...new Set(other.map(e => e.event))].join(", ")}`;
      if (!Array.isArray(o.reconcileBuckets)) return "the reconcile reads' buckets not observed";
      const reads = prod.filter(e => e.event === "reconcile" && e.opid);
      const unaccounted = reads.filter(e => !o.reconcileBuckets.some(r => r.opid === e.opid));
      if (unaccounted.length) return `reconcile reads with no bucket read: ${unaccounted.map(e => e.opid).join(", ")}`;
      const wrong = o.reconcileBuckets.filter(r => r.bucket !== DRIVE.bucket);
      return wrong.length ? `reconcile read ${show(wrong)}` : true;
    }],
    ["thumbnails-unchanged", "graffiticode-thumbnails is unchanged from the run's one baseline and names no drive fixture", o => {
      const before = o.thumbnailsBefore;
      const after = o.thumbnailsAfter;
      if (!Array.isArray(before) || !Array.isArray(after) || !before.length || !after.length) return "a listing not observed";
      if ([...before, ...after].some(x => !isGeneration(x?.generation))) return "a listing entry has no readable generation";
      const key = l => JSON.stringify(l.map(x => [x.name, x.generation]).sort());
      if (key(before) !== key(after)) return "the listing changed";
      const named = (o.fixtures ?? []).filter(f => after.some(x => x.name === `${f}.png` && !before.some(y => y.name === x.name)));
      return named.length ? `new objects for ${named.join(", ")}` : true;
    }],
    ["drive-compilers", "every compiler call went to a drive compiler", o => {
      if (!Array.isArray(o.compilerCalls) || !o.compilerCalls.length) return "the api's compiler calls not observed";
      const other = o.compilerCalls.filter(c => c.service !== DRIVE.l0013r && c.service !== DRIVE.l0176r);
      return other.length ? `calls to ${[...new Set(other.map(c => c.service))].join(", ")}` : true;
    }],
  ],

  cleanup: [
    ["terminal", "every command the drive allocated (plan, journal, manifests) is terminal, each state named, and none is due", o => {
      if (!Array.isArray(o.commands) || !o.commands.length || !Array.isArray(o.due)) return "the drive's commands or the due query not observed";
      if (!Array.isArray(o.unresolvedIntents)) return "the journal's intents not observed";
      if (o.unresolvedIntents.length) return `journaled requests with no recorded command id: ${o.unresolvedIntents.join(", ")}; rerun --phase resolve-journal later (a late allocation may yet appear), or the owner decides`;
      const allocated = o.commands.filter(c => c.status !== "absent");
      // An aborted run (Step 32 §9: cleanup --aborted) allocated nothing: it
      // closes only when every inventoried id is absent in Policy, nothing is
      // due, and Policy's complete enumeration holds none of the run's
      // commands (policy-enumeration checks completeness). Otherwise an empty
      // drive never passes.
      if (!allocated.length) {
        if (o.aborted !== true) return "no allocated command found";
        if (o.due.some(id => o.commands.some(c => c.commandId === id))) return "aborted run: a command is due";
        if (!Array.isArray(o.policyEnumeration?.commands) || o.policyEnumeration.commands.length) return "aborted run: Policy's enumeration holds the run's commands";
        return true;
      }
      if (o.aborted === true) return `aborted run, but ${allocated.length} command(s) were allocated: close it as a run, not as aborted`;
      for (const c of allocated) {
        let done;
        try {
          done = isTerminal(c.status);
        } catch (e) {
          return `${c.commandId}: ${e.message}`;
        }
        if (!done) return `not terminal: ${c.commandId} ${c.status}`;
      }
      const due = o.due.filter(id => o.commands.some(c => c.commandId === id));
      return due.length ? `still due: ${due.join(", ")}` : true;
    }],
    ["policy-enumeration", "every command Policy holds for the run's drive tasks and principals since the run began is in the inventory, terminal and not due; every enumeration paged to its end", o => {
      const e = o.policyEnumeration;
      if (!e || !Array.isArray(e.queries) || !e.queries.length || !Array.isArray(e.commands)) return "Policy's enumeration not observed";
      const incomplete = e.queries.filter(q => q.complete !== true || !Number.isSafeInteger(q.pages) || q.pages < 1 || !Number.isSafeInteger(q.count));
      if (incomplete.length) return `enumeration incomplete or truncated: ${incomplete.map(q => q.query ?? "?").join("; ")}`;
      const inventoried = new Set((o.commands ?? []).map(c => c.commandId));
      const missing = e.commands.filter(c => !inventoried.has(c.commandId));
      if (missing.length) return `Policy holds commands the inventory lacks: ${missing.map(c => `${c.commandId} (${c.uid}, ${c.taskId}, ${c.createdAt}, ${c.status})`).join("; ")}`;
      for (const c of e.commands) {
        let done;
        try {
          done = isTerminal(c.status);
        } catch (err) {
          return `${c.commandId}: ${err.message}`;
        }
        if (!done) return `not terminal in Policy: ${c.commandId} ${c.status}`;
      }
      const due = (o.due ?? []).filter(id => e.commands.some(c => c.commandId === id));
      return due.length ? `still due: ${due.join(", ")}` : true;
    }],
  ],
});

// The phases the drive passes only if every one passes (slice 3); `checks`
// and `baseline` are their preconditions, judged too.
export const DRIVE_PHASES = Object.freeze(["checks", "access-probes", "baseline", "first-capture", "direct-refused", "exit-after-reserve", "exit-after-stage",
  "drop-outcome", "stale-worker", "staging-gone", "older-after-newer", "two-stage", "mixed", "non-owner", "rate-limit", "canary-snap", "boundary", "cleanup"]);

export const judgePhase = (phase, observations) => {
  const rows = PHASES[phase];
  if (!rows) throw new Error(`no such phase ${phase}`);
  const o = observations ?? {};
  const errors = Object.entries(o.errors ?? {});
  const checks = [
    ["observations-read", "every observation of the phase was read: no read failed", () =>
      (errors.length ? `reads failed: ${errors.map(([k, m]) => `${k} (${m})`).join("; ")}` : true)],
    ...rows,
  ].map(([id, title, check]) => {
    let result;
    try {
      result = check(o);
    } catch (e) {
      result = `not observed (${e?.message ?? e})`;
    }
    return { id, title, ok: result === true, detail: result === true ? "ok" : String(result) };
  });
  return { phase, passed: checks.every(c => c.ok), checks };
};

// The drive's verdict: every phase judged and passed.
export const verdict = phases => {
  const judged = DRIVE_PHASES.map(p => (phases?.[p] ? judgePhase(p, phases[p]) : { phase: p, passed: false, checks: [{ id: "run", title: "the phase ran", ok: false, detail: "not run" }] }));
  return { passed: judged.every(p => p.passed), phases: judged };
};

// ---------------------------------------------------------------- manifests

// The service a revision belongs to: `<service>-<rev>-<suffix>`, a service
// name holding dashes kept whole.
export const revisionService = revision => {
  if (typeof revision !== "string") return null;
  const parts = revision.split("-");
  return parts.length > 2 ? parts.slice(0, -2).join("-") : null;
};

// Evidence under docs/evidence/c5d/drive/<run>/: plan.json once per run, and
// each phase's run as `<phase>-<stamp>.json`, each created once with exclusive
// creation and never overwritten (a rerun writes its own). The two operator
// pauses (`drop-outcome-retry`, `staging-gone-delete`) write their own.
export const PLAN_FILE = "plan.json";
export const STEP_PHASES = Object.freeze(["drop-outcome-retry", "staging-gone-delete", "resolve-journal", "resolve-intent"]);

// A rerun of resolve-intent on an intent already resolved (its .id.json is
// write-once): the resolution recomputed now must be the recorded one, field
// for field apart from when it was written; then only the phase's manifest is
// written. Anything else is a problem, and nothing is rewritten.
// `gcloud storage ls --json gs://<bucket>/`'s output, from a run that exited 0:
// a JSON array of objects, or nothing at all for an empty bucket (live, Step 32
// run ad49c0ac, 2026-11-20: the drive bucket before its first capture). A
// failed read exits nonzero and never reaches here; any other output is not a
// listing and fails.
export const parseListing = (bucket, stdout) => {
  const text = String(stdout ?? "").trim();
  if (text === "") return [];
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    throw new Error(`gs://${bucket}: the listing isn't JSON`);
  }
  if (!Array.isArray(out)) throw new Error(`gs://${bucket}: the listing isn't a list`);
  return out.map(o => {
    if (typeof o?.url !== "string" || !o.url.startsWith(`gs://${bucket}/`)) throw new Error(`gs://${bucket}: a listing entry isn't this bucket's object`);
    return { name: o.url.replace(`gs://${bucket}/`, ""), generation: String(o.metadata?.generation ?? "") };
  });
};

export const confirmResolution = ({ recorded, recomputed }) => {
  if (!recorded?.noAllocation) return { problem: "the recorded resolution has no noAllocation" };
  if (!recomputed?.noAllocation) return { problem: "no resolution could be recomputed" };
  const same = JSON.stringify(recorded.noAllocation) === JSON.stringify(recomputed.noAllocation) && recorded.commandId === recomputed.commandId;
  return same ? { confirmed: true } : { problem: `the recorded resolution differs from the one recomputed now: ${JSON.stringify(recorded.noAllocation)} vs ${JSON.stringify(recomputed.noAllocation)}` };
};
export const stampOf = date => date.toISOString().replace(/[:.]/g, "-");
export const phaseFile = (phase, stamp) => {
  if (!PHASES[phase] && !STEP_PHASES.includes(phase)) throw new Error(`no such phase ${phase}`);
  if (!/^\d{4}-\d{2}-\d{2}T[0-9-]+Z$/.test(stamp)) throw new Error(`bad stamp ${stamp}`);
  return `${phase}-${stamp}.json`;
};
// The latest manifest of each phase among a run's files (names sort by stamp).
export const latestByPhase = files => {
  const latest = {};
  for (const f of [...files].sort()) {
    const m = /^([a-z0-9-]+?)-(\d{4}-\d{2}-\d{2}T[0-9-]+Z)\.json$/.exec(f);
    if (m) latest[m[1]] = f;
  }
  return latest;
};

// The run's one baseline (#446 review): a fixed name, created once, refused
// once any capture has begun; boundary and judge read only it.
export const BASELINE_FILE = "baseline.json";
export const JOURNAL_DIR = "journal";
// The phases that allocate commands: once one has a manifest, or anything is
// journaled, captures have begun.
export const CAPTURE_PHASES = Object.freeze(["first-capture", "direct-refused", "exit-after-reserve", "exit-after-stage", "drop-outcome", "drop-outcome-retry",
  "stale-worker", "staging-gone", "staging-gone-delete", "older-after-newer", "two-stage", "mixed", "non-owner", "rate-limit", "canary-snap"]);
export const baselineRefusal = ({ files, journal }) => {
  if (files.includes(BASELINE_FILE)) return `this run's baseline is fixed (${BASELINE_FILE}); start a new run`;
  const started = files.filter(f => CAPTURE_PHASES.some(p => f.startsWith(`${p}-`) && /\d{4}-\d{2}-\d{2}T/.test(f)));
  if (started.length || journal.length) return `captures have begun (${[...started, ...journal].slice(0, 3).join(", ")}): the baseline can't be taken now; start a new run`;
  return null;
};

// The journal: one write-once file per request, written before the request
// is sent. A keyed request's command id is known then (the non-owner's too,
// from its uid). An anonymous capture's key is the api's own, fresh per
// compile (bridge.js), so its id is known only from an answer:
//   <name>.id.json         a resolution: { commandId } or { commandId: null, noAllocation }
//   <name>.ambiguous.json  an answer that resolves nothing (kept as evidence)
export const journalName = name => {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad journal name ${name}`);
  return `${name}.json`;
};
export const journalIdName = name => `${name}.id.json`;
export const journalAmbiguousName = name => `${name}.ambiguous.json`;

// Policy's refusals before any command record is written (policy.ts
// allocateCommand: each `deny` before `commands.allocate`), as the api
// answers them, a 4xx naming the reason (routes/command.js `refused`).
// `unavailable` is excluded: a 503 can't be told from a failure after
// allocation. A rate limit (`rate-limited`) or an ownership refusal
// (`not-owner`) comes after allocation, at reserve or admission, and its
// answer names the command.
export const PRE_ALLOCATION_REFUSALS = Object.freeze(["caller-not-entry-point", "bad-request", "no-user", "worker-unsupported", "idempotency-key-reused"]);
// The api bridge's own refusals of an anonymous compile, each returned before
// its first allocating call, `run(true)` (packages/api/src/commands/bridge.js
// buildCommandBridge). An anonymous request has no held-key lookup (`held` is
// only for a user's key), so nothing before these can allocate:
//   policy-unavailable     no runner                      (bridge.js:205)
//   preflight-unavailable  a stage's preflight failed     (bridge.js:252)
//   worker-unsupported     no scopes on this api          (bridge.js:264)
//   connection-required    a write needs a connection     (bridge.js:272)
//   commands-not-enabled   a write's commands are off     (bridge.js:273, the verdict of :104)
//   bridge-retired         the bridge is off for the lang (bridge.js:292)
// The answer is the request's own: the api finished its work there, so it
// proves no command was allocated. Not listed: `legacy-protocol` (:260 needs
// a held key; :306 follows run(true)), and any Policy refusal from run(true)
// (:300), which may come after an allocation (a lease, a run).
export const BRIDGE_PRE_ALLOCATION_CODES = Object.freeze(["policy-unavailable", "preflight-unavailable", "worker-unsupported", "connection-required", "commands-not-enabled", "bridge-retired"]);
export const BRIDGE_SOURCE = "packages/api/src/commands/bridge.js";

const isRefusalBeforeAllocation = n => Boolean(n) && n.kind === "refusal" && Number.isInteger(n.status) && n.status >= 400 && n.status < 500 &&
  PRE_ALLOCATION_REFUSALS.includes(n.reason);
const isPreAllocationAnswer = n => Boolean(n) && n.kind === "pre-allocation-answer" && BRIDGE_PRE_ALLOCATION_CODES.includes(n.code) &&
  n.source === BRIDGE_SOURCE && typeof n.evidence === "string" && /\.(ambiguous|answer)\.json$/.test(n.evidence) && Number.isFinite(Date.parse(n.answeredAt ?? ""));
const provesNoAllocation = n => isRefusalBeforeAllocation(n) || isPreAllocationAnswer(n);

// The bridge's refusal code in an answer: a 200 compile envelope
// ({ status, data: { errors } } or { errors }) whose only error carries one of
// BRIDGE_PRE_ALLOCATION_CODES, and that names no command. Anything else: null.
export const bridgePreAllocationCode = ({ status, body }) => {
  if (status !== 200 || !body || typeof body !== "object") return null;
  const envelope = body.data && typeof body.data === "object" ? body.data : body;
  if (envelope.command || envelope.data !== undefined) return null;
  const errors = Array.isArray(envelope.errors) ? envelope.errors : null;
  if (!errors || errors.length !== 1) return null;
  return BRIDGE_PRE_ALLOCATION_CODES.includes(errors[0]?.code) ? errors[0].code : null;
};

// What an anonymous request's answer proves. { commandId } when it names its
// command; { commandId: null, noAllocation } for a refusal before
// allocation (Policy's 4xx, or the bridge's own pre-allocation answer, which
// needs its answeredAt and evidence file); null (ambiguous: a 5xx, a network
// error, an unparseable body, any other answer) otherwise.
export const answerResolution = ({ status = null, body = null, commandId = null, answeredAt = null, evidence = null }) => {
  if (typeof commandId === "string" && /^c:[0-9a-f]{64}$/.test(commandId)) return { commandId };
  const reason = body?.error?.reason;
  const noAllocation = { kind: "refusal", status, reason };
  if (isRefusalBeforeAllocation(noAllocation)) return { commandId: null, noAllocation };
  const code = bridgePreAllocationCode({ status, body });
  if (code && answeredAt && evidence) return { commandId: null, noAllocation: { kind: "pre-allocation-answer", code, answeredAt, evidence, source: BRIDGE_SOURCE } };
  return null;
};

// An ambiguous intent, resolved from its own saved answer (`resolve-intent`):
// the .ambiguous.json must carry a bridge pre-allocation code. Policy's
// enumeration for the task since the request was sent is a consistency
// check, not the proof: any anonymous candidate there refuses the
// resolution. Returns { resolution } or { problem }.
export const preAllocationResolution = ({ name, answer, candidates }) => {
  if (!answer || typeof answer !== "object") return { problem: `${name}: no saved answer` };
  const code = bridgePreAllocationCode({ status: answer.status, body: answer.body });
  if (!code) return { problem: `${name}: its saved answer carries no bridge pre-allocation code (${BRIDGE_PRE_ALLOCATION_CODES.join(", ")})` };
  if (!Number.isFinite(Date.parse(answer.answeredAt ?? ""))) return { problem: `${name}: its saved answer has no answeredAt` };
  if (!Array.isArray(candidates)) return { problem: `${name}: Policy's enumeration for its task not observed` };
  if (candidates.length) return { problem: `${name}: Policy holds anonymous commands for its task since it was sent (${candidates.map(c => c.commandId).join(", ")}): not resolved` };
  return { resolution: { commandId: null, noAllocation: { kind: "pre-allocation-answer", code, answeredAt: answer.answeredAt, evidence: journalAmbiguousName(name), source: BRIDGE_SOURCE } } };
};

// Ambiguous anonymous requests, correlated with Policy's command records
// (#446 third review). The api's work isn't bound to the client's connection
// (bridge.js awaits preflight and allocation with no cancellation), so a
// request can allocate long after its answer was lost: no time bound, and no
// empty result, ever proves it allocated nothing. Only a correlated id
// resolves an ambiguous intent:
//   - candidates: Policy's anonymous commands for its task created at or
//     after it was sent, with no upper bound, that no journal entry or
//     manifest already claims;
//   - an intent is assigned a candidate only when that candidate is its only
//     one and no other unresolved intent could own it; each assignment frees
//     the rest to be tried again;
//   - anything else stays unresolved (cleanup keeps failing).
// Each resolution carries its evidence: the command id, its createdAt and
// the query that found it.
export const correlateIntents = ({ intents, commands, claimed, anonymousSubject = "anonymous", query = null }) => {
  const taken = new Set(claimed);
  const open = intents.filter(i => typeof i.task === "string" && Number.isFinite(Date.parse(i.sentAt ?? "")));
  const candidatesOf = i => commands.filter(c => c.uid === anonymousSubject && c.taskId === i.task && !taken.has(c.commandId) &&
    Number.isFinite(Date.parse(c.createdAt ?? "")) && Date.parse(c.createdAt) >= Date.parse(i.sentAt));
  const resolutions = {};
  for (let changed = true; changed;) {
    changed = false;
    for (const i of open) {
      if (resolutions[i.name]) continue;
      const mine = candidatesOf(i);
      if (mine.length !== 1) continue;
      const [c] = mine;
      const rivals = open.filter(o => o !== i && !resolutions[o.name] && candidatesOf(o).some(x => x.commandId === c.commandId));
      if (rivals.length) continue;
      resolutions[i.name] = { commandId: c.commandId, resolvedBy: { kind: "policy-records", commandId: c.commandId, createdAt: c.createdAt, taskId: i.task, uid: anonymousSubject, from: i.sentAt, to: null, query } };
      taken.add(c.commandId);
      changed = true;
    }
  }
  return resolutions;
};

// Every command the drive may have allocated: the plan's deterministic ids,
// every journaled id, and every command id in a phase manifest. An intent
// is resolved only by an id, or by authoritative evidence that it allocated
// nothing (above); any other intent is reported, never dropped. A keyed
// intent carries its id, which cleanup reads in Policy's records: an absent
// record there is Policy's own proof that nothing was allocated.
export const inventory = ({ plan, journal, manifests }) => {
  const ids = new Map();
  const add = (id, source) => {
    if (typeof id === "string" && /^c:[0-9a-f]{64}$/.test(id)) ids.set(id, [...(ids.get(id) ?? []), source]);
  };
  for (const id of Object.values(plan?.ids ?? {})) add(id, "plan");
  const entries = new Map(journal.map(j => [j.file, j.value]));
  const unresolvedIntents = [];
  for (const [file, value] of entries) {
    if (file.endsWith(".id.json") || file.endsWith(".ambiguous.json") || file.endsWith(".answer.json")) continue;
    if (typeof value?.commandId === "string") {
      add(value.commandId, "journal");
      continue;
    }
    const answered = entries.get(file.replace(/\.json$/, ".id.json"));
    if (typeof answered?.commandId === "string") add(answered.commandId, "journal");
    else if (!provesNoAllocation(answered?.noAllocation)) unresolvedIntents.push(file);
  }
  // Ownership is explicit (#446 fourth and fifth reviews): only the plan's
  // ids and the journal's allocation and resolution records establish that a
  // command is the run's. Every request that can allocate one is journaled
  // before it is sent, and every correlation is journaled, so nothing a phase
  // saves needs to add to this. A manifest's ids are observations: what a
  // query found (cleanup's Policy enumeration, the sweeper's shared `due`
  // listing, which also names production's commands), never a claim. Read as
  // claims, a failed cleanup's own finding would hide a late command from the
  // next cleanup and from resolve-journal, and a production command in `due`
  // would join the drive's inventory. They are returned apart, as `observed`,
  // and the manifests are left as they are.
  const observed = new Set();
  const observe = v => {
    if (typeof v === "string" && /^c:[0-9a-f]{64}$/.test(v)) observed.add(v);
    else if (v && typeof v === "object") Object.values(v).forEach(observe);
  };
  manifests.forEach(observe);
  return {
    commandIds: [...ids.keys()].sort(),
    sources: Object.fromEntries(ids),
    unresolvedIntents: unresolvedIntents.sort(),
    observed: [...observed].filter(id => !ids.has(id)).sort(),
  };
};

// Reconciliation of a dropped outcome, polled (#446 review): Broker answers
// too-early until the claim's execution deadline and its grace have passed
// (reconcile.ts: readyAt = claimedAt + executionMs + RECONCILE_GRACE_MS).
// executionMs is at most 40 s (limits.ts: its token headroom forces it), the
// grace 60 s. too-early keeps waiting; any other answer ends the poll, for the
// check to judge; past the bound it times out.
export const MAX_EXECUTION_MS = 40_000;
export const RECONCILE_GRACE_MS = 60_000;
export const reconcilePoll = async ({ reconcile, operationId, claimedAt, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), intervalMs = 10_000, marginMs = 60_000 }) => {
  const claimed = Date.parse(claimedAt ?? "");
  if (!Number.isFinite(claimed)) throw new Error("the claim's time isn't readable");
  const bound = claimed + MAX_EXECUTION_MS + RECONCILE_GRACE_MS + marginMs;
  const attempts = [];
  for (;;) {
    const res = await reconcile();
    const op = (res?.operations ?? []).find(x => x.operationId === operationId) ?? null;
    attempts.push({ at: new Date(now()).toISOString(), status: res?.status ?? null, verdict: op?.verdict ?? null });
    if (res?.status !== 200 || op?.verdict !== "too-early") return { ...res, attempts, timedOut: false };
    if (now() + intervalMs > bound) return { ...res, attempts, timedOut: true };
    await sleep(intervalMs);
  }
};

// The quota phase's budget: the item's public captures still in Policy's
// window before the burst (command-records.ts reserve: a public capture is
// refused once `limit` of its timestamps are within `windowMs`).
export const PUBLIC_CAPTURE_WINDOW_MS = 60 * 60 * 1000;
export const priorPublicCaptures = (record, at, windowMs = PUBLIC_CAPTURE_WINDOW_MS) => {
  if (record?.absent === true) return 0;
  if (!Array.isArray(record?.publicCaptures)) throw new Error("the item's captures record has no publicCaptures");
  if (record.publicCaptures.some(t => !Number.isFinite(t))) throw new Error("a public capture's time isn't readable");
  return record.publicCaptures.filter(t => t > at - windowMs).length;
};

// Policy's gateway command routes as c5a-gate-fixtures.js's retireFixtures
// and verifyRetired use them, over `call(method, route, body)`.
export const policyFixtureClient = call => ({
  get: id => call("GET", `/v1/commands/${encodeURIComponent(id)}`),
  lease: (id, body) => call("POST", `/v1/commands/${encodeURIComponent(id)}/lease`, body),
  finish: (id, generation) => call("POST", `/v1/commands/${encodeURIComponent(id)}/finish`, { generation, result: null }),
  due: ({ scopes }) => call("GET", `/v1/commands-due?limit=50&recording=1&repairs=1${scopes ? "&scopes=1" : ""}`),
});

// The audit's observation period (#446 second review): after every claimed
// operation has its evidence, Broker's audit is watched this long more, then
// recollected whole over the drive's window, and every record is judged. A
// violation logged late (a production execute ingested after the controls)
// is then in what's judged. Five minutes: Cloud Logging's ingestion lag is
// the risk, and the C5a gate's audit reads, polled with a 180 s bound, all
// completed within it; five minutes is that bound and a margin. It is also
// far beyond Broker's longest operation (its 40 s execution deadline plus a
// 10 s provider call, limits.ts), so anything in flight at coverage has
// finished and been logged.
export const AUDIT_OBSERVATION_MS = 5 * 60_000;

// Polls `read` until `covered`, within `timeoutMs`; then keeps reading for
// AUDIT_OBSERVATION_MS; then reads once more, the recollection judged.
export const observeAudit = async ({ read, covered, timeoutMs, intervalMs = 15_000, observationMs = AUDIT_OBSERVATION_MS, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) => {
  const started = now();
  let attempts = 0;
  let value;
  for (;;) {
    value = await read();
    attempts++;
    if (covered(value)) break;
    if (now() - started + intervalMs > timeoutMs) return { value, poll: { attempts, timedOut: true, observedMs: 0, recollected: false } };
    await sleep(intervalMs);
  }
  const coveredAt = now();
  while (now() - coveredAt < observationMs) {
    await sleep(Math.min(intervalMs, observationMs - (now() - coveredAt)));
    value = await read();
    attempts++;
  }
  // The whole window, read again after the observation period: this is what's judged.
  value = await read();
  attempts++;
  return { value, poll: { attempts, timedOut: false, coveredAt: new Date(coveredAt).toISOString(), observedMs: now() - coveredAt, recollected: true } };
};

// Coverage: every claimed operation has the drive Broker's execute evidence
// in the queries read so far. Reaching it only starts the observation period.
export const auditCovered = (ops, driveBroker = DRIVE.broker) => queries =>
  ops.every(op => queries.some(q => (q.entries ?? []).some(e => e.opid === op && (e.event === "execute" || e.event === "execute-step") && e.service === driveBroker)));

// Policy's subject for an anonymous command (policy provenance.ts ANONYMOUS_SUBJECT).
export const ANONYMOUS_SUBJECT = "anonymous";

// Cleanup's enumeration of Policy's commands (#446 third review): the
// journal can't see a command the api allocated after its answer was lost,
// so cleanup reads Policy's own records too. Each query is one equality
// filter (taskId or uid, which Firestore's single-field indexes serve), read
// in pages ordered by document name; it is complete only when a page comes
// back shorter than the page size before maxPages. Anything else is
// truncated, and fails the check.
export const ENUMERATION_PAGE = 300;
export const ENUMERATION_MAX_PAGES = 200;
export const paginateAll = async ({ fetchPage, pageSize = ENUMERATION_PAGE, maxPages = ENUMERATION_MAX_PAGES }) => {
  const docs = [];
  let after = null;
  for (let pages = 1; pages <= maxPages; pages++) {
    const page = await fetchPage({ after, limit: pageSize });
    if (!Array.isArray(page)) throw new Error("a page isn't a list");
    docs.push(...page);
    if (page.length < pageSize) return { docs, pages, count: docs.length, complete: true };
    after = page.at(-1)?.name ?? null;
    if (!after) return { docs, pages, count: docs.length, complete: false };
  }
  return { docs, pages: maxPages, count: docs.length, complete: false };
};

// The run's commands among what the queries returned: created at or after
// the run began (no upper bound), and either on one of the run's drive tasks
// (any principal: canary, non-owner, anonymous) or by the non-owner, or the
// canary's L0013 commands (production makes none before activation, which
// follows the drive), or pinned to a drive compiler.
export const drivePolicyCommands = ({ records, since, tasks, principals }) => {
  const from = Date.parse(since);
  if (!Number.isFinite(from)) throw new Error("the run's start isn't readable");
  const taskSet = new Set(tasks);
  const byId = new Map();
  for (const r of records) {
    if (!r?.commandId || !(Date.parse(r.createdAt ?? "") >= from)) continue;
    const pinsDrive = (r.revisions ?? []).some(rev => [DRIVE.l0013r, DRIVE.l0176r].includes(revisionService(rev)));
    const ours = taskSet.has(r.taskId) || (principals.nonOwner && r.uid === principals.nonOwner) ||
      (r.uid === principals.canary && r.lang === "0013") || pinsDrive;
    if (ours) byId.set(r.commandId, { commandId: r.commandId, uid: r.uid, taskId: r.taskId, lang: r.lang ?? null, createdAt: r.createdAt, status: r.status });
  }
  return [...byId.values()].sort((a, b) => (a.commandId < b.commandId ? -1 : 1));
};

// A recognized pre-allocation answer, saved as its own evidence.
export const journalAnswerName = name => `${name}.answer.json`;

// A phase's exit status (#Step 32 correction): nonzero whenever any of its
// checks fails or any read failed. A phase judged in parts (drop-outcome and
// staging-gone, judged with their operator pause), or one that judges
// nothing itself (resolve-journal, resolve-intent, drop-outcome-retry),
// fails on any failed read.
export const PARTIAL_PHASES = Object.freeze(["drop-outcome", "staging-gone"]);
export const phaseExitCode = ({ phase, observations }) => {
  const readFailed = Object.keys(observations?.errors ?? {}).length > 0;
  if (DRIVE_PHASES.includes(phase) && !PARTIAL_PHASES.includes(phase)) return judgePhase(phase, observations).passed && !readFailed ? 0 : 1;
  return readFailed ? 1 : 0;
};

// The access probes' invalid credentials: a caller identity and a command
// session that aren't tokens at all, and a session shaped like Policy's (an
// ES256 JWT naming a command and a generation) whose signature is junk. None
// can verify: Google's certificates and Policy's keys sign nothing here.
export const ACCESS_PROBE_MALFORMED_IDENTITY = "not-a-token";
export const ACCESS_PROBE_MALFORMED_SESSION = "not-a-session";
const b64url = value => Buffer.from(JSON.stringify(value)).toString("base64url");
export const forgedSession = () => [
  b64url({ alg: "ES256", typ: "JWT", kid: "c5d-access-probe" }),
  b64url({ iss: "c5d-access-probe", cmd: `c:${"0".repeat(64)}`, fg: 1, stg: "s0", exp: 4_102_444_800 }),
  Buffer.from("not a signature").toString("base64url"),
].join(".");
