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
//              result: { item, captureSequence, sha256, url } | null,
//              reservations: [{ stage, occurrenceId, item, captureSequence, publicCapture,
//                               state, generation, sha256, stagedGeneration, stagedAt }],
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
//                      reconcile: { status, operations: [{ operationId, verdict, final, result }] },
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
//   rate-limit       { allowed, refused, refusedAfterQuota, retired: { statuses } }
//   canary-snap      { exitCode, results: [{ name, ok }] }
//   boundary         { invocations: [id], brokerAudit: audit, reconcileBuckets: [{ opid, bucket }],
//                      thumbnailsBefore: [{ name, generation }], thumbnailsAfter: [{ name, generation }],
//                      fixtures: [item], compilerCalls: [{ service }] }
//   cleanup          { commands: [{ commandId, status }], due: [commandId] }
//   errors           { <observation>: message }    a read that failed fails its phase

import { createHash } from "node:crypto";

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
  "staging-gone", "staging-gone-fresh", "older", "newer", "two-stage", "mixed",
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
  return { runId, uid, keys, ids, faults: { L0013_CAPTURE_FAULTS: l0013, API_COMMAND_FAULT_TARGETS: api } };
};

// A Cloud Run host's whole service name: `<service>-<hash>-<region>.a.run.app`
// or `<service>-<project number>.<region>.run.app`, either with `<tag>---`.
// A drive name holds dashes, so only the trailing segments are dropped.
export const runAppService = url => {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host.endsWith(".run.app")) return null;
  const rest = host.includes("---") ? host.split("---")[1] : host;
  const labels = rest.split(".");
  const parts = labels[0].split("-");
  const drop = labels[1] === "a" ? 2 : 1;
  return parts.length > drop ? parts.slice(0, -drop).join("-") : null;
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
  for (const url of [c.apiUrl, c.l0013rUrl].filter(Boolean)) {
    const service = runAppService(url);
    if (service && FORBIDDEN_SERVICES.includes(service)) return `${url} is ${service}'s: the drive never calls a production service`;
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
  const res = c.result;
  const prefix = `https://storage.googleapis.com/${bucket}/${r.item}.png?v=`;
  if (!res || typeof res.url !== "string" || !res.url.startsWith(prefix)) return `${name}: the result's url ${show(res?.url)} isn't under ${prefix}`;
  if (res.captureSequence !== r.captureSequence || res.sha256 !== r.sha256 || res.item !== r.item) return `${name}: the result ${show(res)} isn't the reserved capture`;
  return null;
};

const ok = problem => (problem || true);
const first = (...problems) => problems.find(Boolean) ?? null;

// ------------------------------------------------------------------- phases

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
    ["quota", "the 13th anonymous capture within the hour is refused rate-limited, after the quota's last allowed", o => {
      if (o.allowed !== PUBLIC_CAPTURE_LIMIT) return `${show(o.allowed)} allowed, expected ${PUBLIC_CAPTURE_LIMIT}`;
      if (!(o.refused >= 1) || o.refusedAfterQuota !== true) return `refused ${show(o.refused)}, after the quota ${show(o.refusedAfterQuota)}`;
      return true;
    }],
    ["retired", "its command is retired (C5a's fixtures-retired rule)", o => {
      const s = o.retired?.statuses;
      if (!s || !Object.keys(s).length) return "the burst's statuses not observed";
      const open = Object.entries(s).filter(([, v]) => v === "pending");
      return open.length ? `still pending: ${open.map(([k]) => k).join(", ")}` : true;
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
  ],

  boundary: [
    ["drive-broker-executes", "every execute and execute-step for a drive invocation is broker-c5d-drive's, none production broker's", o => {
      const inv = new Set(o.invocations ?? []);
      if (!inv.size || !Array.isArray(o.brokerAudit)) return "the drive's invocations or Broker's audit not observed";
      const ours = o.brokerAudit.filter(e => inv.has(e.invocationId));
      const executes = ours.filter(e => e.event === "execute" || e.event === "execute-step");
      if (!executes.length) return "no execute records for the drive";
      const elsewhere = executes.filter(e => e.service !== DRIVE.broker);
      return elsewhere.length ? `${elsewhere.length} executes by ${[...new Set(elsewhere.map(e => e.service))].join(", ")}` : true;
    }],
    ["production-broker-bookkeeping", "production broker's records for drive invocations are only receipts and reconcile, every reconcile read naming the drive bucket", o => {
      const inv = new Set(o.invocations ?? []);
      const prod = (o.brokerAudit ?? []).filter(e => inv.has(e.invocationId) && e.service === "broker");
      const other = prod.filter(e => e.event !== "receipts" && e.event !== "reconcile");
      if (other.length) return `production broker ${[...new Set(other.map(e => e.event))].join(", ")}`;
      if (!Array.isArray(o.reconcileBuckets)) return "the reconcile reads' buckets not observed";
      const wrong = o.reconcileBuckets.filter(r => r.bucket !== DRIVE.bucket);
      return wrong.length ? `reconcile read ${show(wrong)}` : true;
    }],
    ["thumbnails-unchanged", "graffiticode-thumbnails is unchanged across the drive and names no drive fixture", o => {
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
    ["terminal", "every command the drive allocated is terminal, and none is due", o => {
      if (!Array.isArray(o.commands) || !o.commands.length || !Array.isArray(o.due)) return "the drive's commands or the due query not observed";
      const open = o.commands.filter(c => !["completed", "failed"].includes(c.status));
      if (open.length) return `not terminal: ${open.map(c => `${c.commandId} ${c.status}`).join(", ")}`;
      const due = o.due.filter(id => o.commands.some(c => c.commandId === id));
      return due.length ? `still due: ${due.join(", ")}` : true;
    }],
  ],
});

// The phases the drive passes only if every one passes (slice 3); `checks`
// and `baseline` are their preconditions, judged too.
export const DRIVE_PHASES = Object.freeze(["checks", "baseline", "first-capture", "direct-refused", "exit-after-reserve", "exit-after-stage",
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
export const STEP_PHASES = Object.freeze(["drop-outcome-retry", "staging-gone-delete"]);
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
