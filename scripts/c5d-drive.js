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
// plan.json is written once per run; each phase's run writes
// `<phase>-<stamp>.json` with exclusive creation, never overwriting one.
//
// It refuses to start unless every service and the bucket are the drive's own
// names (broker-c5d-drive, l0013r-c5d-drive, l0176r-c5d-drive, api-c5d-drive,
// gs://graffiticode-c5d-drive): never production's api, broker, policy,
// l0013r or l0176r, never B6's l0176r-drive or broker-faults, and never the
// graffiticode-thumbnails, graffiticode.appspot.com or staging bucket as the
// drive bucket.
//
// What the runner does, and what the operator does (Step 32 holds every
// operator command, reviewed):
//   plan             runner: computes every key and command id from the canary
//                    uid and the run id, and the two fault maps. Operator:
//                    releases l0013r-c5d-drive with L0013_CAPTURE_FAULTS and
//                    api-c5d-drive with API_COMMAND_FAULT_TARGETS set to them,
//                    once, before any capture; never changed during the run.
//   checks           runner, read-only: Step 32's verification (environments,
//                    /egress (the plan says /status; the route is /egress), the bucket's settings and IAM, the fault maps
//                    equal to plan.json's).
//   baseline         runner, read-only: graffiticode-thumbnails' listing.
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
//                    the capture, records the claim and the dropped request's
//                    end, and prints the exact reviewed deletion of its staged
//                    object (Step 32, deletion 2). Then the operator deletes it.
//   drop-outcome-retry
//                    runner: verifies the staged object is gone, retries the
//                    command by its key, reconciles as the console, and reads
//                    Broker's records. Operator after: removes BROKER_FAULTS.
//   stale-worker     runner: the doubly targeted capture (stop-renewal and
//                    stall-before-stage); waits for it to finish; reads Policy's
//                    audit and both services' lines.
//   staging-gone     runner: the targeted capture; on its exit-after-stage line
//                    it prints the exact reviewed deletion (Step 32, deletion 1),
//                    waits (bounded) for the operator's deletion, then for the
//                    takeover's failure; then a fresh, untargeted capture.
//   older-after-newer, two-stage, mixed, non-owner, rate-limit
//                    runner, as slice 3 lists them.
//   canary-snap      runner: scripts/canary.js --snap against api-c5d-drive.
//   boundary         runner, read-only: Broker's audit for every drive
//                    invocation, the reconcile reads' buckets, the thumbnails
//                    listing again, the compilers each plan pinned.
//   cleanup          runner, read-only: every drive command terminal, none due.
//   judge            the verdict; exit 1 unless every phase passed.
//
// Needs canary-window-c5d (Step 32): OpenIdTokenCreator on console-run (to
// call the private api-c5d-drive as the console does) and on api-run (Policy's
// gateway reads and l0013r-c5d-drive's direct compile). Policy's and Broker's
// databases, Cloud Logging and the buckets are read with the operator's own
// credentials. Phases a non-owner needs read C5D_NON_OWNER_TOKEN.

import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeManifestOnce } from "./lib/c5b-thumbnails.js";
import {
  DRIVE, FIXTURES, STAGING_BUCKET, PUBLIC_CAPTURE_LIMIT, driveTargets, driveNamesProblem, judgePhase, verdict,
  stagedObject, operationIdOf, revisionService, PLAN_FILE, phaseFile, stampOf, latestByPhase, DRIVE_PHASES,
} from "./lib/c5d-drive-checks.js";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const PHASE_NAMES = ["plan", "checks", "baseline", "first-capture", "direct-refused", "exit-after-reserve", "exit-after-stage", "drop-outcome", "drop-outcome-retry",
  "stale-worker", "staging-gone", "older-after-newer", "two-stage", "mixed", "non-owner", "rate-limit", "canary-snap", "boundary", "cleanup", "judge"];
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
const runId = phase === "plan" ? flag("--run", randomBytes(4).toString("hex")) : flag("--run");
if (!runId || !/^[a-z0-9]{4,32}$/.test(runId)) {
  console.error("--run <id> (4-32 lowercase letters and digits) is required");
  process.exit(2);
}
const dir = path.join(flag("--dir", new URL("../docs/evidence/c5d/drive", import.meta.url).pathname), runId);
mkdirSync(dir, { recursive: true });
const writeOnce = (file, value) => writeManifestOnce(path.join(dir, file), value);
const readJson = file => JSON.parse(readFileSync(path.join(dir, file), "utf8"));

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

// ------------------------------------------------------------------ judge

if (phase === "judge") {
  const latest = latestByPhase(readdirSync(dir));
  const phases = {};
  for (const p of DRIVE_PHASES) {
    if (!latest[p]) continue;
    phases[p] = readJson(latest[p]).observations;
    // Each operator pause's own observations join its phase's.
    const step = { "drop-outcome": "drop-outcome-retry", "staging-gone": "staging-gone-delete" }[p];
    if (step && latest[step]) phases[p] = { ...phases[p], ...readJson(latest[step]).observations, errors: { ...(phases[p].errors ?? {}), ...(readJson(latest[step]).observations.errors ?? {}) } };
  }
  const result = verdict(phases);
  for (const p of result.phases) for (const c of p.checks) console.log(`${c.ok ? "ok    " : "FAILED"} ${p.phase}/${c.id}: ${c.detail}`);
  const file = writeOnce(`report-${stampOf(new Date())}.json`, { runId, at: new Date().toISOString(), manifests: latest, ...result });
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
  console.log(`${phase}: ${file}`);
};

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
const { createHash } = await import("node:crypto");
const receiptDoc = (operationId, sub = "") => doc("broker", `receipts/${createHash("sha256").update(operationId).digest("hex")}${sub}`);
const logs = async (filter, limit = 1000) => {
  const out = await gcloud(["logging", "read", filter, `--limit=${limit}`, "--format=json", "--order=asc"]);
  return out ? JSON.parse(out) : [];
};
const lines = async (service, text, since) => (await logs([
  "resource.type=\"cloud_run_revision\"", `resource.labels.service_name="${service}"`, `timestamp>="${since}"`, `textPayload:"${text}"`,
].join(" AND "))).map(e => ({ at: e.timestamp, text: e.textPayload }));
const auditOf = async (service, query, since) => (await logs([
  "resource.type=\"cloud_run_revision\"", `resource.labels.service_name="${service}"`, "jsonPayload.logName=\"security_audit\"", `timestamp>="${since}"`, query,
].join(" AND "))).map(e => ({ at: e.timestamp, service, ...e.jsonPayload }));
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
const listing = async bucket => {
  const out = JSON.parse((await runCapturing("gcloud", ["storage", "ls", "--json", `gs://${bucket}/`, `--project=${project}`])).trim() || "null");
  if (!Array.isArray(out)) throw new Error(`gs://${bucket}: the listing isn't a list`);
  return out.map(o => ({ name: o.url.replace(`gs://${bucket}/`, ""), generation: String(o.metadata?.generation ?? "") }));
};
const servedEnv = async service => {
  const described = JSON.parse(await gcloud(["run", "services", "describe", service, `--region=${region}`, "--format=json"]));
  const revision = routedRevision(described, null);
  if (!revision) throw new Error(`${service}: no revision serves 100%`);
  return { revision, env: revisionEnv(JSON.parse(await gcloud(["run", "revisions", "describe", revision, `--region=${region}`, "--format=json"]))) };
};

// The api-c5d-drive calls, as the console makes them: console-run's ID token,
// whose audience is the service's stable URL (Cloud Run requires it, tag URL
// or not), and the user's token.
const apiAudience = await serviceUrl(config.api);
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
const command = async ({ task, key, user, connection = null }) => {
  const res = await http({ method: "POST", url: `${apiUrl}/command`, headers: await asConsole(user), body: { id: task, idempotencyKey: key, ...(connection ? { connectionId: connection } : {}) } });
  return { status: res.status, commandId: res.json?.data?.commandId ?? null, outcome: res.json?.data?.outcome ?? null, reason: res.json?.data?.reason ?? res.json?.error?.reason ?? null };
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

// A command's capture observation (c5d-drive-checks.js "capture").
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
  const item = reservations[0]?.item;
  return {
    commandId,
    status: record.status,
    ownerGeneration: record.owner?.generation ?? null,
    invocationId: record.invocationId,
    admission: record.admission ?? null,
    result,
    reservations,
    object: item ? await objectOf(config.bucket, `${item}.png`) : { absent: true },
  };
};
// Until the command is terminal (completed or failed), bounded.
const terminal = async commandId => {
  const { value, timedOut } = await pollUntil({
    read: () => doc("policy", `commands/${encodeURIComponent(commandId)}`),
    done: r => ["completed", "failed"].includes(r?.status),
    timeoutMs: waitMs,
    intervalMs: 5_000,
  });
  if (timedOut) throw new Error(`${commandId} still ${value?.status} after ${waitMs} ms`);
  return value;
};
const counterOf = async item => doc("policy", `item-captures/${encodeURIComponent(item)}`);
const faultLines = (commandId, since) => lines(config.l0013r, "capture fault", since).then(ls => ls.filter(l => l.text.includes(commandId)));
// The compiler's `render` lines name the item, not the command (crates/capture
// render(): "render item=<item> ..."), so a phase counts its item's renders in
// its own window, while no other capture of that item runs.
const rendersOf = async (item, from, to = null) => (await lines(config.l0013r, `render item=${item}`, from))
  .filter(l => to === null || Date.parse(l.at) < Date.parse(to)).length;
const key = name => plan.keys[name];
const ids = plan.ids;
const since = new Date().toISOString();

// ----------------------------------------------------------------- phases

if (phase === "checks") {
  const services = {};
  for (const [role, name] of Object.entries({ broker: config.broker, l0013r: config.l0013r, l0176r: config.l0176r, api: config.api })) {
    await collect(`env:${role}`, async () => (services[role] = await servedEnv(name)));
  }
  observations.services = services;
  observations.targets = plan.faults;
  await collect("l0013rStatus", async () => {
    const url = await serviceUrl(config.l0013r);
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

if (phase === "baseline") {
  await collect("thumbnails", () => listing("graffiticode-thumbnails"));
  finish();
}

if (phase === "first-capture") {
  const owner = await command({ task: need("--private-task"), key: key("first-private"), user: await canary() });
  await collect("private", () => captureOf(owner.commandId));
  const anon = await http({ method: "POST", url: `${apiUrl}/compile`, headers: await asConsole(null), body: { id: need("--public-task") } });
  const anonId = (anon.json?.data ?? anon.json)?.command?.commandId ?? null;
  await collect("public", async () => captureOf((await terminal(anonId)).commandId));
  observations.publicSubject = observations.public ? (await doc("policy", `commands/${encodeURIComponent(anonId)}`)).uid ?? null : null;
  finish();
}

if (phase === "direct-refused") {
  const item = FIXTURES.private;
  await collect("before", () => objectOf(config.bucket, `${item}.png`));
  await collect("messages", async () => {
    // Straight to the drive compiler, outside any command, as api-run (an invoker).
    const url = await serviceUrl(config.l0013r);
    const res = await http({ method: "POST", url: `${url}/compile`, headers: { Authorization: `Bearer ${await idToken(gatewayAccount, url)}` }, body: { code: JSON.parse(need("--direct-code")), data: {} } });
    observations.status = res.status;
    return (res.json?.error ? [res.json.error] : res.json?.data?.errors ?? res.json?.errors ?? []).map(e => (typeof e === "string" ? e : e?.message ?? JSON.stringify(e)));
  });
  await collect("after", () => objectOf(config.bucket, `${item}.png`));
  finish();
}

if (phase === "exit-after-reserve") {
  await collect("counterBefore", () => counterOf(FIXTURES.private));
  const c = await command({ task: need("--private-task"), key: key("exit-after-reserve"), user: await canary() });
  await terminal(ids["exit-after-reserve"]);
  await collect("capture", () => captureOf(ids["exit-after-reserve"]));
  await collect("counterAfter", () => counterOf(FIXTURES.private));
  await collect("faultLines", () => faultLines(ids["exit-after-reserve"], since));
  finish({ answered: c });
}

if (phase === "exit-after-stage") {
  const c = await command({ task: need("--private-task"), key: key("exit-after-stage"), user: await canary() });
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
  const answered = await command({ task: need("--private-task"), key: key("drop-outcome"), user: await canary() });
  // The dropped request has finished once the api answered and the command is terminal.
  await terminal(id);
  observations.droppedFinishedAt = new Date().toISOString();
  await collect("capture", () => captureOf(id));
  const r = observations.capture?.reservations?.[0];
  if (r) {
    observations.operationId = operationIdOf(observations.capture.invocationId, r);
    await collect("claim", () => receiptDoc(observations.operationId));
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
  observations.retry = await command({ task: need("--private-task"), key: key("drop-outcome"), user: await canary() });
  await collect("reconcile", async () => {
    const item = dropped.capture.reservations[0].item;
    const res = await http({ method: "POST", url: `${policyUrl}/v1/receipts/reconcile`, headers: await asConsoleToPolicy(), body: { itemId: item, idempotencyKey: key("drop-outcome") } });
    return { status: res.status, operations: res.json?.data?.operations ?? [] };
  });
  await collect("objectAfterRetry", () => objectOf(config.bucket, `${dropped.capture.reservations[0].item}.png`));
  await collect("executeSteps", async () => [
    ...(await auditOf(config.broker, `jsonPayload.opid="${dropped.operationId}"`, dropped.droppedFinishedAt ? new Date(Date.parse(dropped.droppedFinishedAt) - 15 * 60_000).toISOString() : since)),
  ]);
  finish({ dropped: latest });
}

if (phase === "stale-worker") {
  const id = ids["stale-worker"];
  const answered = await command({ task: need("--private-task"), key: key("stale-worker"), user: await canary() });
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
  const answered = await command({ task: need("--private-task"), key: key("staging-gone"), user: await canary() });
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
    await collect("claim", () => receiptDoc(operationIdOf(observations.capture.invocationId, r)));
  }
  await collect("objectAfter", () => objectOf(config.bucket, `${item}.png`));
  // Before the fresh capture, which renders the same item.
  const beforeFresh = new Date().toISOString();
  await collect("renders", async () => {
    await sleep(30_000);
    return rendersOf(item, since, beforeFresh);
  });
  const fresh = await command({ task: need("--private-task"), key: key("staging-gone-fresh"), user: await canary() });
  await collect("fresh", () => captureOf(fresh.commandId));
  finish({ answered });
}

if (phase === "older-after-newer") {
  // The older stops after staging; the newer runs while the older's lease is live.
  const older = command({ task: need("--private-task"), key: key("older"), user: await canary() });
  await collect("olderFaultLines", async () => (await pollUntil({ read: () => faultLines(ids.older, since), done: ls => ls.length > 0, timeoutMs: 120_000, intervalMs: 2_000 })).value);
  const newer = await command({ task: need("--private-task"), key: key("newer"), user: await canary() });
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
  const distinct = await command({ task: need("--two-items-task"), key: key("two-stage"), user: await canary() });
  const same = await command({ task: need("--same-program-task"), key: `${key("two-stage")}:same`, user: await canary() });
  await collect("distinctItems", () => captureOf(distinct.commandId));
  await collect("sameProgram", () => captureOf(same.commandId));
  observations.capture = observations.distinctItems;
  finish();
}

if (phase === "mixed") {
  const mixed = await command({ task: need("--mixed-task"), key: key("mixed"), user: await canary(), connection: connectionId });
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
  const other = await command({ task: need("--private-task"), key: `${key("first-private")}:non-owner`, user: token });
  const record = other.commandId ? await doc("policy", `commands/${encodeURIComponent(other.commandId)}`) : { absent: true };
  observations.status = other.status;
  observations.outcome = record.status ?? other.outcome;
  observations.reason = record.admissionRefusal?.reason ?? other.reason;
  await collect("reservations", () => (other.commandId ? docs("policy", `commands/${encodeURIComponent(other.commandId)}/reservations`) : []));
  finish();
}

if (phase === "rate-limit") {
  const from = new Date().toISOString();
  const allocated = [];
  try {
    for (let i = 0; i < PUBLIC_CAPTURE_LIMIT + 1; i++) {
      const res = await http({ method: "POST", url: `${apiUrl}/compile`, headers: await asConsole(null), body: { id: need("--public-task") } });
      const commandId = (res.json?.data ?? res.json)?.command?.commandId ?? null;
      if (commandId) allocated.push(commandId);
    }
  } finally {
    const client = {
      get: id => gateway("GET", `/v1/commands/${encodeURIComponent(id)}`),
      lease: (id, body) => gateway("POST", `/v1/commands/${encodeURIComponent(id)}/lease`, body),
      finish: (id, generation) => gateway("POST", `/v1/commands/${encodeURIComponent(id)}/finish`, { generation, result: null }),
    };
    await collect("retired", async () => {
      await retireFixtures({ client, ids: allocated, worker: `c5d-drive-fixture:${runId}` });
      return verifyRetired({ client, ids: allocated });
    });
  }
  await collect("quota", async () => {
    const item = (await docs("policy", `commands/${encodeURIComponent(allocated[0])}/reservations`))[0]?.item;
    const { value } = await pollUntil({ read: () => logs(policyReserveFilter(item, from)), done: reservesCover(allocated), timeoutMs: 180_000, intervalMs: 10_000 });
    return rateLimitFromAudit(value);
  });
  Object.assign(observations, observations.quota ?? {});
  finish({ allocated });
}

if (phase === "canary-snap") {
  const run = spawnSync(process.execPath, [new URL("./canary.js", import.meta.url).pathname,
    "--uid", uid, "--snap", FIXTURES.private, "--snap-only", "--thumbnail-bucket", config.bucket,
    "--api-service", config.api, "--api-invoker", consoleAccount], { encoding: "utf8" });
  observations.exitCode = run.status;
  observations.results = (run.stdout ?? "").split("\n").map(l => /^\s*(PASS|FAIL) ([^:]+):/.exec(l)).filter(Boolean).map(m => ({ name: m[2], ok: m[1] === "PASS" }));
  finish();
}

// Every command the drive allocated, from its phases' manifests.
const driveCommands = () => {
  const found = new Set();
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json") && f !== PLAN_FILE)) {
    const walk = v => {
      if (typeof v === "string" && /^c:[0-9a-f]{64}$/.test(v)) found.add(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(readJson(f));
  }
  return [...found];
};

if (phase === "boundary") {
  const commands = driveCommands();
  const records = [];
  for (const id of commands) records.push({ id, record: await doc("policy", `commands/${encodeURIComponent(id)}`) });
  observations.invocations = records.map(r => r.record?.invocationId).filter(Boolean);
  const from = readJson(PLAN_FILE).at;
  await collect("brokerAudit", async () => {
    const out = [];
    for (const service of [config.broker, "broker"]) {
      for (const inv of observations.invocations) out.push(...(await auditOf(service, `jsonPayload.invocationId="${inv}"`, from)));
    }
    return out;
  });
  await collect("reconcileBuckets", async () => {
    const out = [];
    for (const e of (observations.brokerAudit ?? []).filter(x => x.service === "broker" && x.event === "reconcile" && x.opid)) {
      const claim = await receiptDoc(e.opid);
      out.push({ opid: e.opid, bucket: claim.evidence?.bucket ?? null });
    }
    return out;
  });
  const baseline = latestByPhase(readdirSync(dir)).baseline;
  observations.thumbnailsBefore = baseline ? readJson(baseline).observations.thumbnails : undefined;
  await collect("thumbnailsAfter", () => listing("graffiticode-thumbnails"));
  observations.fixtures = Object.values(FIXTURES);
  observations.compilerCalls = records.flatMap(r => Object.values(r.record?.admission?.stages ?? {}).map(s => ({ revision: s.revision, service: revisionService(s.revision) })));
  finish();
}

if (phase === "cleanup") {
  const commands = driveCommands();
  await collect("commands", async () => {
    const out = [];
    for (const id of commands) out.push({ commandId: id, status: (await doc("policy", `commands/${encodeURIComponent(id)}`)).status ?? null });
    return out;
  });
  await collect("due", async () => {
    const due = await gateway("GET", "/v1/commands-due?limit=50&recording=1&repairs=1&scopes=1");
    return (due.commands ?? []).map(c => c.commandId);
  });
  finish();
}
