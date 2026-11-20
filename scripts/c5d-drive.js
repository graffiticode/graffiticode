#!/usr/bin/env node
// C5d's staged drive (docs/c5d-snapshot-commands-plan.md, slice 3;
// docs/capability-policy-iam-review.md Step 32): captures as the canary
// account through api-c5d-drive -> l0013r-c5d-drive / l0176r-c5d-drive ->
// broker-c5d-drive, publishing only to gs://graffiticode-c5d-drive. Only
// scripts/lib/c5d-drive-checks.js judges; this collects.
//
//   node scripts/c5d-drive.js --phase plan                 [--run <id>]   offline: the run's keys, command ids and fault maps
//   node scripts/c5d-drive.js --phase <phase> --run <id>   [flags]        one phase, its manifest written once
//   node scripts/c5d-drive.js --phase judge   --run <id>                  the verdict over each phase's latest manifest
//
// Evidence: docs/evidence/c5d/drive/<run>/ (--dir to change the parent).
// plan.json and baseline.json are written once per run; each phase's run
// writes `<phase>-<stamp>.json`; every request that can allocate a command is
// journaled in journal/ before it is sent. All with exclusive creation: no
// evidence file is ever overwritten.
//
// It refuses to start unless every service and the bucket are the drive's own
// names (broker-c5d-drive, l0013r-c5d-drive, l0176r-c5d-drive, api-c5d-drive,
// gs://graffiticode-c5d-drive): never production's api, broker, policy,
// l0013r or l0176r, never B6's l0176r-drive or broker-faults, and never the
// graffiticode-thumbnails, graffiticode.appspot.com or staging bucket as the
// drive bucket. Every URL it sends to must be its role's own drive service,
// stable or tagged (#441's whole-name rule): a custom domain, or another
// service's URL, is refused before any request.
//
// What the runner does, and what the operator does (Step 32 holds every
// operator command, reviewed):
//   plan             runner: computes every key and command id from the canary
//                    uid and the run id (canary.js's too, by --run-id), and the
//                    two fault maps. Operator: releases l0013r-c5d-drive with
//                    L0013_CAPTURE_FAULTS and api-c5d-drive with
//                    API_COMMAND_FAULT_TARGETS set to them, once, before any
//                    capture; never changed during the run.
//   checks           runner, read-only: Step 32's verification (environments,
//                    /egress (the plan says /status; the route is /egress),
//                    the bucket's settings and IAM, the fault maps equal to
//                    plan.json's).
//   access-probes    runner, after checks and before baseline: the public drive
//                    compilers' own access control, live (Step 32 §7): a
//                    gateway's preflight answers a manifest (the control); no,
//                    malformed or non-gateway X-Caller-Identity is refused; a
//                    start with a malformed or forged command session is
//                    refused bad-session; the drive bucket and Policy are
//                    unchanged.
//   baseline         runner, read-only, once per run: graffiticode-thumbnails'
//                    listing into baseline.json; refused once any capture has
//                    begun. Every capture phase needs it.
//   first-capture    runner: the owner's private capture; an anonymous public one.
//   direct-refused   runner: POST /compile straight to l0013r-c5d-drive as
//                    api-run (A1b's refusal), the item's drive object read
//                    before and after.
//   exit-after-reserve, exit-after-stage
//                    runner: the targeted capture; it waits for the sweeper's
//                    takeover and reads the records, logs and counter.
//   drop-outcome     operator first: BROKER_FAULTS=drop-outcome and
//                    BROKER_FAULT_PRINCIPALS=<canary uid> on broker-c5d-drive
//                    (Step 32). Runner: refuses unless that is what's set, runs
//                    the capture until it is terminal (uncertain expected),
//                    records the claim and the dropped request's end, and
//                    prints the exact reviewed deletion of its staged object
//                    (Step 32, deletion 2). Then the operator deletes it.
//   drop-outcome-retry
//                    runner: verifies the staged object is gone, retries the
//                    command by its key, and reconciles as the console, polling
//                    while Broker answers too-early (bounded by its deadline and
//                    grace). Operator after: removes BROKER_FAULTS.
//   stale-worker     runner: the doubly targeted capture (stop-renewal and
//                    stall-before-stage); waits for it to finish; reads Policy's
//                    audit and both services' lines.
//   staging-gone     runner: the targeted capture; on its exit-after-stage line
//                    it prints the exact reviewed deletion (Step 32, deletion 1),
//                    waits (bounded) for the operator's deletion, then for the
//                    takeover's failure; then a fresh, untargeted capture.
//   older-after-newer, two-stage, mixed, non-owner
//                    runner, as slice 3 lists them.
//   rate-limit       runner: reads the public item's public captures still in
//                    Policy's window, then sends exactly one more anonymous
//                    capture than the slots left; retires the burst's commands.
//   canary-snap      runner: scripts/canary.js --snap against api-c5d-drive,
//                    with the planned --run-id; its command id is journaled
//                    before, and parsed from its output after.
//   resolve-journal  runner, read-only in Policy: each anonymous request whose
//                    answer was ambiguous (a 5xx, a network error, an
//                    unparseable body) is correlated with Policy's anonymous
//                    commands for its task created since it was sent, with no
//                    upper bound (the api's work outlives the client's
//                    connection). It is assigned the one candidate no journal
//                    entry, manifest or other intent claims; none, or more
//                    than one, leaves it unresolved: an empty result never
//                    proves no allocation. Rerun it later; cleanup fails
//                    until every intent is resolved or the owner decides.
//   resolve-intent   --name <intent>: an ambiguous anonymous intent whose own
//                    saved answer is the api bridge's refusal before any
//                    allocating call (BRIDGE_PRE_ALLOCATION_CODES, e.g.
//                    preflight-unavailable) is resolved as no allocation, its
//                    .ambiguous.json kept as the evidence. Policy's
//                    enumeration for its task since it was sent must hold no
//                    anonymous candidate (a consistency check, not the proof).
//   boundary        runner, read-only: every inventoried command (plan,
//                    journal, manifests), each invocation's Broker claims, and
//                    Broker's audit polled until every claim has its execute
//                    evidence (or the bound), each query checked for truncation;
//                    the thumbnails listing against baseline.json.
//   cleanup          runner, read-only: every inventoried command terminal
//                    (each state named), none due, no unresolved journal entry;
//                    and Policy's own enumeration (every command on the run's
//                    drive tasks, and every command of the canary and the
//                    non-owner, since the run began, each query paged to its
//                    end) all in the inventory, terminal and not due.
//   judge            the verdict; exit 1 unless every phase passed.
//
// Needs canary-window-c5d (Step 32): OpenIdTokenCreator on console-run (to
// call the private api-c5d-drive as the console does) and on api-run (Policy's
// gateway reads and l0013r-c5d-drive's direct compile). Policy's and Broker's
// databases, Cloud Logging and the buckets are read with the operator's own
// credentials. The non-owner phase reads C5D_NON_OWNER_TOKEN and takes that
// user's uid (--non-owner-uid), so its command id is known, and journaled,
// before the request.

import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeManifestOnce } from "./lib/c5b-thumbnails.js";
import {
  DRIVE, FIXTURES, STAGING_BUCKET, PUBLIC_CAPTURE_LIMIT, driveTargets, driveNamesProblem, driveUrlProblem, judgePhase, verdict,
  stagedObject, operationIdOf, revisionService, PLAN_FILE, BASELINE_FILE, JOURNAL_DIR, CAPTURE_PHASES, phaseFile, stampOf,
  latestByPhase, DRIVE_PHASES, baselineRefusal, journalName, journalIdName, journalAmbiguousName, inventory, isTerminal, reconcilePoll,
  priorPublicCaptures, policyFixtureClient, answerResolution, correlateIntents, paginateAll, drivePolicyCommands, observeAudit, auditCovered, commandIdFor, ANONYMOUS_SUBJECT,
  bridgePreAllocationCode, preAllocationResolution, journalAnswerName, phaseExitCode, ACCESS_PROBE_MALFORMED_IDENTITY, ACCESS_PROBE_MALFORMED_SESSION, forgedSession, confirmResolution, parseListing, directCompileRequest, isRenderLine, RECOUNTABLE, recountManifest, recountSource, observeCount, AUDIT_OBSERVATION_MS,
} from "./lib/c5d-drive-checks.js";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const PHASE_NAMES = ["plan", "checks", "access-probes", "baseline", "first-capture", "direct-refused", "exit-after-reserve", "exit-after-stage", "drop-outcome", "drop-outcome-retry",
  "stale-worker", "staging-gone", "older-after-newer", "two-stage", "mixed", "non-owner", "rate-limit", "canary-snap", "resolve-journal", "resolve-intent", "recount-renders", "boundary", "cleanup", "judge"];
const phase = flag("--phase");
if (!PHASE_NAMES.includes(phase)) {
  console.error(`usage: c5d-drive.js --phase <${PHASE_NAMES.join("|")}> --run <id> [flags]`);
  process.exit(2);
}
const config = {
  broker: flag("--broker", DRIVE.broker),
  l0013r: flag("--l0013r", DRIVE.l0013r),
  l0176r: flag("--l0176r", DRIVE.l0176r),
  api: flag("--api", DRIVE.api),
  bucket: flag("--bucket", DRIVE.bucket),
  apiUrl: flag("--api-url"),
};
// Before anything else, and before any network call.
const refused = driveNamesProblem(config);
if (refused) {
  console.error(`refused: ${refused}`);
  process.exit(2);
}
const uid = flag("--uid", "995cc0bc98105563168b7fbee7b1e59a4256331c");
const connectionId = flag("--connection", "conn-686c62bc-b447-4dd8-bba8-60fd2b7a3cfd");
const project = flag("--project", "graffiticode");
const region = flag("--region", "us-central1");
const consoleAccount = flag("--console-account", "console-run@graffiticode-app.iam.gserviceaccount.com");
const gatewayAccount = flag("--gateway-account", "api-run@graffiticode.iam.gserviceaccount.com");
const waitMs = Number(flag("--wait-ms", "600000"));
const auditTimeoutMs = Number(flag("--audit-timeout-ms", "300000"));
const runId = phase === "plan" ? flag("--run", randomBytes(4).toString("hex")) : flag("--run");
if (!runId || !/^[a-z0-9]{4,32}$/.test(runId)) {
  console.error("--run <id> (4-32 lowercase letters and digits) is required");
  process.exit(2);
}
const dir = path.join(flag("--dir", new URL("../docs/evidence/c5d/drive", import.meta.url).pathname), runId);
const journalDir = path.join(dir, JOURNAL_DIR);
mkdirSync(journalDir, { recursive: true });
const writeOnce = (file, value) => writeManifestOnce(path.join(dir, file), value);
const readJson = file => JSON.parse(readFileSync(path.join(dir, file), "utf8"));
const journalFiles = () => readdirSync(journalDir).filter(f => f.endsWith(".json")).sort();

// ------------------------------------------------------------------- plan

if (phase === "plan") {
  const targets = driveTargets({ uid, runId });
  const file = writeOnce(PLAN_FILE, { at: new Date().toISOString(), config, ...targets });
  console.log(`plan for run ${runId}: ${file}`);
  console.log(`l0013r-c5d-drive  L0013_CAPTURE_FAULTS='${JSON.stringify(targets.faults.L0013_CAPTURE_FAULTS)}'`);
  console.log(`api-c5d-drive     API_COMMAND_FAULT_TARGETS='${JSON.stringify(targets.faults.API_COMMAND_FAULT_TARGETS)}'`);
  process.exit(0);
}
if (!existsSync(path.join(dir, PLAN_FILE))) {
  console.error(`no ${PLAN_FILE} for run ${runId}: run --phase plan first`);
  process.exit(2);
}
const plan = readJson(PLAN_FILE);
// The same uid and run must give the same targets the services were set with.
if (JSON.stringify(driveTargets({ uid, runId }).faults) !== JSON.stringify(plan.faults)) {
  console.error(`the targets for --uid ${uid} differ from ${PLAN_FILE}'s`);
  process.exit(2);
}
// The baseline once, before any capture; every capture phase after it.
if (phase === "baseline") {
  const problem = baselineRefusal({ files: readdirSync(dir), journal: journalFiles() });
  if (problem) {
    console.error(`refused: ${problem}`);
    process.exit(2);
  }
}
if (CAPTURE_PHASES.includes(phase) && !existsSync(path.join(dir, BASELINE_FILE))) {
  console.error(`refused: no ${BASELINE_FILE}: run --phase baseline first`);
  process.exit(2);
}

// ------------------------------------------------------------------ judge

if (phase === "judge") {
  const latest = latestByPhase(readdirSync(dir));
  const phases = {};
  // The run's one baseline, never a later file.
  if (existsSync(path.join(dir, BASELINE_FILE))) phases.baseline = readJson(BASELINE_FILE).observations;
  for (const p of DRIVE_PHASES) {
    if (p === "baseline" || !latest[p]) continue;
    phases[p] = readJson(latest[p]).observations;
    // Each operator pause's own observations join its phase's.
    const step = { "drop-outcome": "drop-outcome-retry", "staging-gone": "staging-gone-delete" }[p];
    if (step && latest[step]) {
      const extra = readJson(latest[step]).observations;
      phases[p] = { ...phases[p], ...extra, errors: { ...(phases[p].errors ?? {}), ...(extra.errors ?? {}) } };
    }
  }
  // boundary is judged against baseline.json, whatever its manifest says.
  if (phases.boundary) phases.boundary = { ...phases.boundary, thumbnailsBefore: phases.baseline?.thumbnails };
  const result = verdict(phases);
  for (const p of result.phases) for (const c of p.checks) console.log(`${c.ok ? "ok    " : "FAILED"} ${p.phase}/${c.id}: ${c.detail}`);
  const file = writeOnce(`report-${stampOf(new Date())}.json`, { runId, at: new Date().toISOString(), manifests: { baseline: BASELINE_FILE, ...latest }, ...result });
  console.log(`${result.passed ? "DRIVE PASSED" : "DRIVE NOT PASSED"}; ${file}`);
  process.exit(result.passed ? 0 : 1);
}

// --------------------------------------------------------------- the cloud

const { createCanaryEnv, loadDeployServices, http, routedRevision, revisionEnv } = await import("./lib/canary-env.js");
const { runCapturing } = await import("./lib/c5a-gate-reads.js");
const { retireFixtures, verifyRetired } = await import("./lib/c5a-gate-fixtures.js");
const { rateLimitFromAudit, policyReserveFilter, pollUntil, reservesCover, tokensFromAudit } = await import("./lib/c5a-gate-checks.js");
const deploy = await loadDeployServices();
const policyUrl = deploy.api.env.POLICY_URL;
const { gcloud, serviceUrl, accessToken, idToken } = createCanaryEnv({ uid, project, region, authUrl: deploy.api.env.AUTH_URL });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const observations = { uid, errors: {} };
const collect = async (key, read) => {
  try {
    observations[key] = await read();
  } catch (e) {
    observations.errors[key] = String(e?.message ?? e).slice(0, 300);
    console.log(`FAILED to observe ${key}: ${observations.errors[key]}`);
  }
};
const finish = extra => {
  const file = writeOnce(phaseFile(phase, stampOf(new Date())), { runId, phase, at: new Date().toISOString(), ...extra, observations });
  if (DRIVE_PHASES.includes(phase) && !["drop-outcome", "staging-gone"].includes(phase)) {
    const judged = judgePhase(phase, observations);
    for (const c of judged.checks) console.log(`${c.ok ? "ok    " : "FAILED"} ${c.id}: ${c.detail}`);
  }
  // A failed check or read fails the phase's exit status, not just its output.
  const code = phaseExitCode({ phase, observations });
  if (code) process.exitCode = code;
  console.log(`${phase}: ${file}${code ? " (FAILED)" : ""}`);
};
// One write-once journal entry per request, before it is sent.
const journal = (name, value) => writeManifestOnce(path.join(journalDir, journalName(name)), { at: new Date().toISOString(), ...value });
// A resolution: { commandId } or { commandId: null, noAllocation } (c5d-drive-checks.js).
const journalId = (name, resolution) => writeManifestOnce(path.join(journalDir, journalIdName(name)), { at: new Date().toISOString(), ...resolution });

// The operator's reads.
let operatorToken;
const asOperator = async () => ({ Authorization: `Bearer ${(operatorToken ??= await gcloud(["auth", "print-access-token"]))}` });
const decode = v => {
  if (v === undefined || v === null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decode);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)]));
  return null;
};
const firestore = (database, docPath) => `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents/${docPath}`;
const doc = async (database, docPath) => {
  const res = await http({ method: "GET", url: firestore(database, docPath), headers: await asOperator() });
  if (res.status === 404) return { absent: true };
  if (res.status !== 200) throw new Error(`Firestore ${database}/${docPath}: ${res.status}`);
  return decode({ mapValue: res.json });
};
const docs = async (database, collectionPath) => {
  const out = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ pageSize: "300", ...(pageToken ? { pageToken } : {}) });
    const res = await http({ method: "GET", url: `${firestore(database, collectionPath)}?${q}`, headers: await asOperator() });
    if (res.status !== 200) throw new Error(`Firestore ${database}/${collectionPath}: ${res.status}`);
    out.push(...(res.json?.documents ?? []).map(d => decode({ mapValue: d })));
    pageToken = res.json?.nextPageToken ?? "";
  } while (pageToken);
  return out;
};
const receiptDoc = (operationId, sub = "") => doc("broker", `receipts/${createHash("sha256").update(operationId).digest("hex")}${sub}`);
// Broker's claims for one invocation: every receipt whose operation id is under it.
const claimsOf = async invocationId => {
  const range = (op, value) => ({ fieldFilter: { field: { fieldPath: "operationId" }, op, value: { stringValue: value } } });
  const where = { compositeFilter: { op: "AND", filters: [range("GREATER_THAN_OR_EQUAL", `${invocationId}/`), range("LESS_THAN", `${invocationId}/`)] } };
  const res = await http({ method: "POST", url: `https://firestore.googleapis.com/v1/projects/${project}/databases/broker/documents:runQuery`, headers: await asOperator(), body: { structuredQuery: { from: [{ collectionId: "receipts" }], where } } });
  if (res.status !== 200 || !Array.isArray(res.json)) throw new Error(`Firestore broker receipts for ${invocationId}: ${res.status}`);
  return res.json.filter(r => r.document).map(r => decode({ mapValue: r.document }).operationId).sort();
};
// Policy's commands where one field equals a value, every page, ordered by
// document name (c5d-drive-checks.js paginateAll: complete only when a page
// comes back short of the page size).
const policyCommandsWhere = async (field, value) => {
  const fetchPage = async ({ after, limit }) => {
    const structuredQuery = {
      from: [{ collectionId: "commands" }],
      where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: value } } },
      orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
      limit,
      ...(after ? { startAt: { values: [{ referenceValue: after }], before: false } } : {}),
    };
    const res = await http({ method: "POST", url: `https://firestore.googleapis.com/v1/projects/${project}/databases/policy/documents:runQuery`, headers: await asOperator(), body: { structuredQuery } });
    if (res.status !== 200 || !Array.isArray(res.json)) throw new Error(`Policy's commands where ${field} = ${value}: ${res.status}`);
    return res.json.filter(r => r.document).map(r => ({ name: r.document.name, ...decode({ mapValue: r.document }) }));
  };
  const page = await paginateAll({ fetchPage });
  const records = page.docs.map(d => ({
    commandId: d.commandId,
    uid: d.uid,
    taskId: d.taskId,
    lang: d.lang ?? null,
    createdAt: d.createdAt,
    status: d.status,
    revisions: Object.values(d.admission?.stages ?? {}).map(s => s.revision),
  }));
  return { query: `policy commands where ${field} == ${value}`, pages: page.pages, count: page.count, complete: page.complete, records };
};
// Cloud Logging, with the limit kept: a read that reaches it is truncated.
const LOG_LIMIT = 1000;
const logs = async (filter, limit = LOG_LIMIT) => {
  const out = await gcloud(["logging", "read", filter, `--limit=${limit}`, "--format=json", "--order=asc"]);
  return out ? JSON.parse(out) : [];
};
const lines = async (service, text, since) => (await logs([
  "resource.type=\"cloud_run_revision\"", `resource.labels.service_name="${service}"`, `timestamp>="${since}"`, `textPayload:"${text}"`,
].join(" AND "))).map(e => ({ at: e.timestamp, text: e.textPayload }));
const auditQuery = async (service, query, since) => {
  const filter = ["resource.type=\"cloud_run_revision\"", `resource.labels.service_name="${service}"`, "jsonPayload.logName=\"security_audit\"", `timestamp>="${since}"`, query].join(" AND ");
  const entries = await logs(filter);
  return { query: `${service}: ${query}`, count: entries.length, limit: LOG_LIMIT, entries: entries.map(e => ({ at: e.timestamp, service, ...e.jsonPayload })) };
};
const auditOf = async (service, query, since) => (await auditQuery(service, query, since)).entries;
// An object's generation and metadata, or { absent: true } for gcloud's 404 only.
const objectOf = async (bucket, name) => {
  try {
    const meta = JSON.parse(await runCapturing("gcloud", ["storage", "objects", "describe", `gs://${bucket}/${name}`, "--format=json", `--project=${project}`]));
    return { generation: String(meta.generation), metadata: meta.custom_fields ?? meta.metadata ?? {} };
  } catch (e) {
    if (/not found|404/i.test(e?.stderr ?? "")) return { absent: true };
    throw e;
  }
};
// runCapturing throws on a nonzero exit (a missing bucket, a refused read), so
// what reaches parseListing exited 0.
const listing = async bucket => parseListing(bucket, await runCapturing("gcloud", ["storage", "ls", "--json", `gs://${bucket}/`, `--project=${project}`]));
const servedEnv = async service => {
  const described = JSON.parse(await gcloud(["run", "services", "describe", service, `--region=${region}`, "--format=json"]));
  const revision = routedRevision(described, null);
  if (!revision) throw new Error(`${service}: no revision serves 100%`);
  return { revision, env: revisionEnv(JSON.parse(await gcloud(["run", "revisions", "describe", revision, `--region=${region}`, "--format=json"]))) };
};
// A drive service's URL, resolved, then held to its role before any request.
const driveUrl = async role => {
  const url = await serviceUrl(config[role]);
  const problem = driveUrlProblem(role, url);
  if (problem) throw new Error(`refused: ${problem}`);
  return url;
};

// The api-c5d-drive calls, as the console makes them: console-run's ID token,
// whose audience is the service's stable URL (Cloud Run requires it, tag URL
// or not), and the user's token.
const apiAudience = await driveUrl("api");
const apiUrl = config.apiUrl ?? apiAudience;
let canaryToken = null;
let canaryAt = 0;
const canary = async () => {
  if (Date.now() - canaryAt > 2 * 60_000) [canaryToken, canaryAt] = [await accessToken(), Date.now()];
  return canaryToken;
};
const asConsole = async user => ({ "X-Serverless-Authorization": `Bearer ${await idToken(consoleAccount, apiAudience)}`, ...(user ? { Authorization: user } : {}) });
const need = name => {
  const v = flag(name);
  if (!v) throw new Error(`${name} is required for --phase ${phase}`);
  return v;
};
const key = name => plan.keys[name];
const ids = plan.ids;
const since = new Date().toISOString();
// A keyed command: journaled with its planned id before the request.
const command = async ({ name, task, user, connection = null }) => {
  journal(name, { kind: "keyed", key: key(name), commandId: ids[name], task });
  const res = await http({ method: "POST", url: `${apiUrl}/command`, headers: await asConsole(user), body: { id: task, idempotencyKey: key(name), ...(connection ? { connectionId: connection } : {}) } });
  return { status: res.status, commandId: res.json?.data?.commandId ?? null, outcome: res.json?.data?.outcome ?? null, reason: res.json?.data?.reason ?? res.json?.error?.reason ?? null };
};
// An anonymous capture through the bridge: its id isn't known until answered,
// so the intent is journaled first and the id after; one never answered
// stays an unresolved intent, which fails cleanup.
const anonymousCompile = async (name, task) => {
  const sentAt = new Date().toISOString();
  journal(name, { kind: "anonymous", task, commandId: null, sentAt });
  let res = null;
  let failure = null;
  try {
    res = await http({ method: "POST", url: `${apiUrl}/compile`, headers: await asConsole(null), body: { id: task } });
  } catch (e) {
    failure = String(e?.message ?? e).slice(0, 300);
  }
  const answeredAt = new Date().toISOString();
  const commandId = (res?.json?.data ?? res?.json)?.command?.commandId ?? null;
  // Resolved only by its id or a refusal before allocation; anything else
  // (a 5xx, a network error, an unparseable body) stays unresolved, its
  // answer kept, until Policy's records resolve it (--phase resolve-journal).
  // The bridge's own refusal before allocation (bridgePreAllocationCode) is
  // saved as its evidence, which the resolution names.
  if (res && !commandId && bridgePreAllocationCode({ status: res.status, body: res.json })) {
    writeManifestOnce(path.join(journalDir, journalAnswerName(name)), { task, sentAt, answeredAt, status: res.status, body: res.json });
  }
  const resolution = res ? answerResolution({ status: res.status, body: res.json, commandId, answeredAt, evidence: journalAnswerName(name) }) : null;
  if (resolution) journalId(name, { ...resolution, status: res.status });
  else writeManifestOnce(path.join(journalDir, journalAmbiguousName(name)), { task, sentAt, answeredAt, status: res?.status ?? null, failure, body: res?.json ?? null });
  return { status: res?.status ?? null, commandId };
};
// Policy's gateway routes (canary-window-c5d covers api-run).
const asGateway = async () => ({
  "X-Serverless-Authorization": `Bearer ${await idToken(gatewayAccount, policyUrl)}`,
  "X-Caller-Identity": await idToken(gatewayAccount, "urn:graffiticode:policy"),
});
const gateway = async (method, route, body) => {
  const res = await http({ method, url: `${policyUrl}${route}`, headers: await asGateway(), body });
  if (res.status !== 200 || res.json?.status !== "success") throw Object.assign(new Error(`policy ${method} ${route}: ${res.status} ${res.json?.error?.reason ?? ""}`), { reason: res.json?.error?.reason ?? null });
  return res.json.data;
};
const asConsoleToPolicy = async () => ({
  "X-Serverless-Authorization": `Bearer ${await idToken(consoleAccount, policyUrl)}`,
  "X-Caller-Identity": await idToken(consoleAccount, "urn:graffiticode:policy"),
  Authorization: await canary(),
});

// A command's capture observation (c5d-drive-checks.js "capture"): Policy's
// record, reservations and result (L0013's { item, url }), Broker's claim of
// its first reservation, and the drive bucket's object.
const captureOf = async commandId => {
  if (!commandId) throw new Error("no command id");
  const id = encodeURIComponent(commandId);
  const record = await doc("policy", `commands/${id}`);
  if (record.absent) throw new Error(`no command record ${commandId}`);
  const reservations = await docs("policy", `commands/${id}/reservations`);
  let result = null;
  if (record.result?.state === "available") {
    const read = await gateway("GET", `/v1/commands/${id}/records/result`);
    result = JSON.parse(read.result?.text ?? "null");
  }
  const first = reservations[0];
  return {
    commandId,
    status: record.status,
    ownerGeneration: record.owner?.generation ?? null,
    invocationId: record.invocationId,
    admission: record.admission ?? null,
    result,
    reservations,
    claim: first ? await receiptDoc(operationIdOf(record.invocationId, first)) : { absent: true },
    object: first ? await objectOf(config.bucket, `${first.item}.png`) : { absent: true },
  };
};
// Until the command is terminal: each of Policy's states by name (isTerminal;
// an unknown status stops the run), bounded.
const terminal = async commandId => {
  const { value, timedOut } = await pollUntil({
    read: () => doc("policy", `commands/${encodeURIComponent(commandId)}`),
    done: r => r?.absent !== true && isTerminal(r?.status),
    timeoutMs: waitMs,
    intervalMs: 5_000,
  });
  if (timedOut) throw new Error(`${commandId} still ${value?.status ?? "absent"} after ${waitMs} ms`);
  return value;
};
const counterOf = async item => doc("policy", `item-captures/${encodeURIComponent(item)}`);
const faultLines = (commandId, from) => lines(config.l0013r, "capture fault", from).then(ls => ls.filter(l => l.text.includes(commandId)));
// The compiler's `render` lines name the item, not the command (crates/capture
// render(): "render item=<item> ..."), so a phase counts its item's renders in
// its own window, while no other capture of that item runs. The lines carry
// ANSI codes inside the field, so they are queried by the item id (plain in
// the line) and matched without the codes (isRenderLine). The count is
// watched for AUDIT_OBSERVATION_MS after the first render is ingested
// (observeCount), so a later render from the window is counted.
const rendersOnce = async (item, from, to) => (await lines(config.l0013r, item, from))
  .filter(l => isRenderLine(l.text, item) && (to === null || Date.parse(l.at) < Date.parse(to))).length;
const rendersObserved = (item, from, to = null) => observeCount({
  read: () => rendersOnce(item, from, to), observeMs: AUDIT_OBSERVATION_MS, sleep, now: () => Date.now(),
});
const rendersOf = async (item, from, to = null) => (await rendersObserved(item, from, to)).count;
// Every command the drive may have allocated (c5d-drive-checks.js inventory).
const driveInventory = () => inventory({
  plan,
  journal: journalFiles().map(f => ({ file: f, value: JSON.parse(readFileSync(path.join(journalDir, f), "utf8")) })),
  manifests: readdirSync(dir).filter(f => f.endsWith(".json") && f !== PLAN_FILE && !f.startsWith("report-")).map(readJson),
});

// ----------------------------------------------------------------- phases

if (phase === "checks") {
  const services = {};
  for (const [role, name] of Object.entries({ broker: config.broker, l0013r: config.l0013r, l0176r: config.l0176r, api: config.api })) {
    await collect(`env:${role}`, async () => (services[role] = await servedEnv(name)));
  }
  observations.services = services;
  observations.targets = plan.faults;
  await collect("l0013rStatus", async () => {
    const url = await driveUrl("l0013r");
    const res = await http({ method: "GET", url: `${url}/egress`, headers: { Authorization: `Bearer ${await idToken(gatewayAccount, url)}` } });
    if (res.status !== 200) throw new Error(`/egress ${res.status}`);
    const bucket = res.json?.language?.thumbnailBucket;
    if (bucket === undefined) throw new Error("/egress names no language.thumbnailBucket");
    return { thumbnailBucket: bucket };
  });
  await collect("bucket", async () => {
    const d = JSON.parse(await gcloud(["storage", "buckets", "describe", `gs://${config.bucket}`, "--format=json"]));
    const policy = JSON.parse(await gcloud(["storage", "buckets", "get-iam-policy", `gs://${config.bucket}`, "--format=json"]));
    return { settings: { uniform: d.uniform_bucket_level_access === true, publicAccessPrevention: d.public_access_prevention ?? null }, bindings: policy.bindings ?? [] };
  });
  finish();
}

if (phase === "access-probes") {
  // The public drive compilers' own access control, live (Step 32 §7;
  // c5d-drive-checks.js ACCESS_PROBES): a gateway's preflight works, nothing
  // else's does, and a start without a session Policy signed is refused.
  const { snapTask, COMMAND_PROGRAM } = await import("./lib/canary.js");
  const { parser } = await import("@graffiticode/parser");
  const policyState = async () => {
    const q = await policyCommandsWhere("uid", uid);
    const itemCaptures = {};
    for (const item of Object.values(FIXTURES)) itemCaptures[item] = await counterOf(item);
    return { commandIds: q.records.map(r => r.commandId).sort(), complete: q.complete, pages: q.pages, itemCaptures };
  };
  await collect("bucketBefore", () => listing(config.bucket));
  await collect("policyBefore", policyState);
  const probe = async (role, lang, code) => {
    const url = await driveUrl(role);
    const audience = `urn:graffiticode:${lang}`;
    const post = async (route, headers, body) => {
      const res = await http({ method: "POST", url: `${url}${route}`, headers, body });
      return { status: res.status, body: res.json };
    };
    const preflight = { stage: "s0", lang, code };
    const out = {};
    out["gateway-control"] = await post("/preflight", { "X-Caller-Identity": await idToken(gatewayAccount, audience) }, preflight);
    out["no-identity"] = await post("/preflight", {}, preflight);
    out["malformed-identity"] = await post("/preflight", { "X-Caller-Identity": ACCESS_PROBE_MALFORMED_IDENTITY }, preflight);
    out["non-gateway"] = await post("/preflight", { "X-Caller-Identity": await idToken(consoleAccount, audience) }, preflight);
    out.model = await post("/compile", {}, { code, data: {}, form: "model" });
    const model = out.model.body?.model;
    // Without a model the starts can't be probed: they stay unobserved, and fail.
    if (model) {
      out["start-malformed-session"] = await post("/interpret", {}, { model, input: {}, operation: "start", commandSession: ACCESS_PROBE_MALFORMED_SESSION });
      out["start-forged-session"] = await post("/interpret", {}, { model, input: {}, operation: "start", commandSession: forgedSession() });
    }
    return out;
  };
  const compilers = {};
  await collect("l0013r", async () => (compilers.l0013r = await probe("l0013r", "0013", snapTask(FIXTURES.private).code)));
  await collect("l0176r", async () => {
    const url = await driveUrl("l0176r");
    const res = await http({ method: "GET", url: `${url}/lexicon.json` });
    if (res.status !== 200 || !res.json) throw new Error(`${url}/lexicon.json: ${res.status}`);
    const code = await parser.parse(176, COMMAND_PROGRAM, res.json);
    return (compilers.l0176r = await probe("l0176r", "0176", code));
  });
  observations.compilers = compilers;
  delete observations.l0013r;
  delete observations.l0176r;
  await collect("bucketAfter", () => listing(config.bucket));
  await collect("policyAfter", policyState);
  finish();
}

if (phase === "resolve-intent") {
  // An ambiguous anonymous intent whose own saved answer is the bridge's
  // refusal before allocation (c5d-drive-checks.js BRIDGE_PRE_ALLOCATION_CODES).
  // Policy's enumeration for its task since it was sent must hold no
  // anonymous candidate: a consistency check, not the proof. The
  // .ambiguous.json stays as it is.
  const name = need("--name");
  const files = journalFiles();
  if (!files.includes(journalAmbiguousName(name))) throw new Error(`${name}: no ${journalAmbiguousName(name)} in this run's journal`);
  const recorded = files.includes(journalIdName(name)) ? JSON.parse(readFileSync(path.join(journalDir, journalIdName(name)), "utf8")) : null;
  const intent = JSON.parse(readFileSync(path.join(journalDir, journalName(name)), "utf8"));
  const answer = JSON.parse(readFileSync(path.join(journalDir, journalAmbiguousName(name)), "utf8"));
  const q = await policyCommandsWhere("taskId", intent.task);
  observations.query = { query: q.query, pages: q.pages, count: q.count, complete: q.complete };
  const candidates = q.complete ? q.records.filter(c => c.uid === ANONYMOUS_SUBJECT && Date.parse(c.createdAt) >= Date.parse(intent.sentAt)) : undefined;
  observations.candidates = candidates ?? null;
  const r = preAllocationResolution({ name, answer, candidates });
  if (r.problem) {
    observations.errors.resolution = r.problem;
    console.error(`not resolved: ${r.problem}`);
  } else if (recorded) {
    // Already resolved: confirm, and write only this phase's manifest.
    const c = confirmResolution({ recorded, recomputed: r.resolution });
    if (c.problem) {
      observations.errors.resolution = c.problem;
      console.error(`not confirmed: ${c.problem}`);
    } else {
      observations.resolution = recorded;
      observations.confirmed = true;
      console.log(`${name}: resolution confirmed (${journalIdName(name)} unchanged)`);
    }
  } else {
    journalId(name, r.resolution);
    observations.resolution = r.resolution;
    console.log(`${name}: no allocation (${r.resolution.noAllocation.code}, answered ${r.resolution.noAllocation.answeredAt})`);
  }
  finish();
}

if (phase === "baseline") {
  // A failed read writes nothing: the baseline is taken whole, once.
  const thumbnails = await listing("graffiticode-thumbnails");
  const file = writeOnce(BASELINE_FILE, { runId, phase, at: new Date().toISOString(), observations: { thumbnails, errors: {} } });
  console.log(`baseline: ${thumbnails.length} objects; ${file}`);
}

if (phase === "first-capture") {
  const owner = await command({ name: "first-private", task: need("--private-task"), user: await canary() });
  await collect("private", () => captureOf(owner.commandId));
  const anon = await anonymousCompile("first-public", need("--public-task"));
  await collect("public", async () => {
    await terminal(anon.commandId);
    return captureOf(anon.commandId);
  });
  observations.publicSubject = observations.public ? (await doc("policy", `commands/${encodeURIComponent(anon.commandId)}`)).uid ?? null : null;
  finish();
}

if (phase === "direct-refused") {
  const item = FIXTURES.private;
  await collect("before", () => objectOf(config.bucket, `${item}.png`));
  await collect("messages", async () => {
    // Straight to the (public) drive compiler, outside any command, as the
    // canary user: directCompileRequest.
    const url = await driveUrl("l0013r");
    const res = await http(directCompileRequest({ url, code: JSON.parse(need("--direct-code")), userToken: await canary() }));
    observations.status = res.status;
    return (res.json?.error ? [res.json.error] : res.json?.data?.errors ?? res.json?.errors ?? []).map(e => (typeof e === "string" ? e : e?.message ?? JSON.stringify(e)));
  });
  await collect("after", () => objectOf(config.bucket, `${item}.png`));
  finish();
}

if (phase === "exit-after-reserve") {
  await collect("counterBefore", () => counterOf(FIXTURES.private));
  const c = await command({ name: "exit-after-reserve", task: need("--private-task"), user: await canary() });
  await terminal(ids["exit-after-reserve"]);
  await collect("capture", () => captureOf(ids["exit-after-reserve"]));
  await collect("counterAfter", () => counterOf(FIXTURES.private));
  await collect("faultLines", () => faultLines(ids["exit-after-reserve"], since));
  finish({ answered: c });
}

if (phase === "exit-after-stage") {
  const c = await command({ name: "exit-after-stage", task: need("--private-task"), user: await canary() });
  const id = ids["exit-after-stage"];
  // The staged record read as soon as the exit is logged, before the takeover.
  await collect("faultLines", async () => (await pollUntil({ read: () => faultLines(id, since), done: ls => ls.length > 0, timeoutMs: 120_000, intervalMs: 5_000 })).value);
  await collect("stagedAtExit", async () => (await docs("policy", `commands/${encodeURIComponent(id)}/reservations`))[0] ?? null);
  await terminal(id);
  await collect("capture", () => captureOf(id));
  await collect("renders", () => rendersOf(FIXTURES.private, since));
  finish({ answered: c });
}

if (phase === "drop-outcome") {
  await collect("brokerFaults", async () => {
    const { env } = await servedEnv(config.broker);
    return { BROKER_FAULTS: env.BROKER_FAULTS ?? null, BROKER_FAULT_PRINCIPALS: env.BROKER_FAULT_PRINCIPALS ?? null };
  });
  if (observations.brokerFaults?.BROKER_FAULTS !== "drop-outcome" || observations.brokerFaults?.BROKER_FAULT_PRINCIPALS !== uid) {
    console.error(`refused: ${config.broker} must run BROKER_FAULTS=drop-outcome with BROKER_FAULT_PRINCIPALS=${uid} for this phase (Step 32); it has ${JSON.stringify(observations.brokerFaults)}`);
    process.exit(1);
  }
  const id = ids["drop-outcome"];
  const answered = await command({ name: "drop-outcome", task: need("--private-task"), user: await canary() });
  // The dropped request has finished once the command is terminal: uncertain
  // is Policy's outcome for a dropped write (the check requires it).
  await terminal(id);
  observations.droppedFinishedAt = new Date().toISOString();
  await collect("capture", () => captureOf(id));
  const r = observations.capture?.reservations?.[0];
  if (r) {
    observations.operationId = operationIdOf(observations.capture.invocationId, r);
    observations.claim = observations.capture.claim;
    await collect("outcomeAfterDrop", () => receiptDoc(observations.operationId, "/outcome/final"));
    await collect("objectAfterDrop", () => objectOf(config.bucket, `${r.item}.png`));
    const staged = stagedObject(id, r);
    const generation = (await objectOf(STAGING_BUCKET, staged.replace(`gs://${STAGING_BUCKET}/`, ""))).generation ?? "<absent: stop>";
    observations.staged = { object: staged, generation };
    console.log("\nThe operator's reviewed deletion (Step 32, deletion 2: drop-outcome), now:");
    console.log(`  gcloud storage rm '${staged}' --if-generation-match=${generation} --project=${project}`);
    console.log(`then: node scripts/c5d-drive.js --phase drop-outcome-retry --run ${runId} --private-task <the same task>\n`);
  }
  finish({ answered });
}

if (phase === "drop-outcome-retry") {
  const latest = latestByPhase(readdirSync(dir))["drop-outcome"];
  if (!latest) throw new Error("run --phase drop-outcome first");
  const dropped = readJson(latest).observations;
  await collect("stagedAfterDelete", () => objectOf(STAGING_BUCKET, dropped.staged.object.replace(`gs://${STAGING_BUCKET}/`, "")));
  if (observations.stagedAfterDelete?.absent !== true) {
    console.error(`refused: ${dropped.staged.object} is still there; the operator deletes it first (Step 32, deletion 2)`);
    process.exit(1);
  }
  observations.stagedDeletedAt = new Date().toISOString();
  // The same key again: the same command, journaled under its own name.
  journal("drop-outcome-retry", { kind: "keyed", key: key("drop-outcome"), commandId: ids["drop-outcome"] });
  const res = await http({ method: "POST", url: `${apiUrl}/command`, headers: await asConsole(await canary()), body: { id: need("--private-task"), idempotencyKey: key("drop-outcome") } });
  observations.retry = { status: res.status, commandId: res.json?.data?.commandId ?? null, outcome: res.json?.data?.outcome ?? null };
  const item = dropped.capture.reservations[0].item;
  await collect("reconcile", () => reconcilePoll({
    operationId: dropped.operationId,
    claimedAt: dropped.claim?.claimedAt,
    reconcile: async () => {
      const r = await http({ method: "POST", url: `${policyUrl}/v1/receipts/reconcile`, headers: await asConsoleToPolicy(), body: { itemId: item, idempotencyKey: key("drop-outcome") } });
      return { status: r.status, operations: r.json?.data?.operations ?? [] };
    },
  }));
  await collect("objectAfterRetry", () => objectOf(config.bucket, `${item}.png`));
  await collect("executeSteps", () => auditOf(config.broker, `jsonPayload.opid="${dropped.operationId}"`, new Date(Date.parse(dropped.droppedFinishedAt) - 15 * 60_000).toISOString()));
  finish({ dropped: latest });
}

if (phase === "stale-worker") {
  const id = ids["stale-worker"];
  const answered = await command({ name: "stale-worker", task: need("--private-task"), user: await canary() });
  await terminal(id);
  // The stalled request is released by the takeover, or at most at its bound.
  await sleep(10_000);
  await collect("capture", () => captureOf(id));
  await collect("policyAudit", () => auditOf("policy", `jsonPayload.commandId="${id}"`, since));
  await collect("l0013Lines", () => faultLines(id, since));
  await collect("apiLines", () => lines(config.api, `command ${id}:`, since));
  finish({ answered });
}

if (phase === "staging-gone") {
  const id = ids["staging-gone"];
  const item = FIXTURES.private;
  await collect("objectBefore", () => objectOf(config.bucket, `${item}.png`));
  const answered = await command({ name: "staging-gone", task: need("--private-task"), user: await canary() });
  await collect("faultLines", async () => (await pollUntil({ read: () => faultLines(id, since), done: ls => ls.length > 0, timeoutMs: 120_000, intervalMs: 2_000 })).value);
  await collect("stagedAtExit", async () => (await docs("policy", `commands/${encodeURIComponent(id)}/reservations`))[0] ?? null);
  const r = observations.stagedAtExit;
  if (r?.state === "staged") {
    const staged = stagedObject(id, r);
    const name = staged.replace(`gs://${STAGING_BUCKET}/`, "");
    const generation = (await objectOf(STAGING_BUCKET, name)).generation ?? "<absent: stop>";
    console.log("\nThe operator's reviewed deletion (Step 32, deletion 1: staging-gone), now, before the takeover (lease 60 s):");
    console.log(`  gcloud storage rm '${staged}' --if-generation-match=${generation} --project=${project}\n`);
    await collect("stagedAfterDelete", async () => (await pollUntil({ read: () => objectOf(STAGING_BUCKET, name), done: o => o?.absent === true, timeoutMs: 120_000, intervalMs: 2_000 })).value);
    observations.stagedDeletedAt = new Date().toISOString();
    await terminal(id);
    await collect("capture", () => captureOf(id));
    observations.claim = observations.capture?.claim;
  }
  await collect("objectAfter", () => objectOf(config.bucket, `${item}.png`));
  // Before the fresh capture, which renders the same item.
  const beforeFresh = new Date().toISOString();
  await collect("renders", async () => {
    await sleep(30_000);
    return rendersOf(item, since, beforeFresh);
  });
  const fresh = await command({ name: "staging-gone-fresh", task: need("--private-task"), user: await canary() });
  await collect("fresh", () => captureOf(fresh.commandId));
  finish({ answered });
}

if (phase === "recount-renders") {
  // A recount of exit-after-stage's renders in the original's own window
  // (recountSource, recountManifest): every recount reads the original.
  const of = need("--of");
  if (!RECOUNTABLE.includes(of)) throw new Error(`--of must be one of ${RECOUNTABLE.join(", ")}`);
  const files = readdirSync(dir).filter(f => f.startsWith(`${of}-`) && f.endsWith(".json")).sort()
    .map(file => ({ file, manifest: JSON.parse(readFileSync(path.join(dir, file), "utf8")) }));
  const { source, sourceFile } = recountSource(files);
  const journalAt = JSON.parse(readFileSync(path.join(journalDir, journalName(of)), "utf8")).at;
  const { count, observedMs } = await rendersObserved(FIXTURES.private, journalAt, source.at);
  const manifest = recountManifest({ source, sourceFile, journalAt, renders: count, observedMs, at: new Date().toISOString() });
  const file = writeOnce(phaseFile(of, stampOf(new Date())), manifest);
  const judged = judgePhase(of, manifest.observations);
  for (const c of judged.checks) console.log(`${c.ok ? "ok    " : "FAILED"} ${c.id}: ${c.detail}`);
  console.log(`${of} (recount of ${sourceFile}, window ${journalAt} to ${source.at}: renders ${manifest.recount.before} -> ${count}): ${file}`);
  process.exitCode = phaseExitCode({ phase: of, observations: manifest.observations });
}

if (phase === "older-after-newer") {
  // The older stops after staging; the newer runs while the older's lease is live.
  const older = command({ name: "older", task: need("--private-task"), user: await canary() });
  await collect("olderFaultLines", async () => (await pollUntil({ read: () => faultLines(ids.older, since), done: ls => ls.length > 0, timeoutMs: 120_000, intervalMs: 2_000 })).value);
  const newer = await command({ name: "newer", task: need("--private-task"), user: await canary() });
  await terminal(ids.newer);
  await terminal(ids.older);
  await older.catch(() => null);
  await collect("older", () => captureOf(ids.older));
  await collect("newer", () => captureOf(newer.commandId));
  await collect("olderSteps", async () => {
    const r = observations.older.reservations[0];
    const opid = operationIdOf(observations.older.invocationId, r);
    return (await docs("broker", `receipts/${createHash("sha256").update(opid).digest("hex")}/steps`)).map(s => ({ step: s.step, observed: s.observed ?? null }));
  });
  await collect("finalObject", () => objectOf(config.bucket, `${FIXTURES.private}.png`));
  finish();
}

if (phase === "two-stage") {
  const distinct = await command({ name: "two-stage", task: need("--two-items-task"), user: await canary() });
  const same = await command({ name: "two-stage-same", task: need("--same-program-task"), user: await canary() });
  await collect("distinctItems", () => captureOf(distinct.commandId));
  await collect("sameProgram", () => captureOf(same.commandId));
  observations.capture = observations.distinctItems;
  finish();
}

if (phase === "mixed") {
  const mixed = await command({ name: "mixed", task: need("--mixed-task"), user: await canary(), connection: connectionId });
  await collect("capture", () => captureOf(mixed.commandId));
  await collect("tokens", async () => {
    const inv = observations.capture.invocationId;
    const { value } = await pollUntil({
      read: () => auditOf(config.broker, `jsonPayload.invocationId="${inv}"`, since),
      done: es => ["snap", "save-to-itembank"].every(fn => tokensFromAudit(es.map(e => ({ jsonPayload: e }))).some(t => t.fn === fn)),
      timeoutMs: 180_000,
      intervalMs: 10_000,
    });
    return tokensFromAudit(value.map(e => ({ jsonPayload: e })));
  });
  observations.invocations = observations.capture ? 1 : null;
  finish();
}

if (phase === "non-owner") {
  const token = process.env.C5D_NON_OWNER_TOKEN;
  if (!token) throw new Error("set C5D_NON_OWNER_TOKEN to a non-owner's access token");
  // Another user's keyed command: its id is computable from that user's uid,
  // so it is journaled before the request, and cleanup reads its record
  // whatever the answer was (an absent record: Policy allocated nothing).
  const nonOwnerUid = need("--non-owner-uid");
  const nonOwnerKey = `${key("first-private")}:non-owner`;
  const expectedId = commandIdFor(nonOwnerUid, nonOwnerKey);
  journal("non-owner", { kind: "keyed", uid: nonOwnerUid, key: nonOwnerKey, commandId: expectedId });
  const res = await http({ method: "POST", url: `${apiUrl}/command`, headers: await asConsole(token), body: { id: need("--private-task"), idempotencyKey: nonOwnerKey } });
  const other = { status: res.status, commandId: res.json?.data?.commandId ?? null, outcome: res.json?.data?.outcome ?? null, reason: res.json?.data?.reason ?? res.json?.error?.reason ?? null };
  if (other.commandId && other.commandId !== expectedId) throw new Error(`the non-owner's command is ${other.commandId}, not ${expectedId}: is --non-owner-uid C5D_NON_OWNER_TOKEN's user?`);
  const record = other.commandId ? await doc("policy", `commands/${encodeURIComponent(other.commandId)}`) : { absent: true };
  observations.status = other.status;
  observations.outcome = record.status ?? other.outcome;
  observations.reason = record.admissionRefusal?.reason ?? other.reason;
  await collect("reservations", () => (other.commandId ? docs("policy", `commands/${encodeURIComponent(other.commandId)}/reservations`) : []));
  finish();
}

if (phase === "rate-limit") {
  // The slots left: the public item's public captures still in Policy's window
  // (first-capture's anonymous capture among them) are counted first.
  const before = await counterOf(FIXTURES.public);
  const priorAt = Date.now();
  observations.priorInWindow = priorPublicCaptures(before, priorAt);
  const remaining = PUBLIC_CAPTURE_LIMIT - observations.priorInWindow;
  if (remaining < 1) throw new Error(`no slot left for ${FIXTURES.public}: ${observations.priorInWindow} public captures in the window`);
  const from = new Date().toISOString();
  const allocated = [];
  const client = policyFixtureClient(gateway);
  try {
    for (let i = 0; i < remaining + 1; i++) {
      const a = await anonymousCompile(`rate-limit-${i + 1}`, need("--public-task"));
      if (a.commandId) allocated.push(a.commandId);
    }
  } finally {
    await collect("retired", async () => {
      await retireFixtures({ client, ids: allocated, worker: `c5d-drive-fixture:${runId}` });
      return verifyRetired({ client, ids: allocated });
    });
  }
  observations.attempted = remaining + 1;
  await collect("quota", async () => {
    const { value } = await pollUntil({ read: () => logs(policyReserveFilter(FIXTURES.public, from)), done: reservesCover(allocated), timeoutMs: 180_000, intervalMs: 10_000 });
    return rateLimitFromAudit(value);
  });
  Object.assign(observations, observations.quota ?? {});
  finish({ allocated });
}

if (phase === "canary-snap") {
  // Journaled with its planned id before the subprocess runs.
  journal("canary-snap", { kind: "canary", key: key("canary-snap"), commandId: ids["canary-snap"] });
  const run = spawnSync(process.execPath, [new URL("./canary.js", import.meta.url).pathname,
    "--uid", uid, "--snap", FIXTURES.private, "--snap-only", "--thumbnail-bucket", config.bucket,
    "--api-service", config.api, "--api-invoker", consoleAccount, "--run-id", plan.canaryRunId], { encoding: "utf8" });
  observations.exitCode = run.status;
  observations.results = (run.stdout ?? "").split("\n").map(l => /^\s*(PASS|FAIL) ([^:]+):/.exec(l)).filter(Boolean).map(m => ({ name: m[2], ok: m[1] === "PASS" }));
  // canary.js's "snap command" line: `command <id> completed for <item>`.
  observations.commandId = /(?:PASS|FAIL) snap command: command (c:[0-9a-f]{64})/.exec(run.stdout ?? "")?.[1] ?? null;
  observations.expectedCommandId = ids["canary-snap"];
  finish();
}

if (phase === "resolve-journal") {
  // The ambiguous anonymous intents, each correlated with Policy's anonymous
  // commands for its task from its start to now (no upper bound), never
  // with one another intent, journal entry or manifest already claims.
  const files = journalFiles();
  const intents = files.filter(x => x.endsWith(".ambiguous.json"))
    .map(f => f.replace(/\.ambiguous\.json$/, ""))
    .filter(name => !files.includes(journalIdName(name)))
    .map(name => ({ name, ...JSON.parse(readFileSync(path.join(journalDir, journalName(name)), "utf8")) }));
  const { commandIds: claimed } = driveInventory();
  const commands = [];
  const queries = [];
  for (const task of [...new Set(intents.map(i => i.task))]) {
    const q = await policyCommandsWhere("taskId", task);
    if (!q.complete) throw new Error(`Policy's commands for ${task}: truncated at ${q.pages} pages`);
    queries.push({ query: q.query, pages: q.pages, count: q.count });
    commands.push(...q.records);
  }
  const resolutions = correlateIntents({ intents, commands, claimed, anonymousSubject: ANONYMOUS_SUBJECT, query: queries });
  for (const i of intents) {
    const r = resolutions[i.name];
    if (r) journalId(i.name, r);
    console.log(`${i.name}: ${r ? `${r.commandId} (created ${r.resolvedBy.createdAt})` : "still unresolved: no unique unclaimed anonymous command for its task since it was sent; rerun later, or the owner decides"}`);
  }
  observations.intents = intents.map(i => i.name);
  observations.resolutions = resolutions;
  observations.queries = queries;
  finish();
}

if (phase === "boundary") {
  const { commandIds } = driveInventory();
  await collect("commands", async () => {
    const out = [];
    for (const id of commandIds) {
      const record = await doc("policy", `commands/${encodeURIComponent(id)}`);
      out.push(record.absent ? { commandId: id, absent: true } : { commandId: id, invocationId: record.invocationId, stages: Object.values(record.admission?.stages ?? {}).map(s => s.revision) });
    }
    return out;
  });
  const invocations = [...new Set((observations.commands ?? []).map(c => c.invocationId).filter(Boolean))];
  await collect("claimsByInvocation", async () => {
    const out = {};
    for (const inv of invocations) out[inv] = await claimsOf(inv);
    return out;
  });
  const from = plan.at;
  // Polled until every claimed operation has broker-c5d-drive's execute
  // evidence (Cloud Logging ingests late), within the bound; then watched
  // for AUDIT_OBSERVATION_MS more, and recollected whole over the drive's
  // window: that last read is what's judged, so a violation ingested after
  // the controls is in it. Every query's count is kept, so a truncated read
  // fails the check.
  const ops = invocations.flatMap(inv => observations.claimsByInvocation?.[inv] ?? []);
  await collect("audit", async () => {
    const read = async () => {
      const queries = [];
      for (const service of [config.broker, "broker"]) for (const inv of invocations) queries.push(await auditQuery(service, `jsonPayload.invocationId="${inv}"`, from));
      return queries;
    };
    const { value, poll } = await observeAudit({ read, covered: auditCovered(ops, config.broker), timeoutMs: auditTimeoutMs });
    return { queries: value, poll };
  });
  observations.queries = (observations.audit?.queries ?? []).map(({ entries, ...q }) => q);
  observations.brokerAudit = (observations.audit?.queries ?? []).flatMap(q => q.entries);
  observations.poll = observations.audit?.poll;
  delete observations.audit;
  await collect("reconcileBuckets", async () => {
    const out = [];
    for (const e of (observations.brokerAudit ?? []).filter(x => x.service === "broker" && x.event === "reconcile" && x.opid)) {
      const claim = await receiptDoc(e.opid);
      out.push({ opid: e.opid, bucket: claim.evidence?.bucket ?? null });
    }
    return out;
  });
  // Judged against baseline.json, the run's one baseline (judge reads it too).
  observations.thumbnailsBefore = readJson(BASELINE_FILE).observations.thumbnails;
  await collect("thumbnailsAfter", () => listing("graffiticode-thumbnails"));
  observations.fixtures = Object.values(FIXTURES);
  observations.compilerCalls = (observations.commands ?? []).flatMap(c => (c.stages ?? []).map(revision => ({ revision, service: revisionService(revision) })));
  finish();
}

if (phase === "cleanup") {
  const { commandIds, unresolvedIntents } = driveInventory();
  observations.unresolvedIntents = unresolvedIntents;
  // Step 32 §9: an aborted run's close (no capture ran); judged as such.
  if (args.includes("--aborted")) observations.aborted = true;
  await collect("commands", async () => {
    const out = [];
    for (const id of commandIds) {
      const record = await doc("policy", `commands/${encodeURIComponent(id)}`);
      out.push({ commandId: id, status: record.absent ? "absent" : record.status ?? null });
    }
    return out;
  });
  await collect("due", async () => {
    const listed = new Set();
    for (const scopes of [false, true]) for (const c of (await policyFixtureClient(gateway).due({ scopes })).commands ?? []) listed.add(c.commandId);
    return [...listed];
  });
  // Policy's own records, whatever the journal says: every command on the
  // run's drive tasks (any principal) and every command of the run's
  // principals (the canary, the non-owner), each query paged to its end.
  await collect("policyEnumeration", async () => {
    const entries = journalFiles().filter(f => !f.endsWith(".id.json") && !f.endsWith(".ambiguous.json") && !f.endsWith(".answer.json")).map(f => JSON.parse(readFileSync(path.join(journalDir, f), "utf8")));
    const tasks = new Set(entries.map(e => e.task).filter(t => typeof t === "string"));
    // canary.js posts its own snap task: its planned command's record names it.
    const canarySnap = await doc("policy", `commands/${encodeURIComponent(ids["canary-snap"])}`);
    if (!canarySnap.absent && canarySnap.taskId) tasks.add(canarySnap.taskId);
    const nonOwner = entries.find(e => e.uid && e.uid !== uid)?.uid ?? null;
    const queries = [];
    const records = [];
    for (const [field, value] of [...[...tasks].map(t => ["taskId", t]), ["uid", uid], ...(nonOwner ? [["uid", nonOwner]] : [])]) {
      const q = await policyCommandsWhere(field, value);
      queries.push({ query: q.query, pages: q.pages, count: q.count, complete: q.complete });
      records.push(...q.records);
    }
    if (!tasks.size) throw new Error("no drive task in the journal");
    return { since: plan.at, tasks: [...tasks], queries, commands: drivePolicyCommands({ records, since: plan.at, tasks: [...tasks], principals: { canary: uid, nonOwner } }) };
  });
  finish();
}
