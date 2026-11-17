// C5a's live gate (docs/c5-l0013-commands-plan.md, "C5a completion gate";
// docs/capability-policy-iam-review.md Step 29): captures through
// api-c5a-gate, as the canary account calls the api through the console, then
// the verdict from scripts/lib/c5a-gate-checks.js.
//
//   node scripts/c5a-gate.js --phase <baseline|captures|after|judge> [flags]
//
// Phases, in order (state accumulates in --state, default
// .gc-deploy/c5a-gate/state.json):
//   baseline   read-only: earlier approval records' digest, and
//              graffiticode.appspot.com's thumbnails/ listing (names and
//              generations), before anything runs.
//   captures   through api-c5a-gate: the owner's private capture, a
//              non-owner's (C5A_NON_OWNER_TOKEN), the L0000-over-L0013
//              composition, the mixed chain through the canary's connection,
//              and anonymous captures of the public item until one is
//              rate-limited. Each command's record, reservations and plan are
//              read from Policy's database with the operator's credentials, and
//              the published object from the gate bucket.
//   after      read-only: the same digests again, graffiticode-thumbnails'
//              object count, and the production api's log lines naming any
//              gate command (its sweeper must lease none).
//   judge      the verdict over the state and every --evidence file, written
//              to <state dir>/report.json; exit 1 unless it passed.
//
// Inputs the operator prepares (task ids, created from the two owner-approved
// fixture items and listed in the evidence): --private-task (an L0013 capture
// of the private item), --public-task (of the public item), --compose-task (an
// L0000 head over the private capture), --mixed-task (the private capture plus
// an L0176 save). Observations no gate-api call can make are given as JSON
// files with --evidence (repeatable), merged over what the phases recorded:
// `canary`, `repairRoundtrip`, `v2PlanDigest`, `v8Artifact`, `preSlice6`,
// `narrowed`, `mismatches`, `conditional`, `reserveStageBind`, `consoleRoute`,
// `proxy`, and `registryVersion` per plan stage when a plan record doesn't
// carry it. A missing one fails its check (c5a-gate-checks.js).
//
// Needs canary-window-c5a (Step 29): OpenIdTokenCreator on console-run, to
// call the private gate api as the console does. Policy's and the revisions
// databases are read with the operator's own credentials. Nothing here
// impersonates a compiler or writes anything but through the gate api.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createCanaryEnv, loadDeployServices, http } from "./lib/canary-env.js";
import { verdict, GATE_BUCKET } from "./lib/c5a-gate-checks.js";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const flags = name => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const PHASES = ["baseline", "captures", "after", "judge"];
const phase = flag("--phase");
if (!PHASES.includes(phase)) {
  console.error(`usage: c5a-gate.js --phase <${PHASES.join("|")}> [--private-task id --public-task id --compose-task id --mixed-task id] [--evidence file]...`);
  process.exit(2);
}
const uid = flag("--uid", "995cc0bc98105563168b7fbee7b1e59a4256331c");
const connectionId = flag("--connection", "conn-686c62bc-b447-4dd8-bba8-60fd2b7a3cfd");
const project = flag("--project", "graffiticode");
const region = flag("--region", "us-central1");
const consoleAccount = flag("--console-account", "console-run@graffiticode-app.iam.gserviceaccount.com");
const gateService = flag("--gate-service", "api-c5a-gate");
const stateFile = flag("--state", new URL("../.gc-deploy/c5a-gate/state.json", import.meta.url).pathname);
const burst = Number(flag("--anonymous-burst", "12"));

const deploy = await loadDeployServices();
const authUrl = deploy.api.env.AUTH_URL;
const { gcloud, accessToken, idToken } = createCanaryEnv({ uid, project, region, authUrl });
const state = await readFile(stateFile, "utf8").then(JSON.parse, () => ({ runId: randomBytes(4).toString("hex"), observations: {} }));
const save = async () => {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
};
const observe = (key, value) => {
  state.observations[key] = value;
  console.log(`observed ${key}: ${JSON.stringify(value)}`);
};

// ------------------------------------------------------------- the operator

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
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`Firestore ${database}/${docPath}: ${res.status}`);
  return decode({ mapValue: res.json });
};
const docs = async (database, collectionPath) => {
  const res = await http({ method: "GET", url: `${firestore(database, collectionPath)}?pageSize=300`, headers: await asOperator() });
  if (res.status !== 200) throw new Error(`Firestore ${database}/${collectionPath}: ${res.status}`);
  return (res.json?.documents ?? []).map(d => decode({ mapValue: d }));
};
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const logs = async (filter, limit = 1000) => {
  const out = await gcloud(["logging", "read", filter, `--limit=${limit}`, "--format=json"]);
  return out ? JSON.parse(out) : [];
};

// The approval records released before C5a (Step 26's evidence names them):
// every approved revision of L0176 and L0000, as stored.
const approvalsDigest = async () => {
  const records = {};
  for (const lang of ["0176", "0000"]) records[lang] = (await docs("revisions", `languages/${lang}/revisions`)).sort((a, b) => String(a.revision).localeCompare(String(b.revision)));
  return digest(records);
};
// graffiticode.appspot.com's thumbnails/: names and generations.
const appspotListing = async () => {
  const out = await gcloud(["storage", "ls", "--json", "gs://graffiticode.appspot.com/thumbnails/"]).catch(() => "[]");
  const listed = JSON.parse(out || "[]").map(o => [o.url, o.metadata?.generation ?? null]).sort();
  return digest(listed);
};

// ------------------------------------------------------------ the gate api

const gateUrl = async () => (state.gateUrl ??= await gcloud(["run", "services", "describe", gateService, `--region=${region}`, "--format=value(status.url)"]));
// The console's invocation of the private gate api; the user's own token
// (or none, for an anonymous capture) in Authorization.
const asConsole = async userToken => ({
  "X-Serverless-Authorization": `Bearer ${await idToken(consoleAccount, await gateUrl())}`,
  ...(userToken ? { Authorization: userToken } : {}),
});
let canaryToken = null;
let canaryAt = 0;
const canary = async () => {
  if (Date.now() - canaryAt > 2 * 60_000) [canaryToken, canaryAt] = [await accessToken(), Date.now()];
  return canaryToken;
};
const command = async ({ id, key, userToken, connection = null }) => {
  const res = await http({ method: "POST", url: `${await gateUrl()}/command`, headers: await asConsole(userToken), body: { id, idempotencyKey: key, ...(connection ? { connectionId: connection } : {}) } });
  return { status: res.status, commandId: res.json?.data?.commandId ?? null, outcome: res.json?.data?.outcome ?? null, reason: res.json?.data?.reason ?? res.json?.error?.reason ?? null };
};
const anonymousCompile = async id => {
  const res = await http({ method: "POST", url: `${await gateUrl()}/compile`, headers: await asConsole(null), body: { id } });
  const envelope = res.json?.data ?? res.json;
  return { status: res.status, commandId: envelope?.command?.commandId ?? null, outcome: envelope?.command?.outcome ?? null, codes: (envelope?.errors ?? []).map(e => e.code) };
};

// A command's record, its reservations and its plan, from Policy's database.
const commandRecord = async commandId => {
  const record = await doc("policy", `commands/${encodeURIComponent(commandId)}`);
  const reservations = record ? await docs("policy", `commands/${encodeURIComponent(commandId)}/reservations`) : [];
  const plan = record?.admission?.planDigest ? await doc("policy", `plans/${record.admission.planDigest}`) : null;
  return { record, reservations, plan };
};
const approvalOf = async (lang, revision) => doc("revisions", `languages/${lang}/revisions/${revision}`);
const planObservation = async (name, { record, plan }) => {
  const stages = [];
  for (const [stage, admitted] of Object.entries(record?.admission?.stages ?? {}).sort()) {
    const approval = await approvalOf(admitted.lang, admitted.revision);
    const manifest = (plan?.stages ?? []).find(s => s.stage === stage) ?? {};
    stages.push({ stage, lang: admitted.lang, revision: admitted.revision, contractVersions: approval?.contractVersions ?? null, registryVersion: manifest.registryVersion ?? null });
  }
  return { name, stages, admitted: record?.phase === "admitted" || ["completed", "partial", "uncertain"].includes(record?.status) };
};
const published = async item => {
  const out = await gcloud(["storage", "objects", "describe", `gs://${GATE_BUCKET}/${item}.png`, "--format=json"]).catch(() => null);
  if (!out) return null;
  const meta = JSON.parse(out);
  const custom = meta.custom_fields ?? meta.metadata ?? {};
  return { bucket: GATE_BUCKET, captureSequence: custom.captureSequence === undefined ? null : Number(custom.captureSequence), generation: meta.generation ?? null };
};

// ------------------------------------------------------------------ phases

const need = name => {
  const v = flag(name);
  if (!v) throw new Error(`${name} is required for --phase ${phase}`);
  return v;
};
const key = name => `c5a-gate:${state.runId}:${name}`;

if (phase === "baseline") {
  state.baseline = { at: new Date().toISOString(), approvals: await approvalsDigest(), appspot: await appspotListing() };
  console.log(`baseline ${JSON.stringify(state.baseline)}`);
  await save();
}

if (phase === "captures") {
  if (!state.baseline) throw new Error("run --phase baseline first");
  const plans = [];
  // The owner's private capture.
  const owner = await command({ id: need("--private-task"), key: key("private"), userToken: await canary() });
  const ownerRec = await commandRecord(owner.commandId);
  const reservation = ownerRec.reservations[0] ?? null;
  observe("privateOwner", { outcome: ownerRec.record?.status ?? owner.outcome, reservedSequence: reservation?.captureSequence ?? null, published: reservation ? await published(reservation.item) : null });
  plans.push(await planObservation("private", ownerRec));
  // A non-owner's capture of the same item: refused at admission.
  const nonOwnerToken = process.env.C5A_NON_OWNER_TOKEN;
  if (nonOwnerToken) {
    const other = await command({ id: need("--private-task"), key: key("non-owner"), userToken: nonOwnerToken });
    const otherRec = other.commandId ? await commandRecord(other.commandId) : { record: null };
    observe("privateNonOwner", { outcome: otherRec.record?.status ?? other.outcome, reason: otherRec.record?.admissionRefusal?.reason ?? other.reason });
  } else {
    console.log("skipped privateNonOwner: set C5A_NON_OWNER_TOKEN to a non-owner's access token");
  }
  // The composition: an L0000 head over the private capture, connectionless.
  const composed = await command({ id: need("--compose-task"), key: key("compose"), userToken: await canary() });
  const composedRec = await commandRecord(composed.commandId);
  observe("composition", {
    outcome: composedRec.record?.status ?? composed.outcome,
    connectionId: composedRec.record ? composedRec.record.connectionId : "absent",
    contractVersion: composedRec.record?.admission?.contractVersion ?? null,
    itemScopeAuthorized: composedRec.reservations.length > 0 && composedRec.reservations.every(r => r.state === "staged" || r.state === "bound" || r.state === "reserved"),
  });
  plans.push(await planObservation("composition", composedRec));
  // The mixed chain, through the canary's connection: one invocation.
  const mixed = await command({ id: need("--mixed-task"), key: key("mixed"), userToken: await canary(), connection: connectionId });
  const mixedRec = await commandRecord(mixed.commandId);
  const brokerAudit = invocationId => logs([
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=\"broker\"",
    "jsonPayload.logName=\"security_audit\"",
    `jsonPayload.inv="${invocationId}"`,
  ].join(" AND "));
  const audit = mixedRec.record ? await brokerAudit(mixedRec.record.invocationId) : [];
  observe("mixed", {
    invocations: mixedRec.record ? 1 : 0,
    tokens: audit.filter(e => e.jsonPayload?.fn).map(e => ({ fn: e.jsonPayload.fn, scopeKinds: [...new Set([e.jsonPayload.scp?.kind ?? (e.jsonPayload.conn ? "connection" : null)].filter(Boolean))] })),
  });
  plans.push(await planObservation("mixed", mixedRec));
  // Anonymous captures of the public item, until one is rate-limited.
  const anonymous = [];
  for (let i = 0; i < burst; i++) {
    const out = await anonymousCompile(need("--public-task"));
    anonymous.push(out);
    if (out.codes.includes("rate-limited")) break;
  }
  const first = anonymous.find(a => a.commandId);
  const firstRec = first ? await commandRecord(first.commandId) : { record: null, reservations: [] };
  observe("publicAnonymous", {
    outcome: firstRec.record?.status ?? first?.outcome ?? null,
    subject: firstRec.record?.uid ?? null,
    publicCapture: firstRec.reservations[0]?.publicCapture ?? null,
    rateLimited: anonymous.some(a => a.codes.includes("rate-limited")),
  });
  state.commands = [owner, composed, mixed, ...anonymous].map(c => c.commandId).filter(Boolean);
  observe("plans", plans);
  await save();
}

if (phase === "after") {
  if (!state.baseline || !state.commands) throw new Error("run --phase baseline and --phase captures first");
  const approvals = await approvalsDigest();
  observe("approvals", { ...(state.observations.approvals ?? {}), beforeDigest: state.baseline.approvals, afterDigest: approvals });
  const thumbnails = await gcloud(["storage", "ls", "gs://graffiticode-thumbnails/"]).catch(() => "");
  observe("elsewhere", { appspotBefore: state.baseline.appspot, appspotAfter: await appspotListing(), thumbnailsObjects: thumbnails ? thumbnails.split("\n").filter(Boolean).length : 0 });
  // The production api never touches a gate command: no line of its names one.
  const lines = await logs([
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=\"api\"",
    `timestamp>="${state.baseline.at}"`,
    `(${state.commands.map(id => `textPayload:"${id}"`).join(" OR ")})`,
  ].join(" AND "));
  observe("oldWorkers", { listedToProduction: lines.filter(l => /due|list/i.test(l.textPayload ?? "")).length, sweeperLeases: lines.filter(l => /recovered|lease/i.test(l.textPayload ?? "")).length });
  await save();
}

if (phase === "judge") {
  const merged = { gateBucket: GATE_BUCKET, ...state.observations };
  for (const file of flags("--evidence")) Object.assign(merged, JSON.parse(await readFile(file, "utf8")));
  // The approved revisions the plans must pin: Step 26's and the compilers'.
  merged.approvals = {
    l0013r: { revision: flag("--l0013r", "l0013r-rmwl2casf-31e8b9"), contractVersions: [3] },
    l0000r: { revision: flag("--l0000r", "l0000r-rmw8gtkc2-830693"), contractVersions: [1, 2] },
    l0176r: { revision: flag("--l0176r", "l0176r-rmwk08k8n-c74227"), contractVersions: [1, 2] },
    ...merged.approvals,
  };
  const result = verdict(merged);
  for (const c of result.checks) console.log(`${c.ok ? "ok    " : "FAILED"} ${c.id}: ${c.detail}`);
  const report = path.join(path.dirname(stateFile), "report.json");
  await writeFile(report, `${JSON.stringify({ runId: state.runId, at: new Date().toISOString(), ...result, observations: merged }, null, 2)}\n`);
  console.log(`${result.passed ? "GATE PASSED" : "GATE NOT PASSED"}; report ${report}`);
  if (!result.passed) process.exit(1);
}
