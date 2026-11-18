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
//              rate-limited. Every anonymous command's id is saved as it is
//              allocated, and the burst's commands are retired as the due
//              phase's fixtures are (the one past the quota stays pending
//              otherwise; finished ones are left as they are), however the
//              burst ends. Each command's record, reservations and plan are
//              read from Policy's database with the operator's credentials, and
//              the published object from the gate bucket.
//   due        Policy's due query as the gateway: two pending v3 fixtures
//              (connectionless captures of the private item, allocated and
//              never run) and a v2 control (a connection command over
//              --control-task, an L0176 chain with no write, also never run).
//              Once their leases expire, the query is asked repeatedly as
//              production asks it (recording, repairs) and as a `scopes`
//              worker does, and production's takeover lease of a v3 fixture
//              is attempted (refused `worker-unsupported`). Every fixture's
//              id is saved the moment it is allocated, and all of them are
//              then retired without running (c5a-gate-fixtures.js: a fenced
//              takeover and an empty finish, recorded `failed`) and checked
//              no longer due, even when the phase fails part-way.
//   cleanup    the same retirement and check, alone, over the fixtures and
//              the quota commands: rerun after an interrupted captures, due
//              or cleanup phase. The gate isn't retired until it reports
//              every one finished and none due.
//   after      read-only: the same digests again, and graffiticode-thumbnails'
//              object count.
//   judge      the verdict over the state and every --evidence file, written
//              to <state dir>/report.json; exit 1 unless it passed.
//
// Inputs the operator prepares (task ids, created from the two owner-approved
// fixture items and listed in the evidence): --private-task (an L0013 capture
// of the private item), --public-task (of the public item), --compose-task (an
// L0000 head over the private capture), --mixed-task (the private capture plus
// an L0176 save), --control-task (an L0176 chain with no write: the due
// phase's v2 control). The non-owner (C5A_NON_OWNER_TOKEN) must be able to
// read --private-task, or the api's own task lookup refuses it (404) before
// Policy's item authority is asked: post the identical program as that
// account first, which adds it to that task's ACL only. --reference-private
// and --reference-public are the owner-approved reference renders (PNG) of the
// two fixture items; each scenario's published capture is read right after its
// command and must be identical to its item's reference (`images-correct`).
// Audit reads poll, bounded, until Cloud Logging has every record the run
// expects. Observations no gate-api call can make are given as JSON
// files with --evidence (repeatable), merged over what the phases recorded:
// `canary`, `repairRoundtrip`, `v2PlanDigest`, `v8Artifact`, `preSlice6`,
// `narrowed`, `mismatches`, `conditional`, `reserveStageBind`, `consoleRoute`,
// `proxy`, and `registryVersion` per plan stage when a plan record doesn't
// carry it. A missing one fails its check (c5a-gate-checks.js).
//
// Needs canary-window-c5a (Step 29): OpenIdTokenCreator on console-run, to
// call the private gate api as the console does, and on api-run, for the due
// phase's gateway calls to Policy (as B6's window had). Policy's and the
// revisions databases are read with the operator's own credentials. Nothing
// here impersonates a compiler; the only writes are through the gate api and
// the due phase's never-run command records.
//
// A run's baseline is written once: `--phase baseline` refuses a state that
// already has one, or whose captures have begun (start a new --state).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createCanaryEnv, loadDeployServices, http } from "./lib/canary-env.js";
import { ensureFixtures, retireFixtures, verifyRetired } from "./lib/c5a-gate-fixtures.js";
import { verdict, GATE_BUCKET, PUBLIC_CAPTURE_LIMIT, planObservation, planContractVersion, tokensFromAudit, brokerAuditFilter, rateLimitFromAudit, policyReserveFilter, dueObservation, pollUntil, reservesCover, imageObservation } from "./lib/c5a-gate-checks.js";
import { decodePng, imageLooks, compareImages } from "./lib/png.js";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const flags = name => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const PHASES = ["baseline", "captures", "due", "cleanup", "after", "judge"];
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
const gatewayAccount = flag("--gateway-account", "api-run@graffiticode.iam.gserviceaccount.com");
const gateService = flag("--gate-service", "api-c5a-gate");
const stateFile = flag("--state", new URL("../.gc-deploy/c5a-gate/state.json", import.meta.url).pathname);
// Bounded ingestion polling for audit reads (pollUntil).
const auditTimeoutMs = Number(flag("--audit-timeout-ms", "180000"));
const auditIntervalMs = Number(flag("--audit-interval-ms", "10000"));
// One past the quota, so a fresh fixture's last anonymous capture is refused.
const burst = Number(flag("--anonymous-burst", String(PUBLIC_CAPTURE_LIMIT + 1)));

const deploy = await loadDeployServices();
const authUrl = deploy.api.env.AUTH_URL;
const policyUrl = deploy.api.env.POLICY_URL;
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
// Every observation is collected through this: a read that fails is recorded
// as an error, which fails the gate (observations-read), never as an empty
// or default value.
const collect = async (key, read) => {
  try {
    observe(key, await read());
    if (state.observations.errors) delete state.observations.errors[key];
  } catch (e) {
    state.observations.errors = { ...(state.observations.errors ?? {}), [key]: String(e?.message ?? e).slice(0, 300) };
    console.log(`FAILED to observe ${key}: ${state.observations.errors[key]}`);
  }
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
// An audit read that waits, bounded, for Cloud Logging to ingest what the run
// expects (`done`): the entries, and how the poll went.
const polledLogs = async (filter, done) => {
  const { value, attempts, timedOut } = await pollUntil({ read: () => logs(filter), done, timeoutMs: auditTimeoutMs, intervalMs: auditIntervalMs });
  return { entries: value, poll: { attempts, timedOut } };
};

// The approval records released before C5a (Step 26's evidence names them):
// every approved revision of L0176 and L0000, as stored.
const approvalsDigest = async () => {
  const records = {};
  for (const lang of ["0176", "0000"]) records[lang] = (await docs("revisions", `languages/${lang}/revisions`)).sort((a, b) => String(a.revision).localeCompare(String(b.revision)));
  return digest(records);
};
// graffiticode.appspot.com's thumbnails/: names and generations. A failed
// read throws.
const appspotListing = async () => {
  const out = await gcloud(["storage", "ls", "--json", "gs://graffiticode.appspot.com/thumbnails/"]);
  const listed = JSON.parse(out || "[]").map(o => [o.url, o.metadata?.generation ?? null]).sort();
  if (listed.length === 0) throw new Error("the appspot thumbnails listing is empty");
  return digest(listed);
};
// graffiticode-thumbnails' object count: 0 when the bucket doesn't exist
// (C5b creates it); any other failure throws.
const thumbnailsCount = async () => {
  const exists = await gcloud(["storage", "buckets", "describe", "gs://graffiticode-thumbnails", "--format=value(name)"]).then(() => true, e => {
    if (/not found|404/i.test(String(e?.message ?? e))) return false;
    throw e;
  });
  if (!exists) return 0;
  const out = await gcloud(["storage", "ls", "gs://graffiticode-thumbnails/"]);
  return out.split("\n").filter(Boolean).length;
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
// Whose item each published capture is: the reservation of a command.
const reservedItem = rec => rec.reservations[0]?.item ?? null;
const anonymousCompile = async id => {
  const res = await http({ method: "POST", url: `${await gateUrl()}/compile`, headers: await asConsole(null), body: { id } });
  const envelope = res.json?.data ?? res.json;
  return { status: res.status, commandId: envelope?.command?.commandId ?? null, outcome: envelope?.command?.outcome ?? null, codes: (envelope?.errors ?? []).map(e => e.code) };
};

// A command's record, its reservations and its plan, from Policy's database.
const commandRecord = async commandId => {
  const record = await doc("policy", `commands/${encodeURIComponent(commandId)}`);
  const reservations = record ? await docs("policy", `commands/${encodeURIComponent(commandId)}/reservations`) : [];
  // The stored plan document: { plan: { stages, ... }, invocationId, revisions }.
  const planDoc = record?.admission?.planDigest ? await doc("policy", `plans/${record.admission.planDigest}`) : null;
  return { record, reservations, planDoc };
};
// A scenario's plan, with the approval record of each revision it pins.
const observePlan = async (name, rec) => {
  if (!rec.record) throw new Error(`${name}: no command record`);
  const approvals = {};
  for (const admitted of Object.values(rec.record.admission?.stages ?? {})) {
    approvals[`${admitted.lang}/${admitted.revision}`] = await doc("revisions", `languages/${admitted.lang}/revisions/${admitted.revision}`);
  }
  return planObservation(name, rec, approvals);
};
const published = async item => {
  const out = await gcloud(["storage", "objects", "describe", `gs://${GATE_BUCKET}/${item}.png`, "--format=json"]).catch(() => null);
  if (!out) return null;
  const meta = JSON.parse(out);
  const custom = meta.custom_fields ?? meta.metadata ?? {};
  return { bucket: GATE_BUCKET, captureSequence: custom.captureSequence === undefined ? null : Number(custom.captureSequence), generation: meta.generation ?? null };
};

// The owner-approved reference renders of the two fixture items.
const references = {};
const reference = async kind => {
  if (!references[kind]) {
    const file = need(`--reference-${kind}`);
    const bytes = await readFile(file);
    references[kind] = { file, bytes, image: decodePng(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  return references[kind];
};
// A scenario's published capture, read right after its command (the object is
// overwritten by the next capture of the item), kept beside the state, and
// compared with its item's reference. Any failed read throws.
const images = [];
const snapshotImage = async ({ scenario, item, expectedCommandIds, kind }) => {
  const object = `gs://${GATE_BUCKET}/${item}.png`;
  const meta = JSON.parse(await gcloud(["storage", "objects", "describe", object, "--format=json"]));
  const custom = meta.custom_fields ?? meta.metadata ?? {};
  const dir = path.join(path.dirname(stateFile), "images");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${scenario}-${meta.generation}.png`);
  await gcloud(["storage", "cp", `${object}#${meta.generation}`, file]);
  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (custom.sha256 && custom.sha256 !== sha256) throw new Error(`${scenario}: downloaded ${sha256}, the object names ${custom.sha256}`);
  const image = decodePng(bytes);
  const ref = await reference(kind);
  const observed = imageObservation({
    scenario,
    expectedCommandIds,
    object: { commandId: custom.commandId ?? null, generation: meta.generation ?? null, captureSequence: custom.captureSequence === undefined ? null : Number(custom.captureSequence) },
    looks: imageLooks(image),
    comparison: compareImages(image, ref.image),
    reference: kind,
    sha256,
  });
  images.push({ ...observed, file });
  console.log(`image ${scenario}: ${JSON.stringify(observed)}`);
  await recordCapture({ scenario, item, observed }).catch(e => {
    rsbCaptures.push({ scenario, item, error: String(e?.message ?? e).slice(0, 200) });
  });
};
// The live reserve/stage/bind evidence of each scenario's published capture
// (the #421 review): the command the object names, that command's reservation
// for the item and its bind record for the same occurrence, so the order and
// both sequences belong to one occurrence (rsbCaptureProblem judges it).
const rsbCaptures = [];
const recordCapture = async ({ scenario, item, observed }) => {
  const commandId = observed.commandId;
  if (!commandId) throw new Error("the object names no command");
  const id = encodeURIComponent(commandId);
  const reservations = (await docs("policy", `commands/${id}/reservations`)).filter(r => r.item === item);
  const reservation = reservations.length === 1 ? reservations[0] : null;
  const bound = reservation ? await doc("policy", `commands/${id}/occurrences/${encodeURIComponent(`${reservation.stage}:${reservation.occurrenceId}`)}`) : null;
  const entry = {
    scenario, item, commandId, objectCommandId: observed.commandId, objectGeneration: observed.generation,
    reservations: reservations.length, occurrenceId: reservation?.occurrenceId ?? null, boundOccurrenceId: bound?.occurrenceId ?? null,
    reservedAt: reservation?.reservedAt ?? null, stagedAt: reservation?.stagedAt ?? null, boundAt: bound?.boundAt ?? null,
    reservedSequence: reservation?.captureSequence ?? null, publishedSequence: observed.captureSequence,
  };
  rsbCaptures.push(entry);
  console.log(`reserve/stage/bind ${scenario}: ${JSON.stringify(entry)}`);
};
const recordImages = async () => {
  for (const kind of ["private", "public"]) await reference(kind);
  return {
    references: Object.fromEntries(Object.entries(references).map(([kind, r]) => [kind, { file: r.file, sha256: r.sha256, width: r.image.width, height: r.image.height }])),
    captures: images,
  };
};

// Policy's gateway command routes, as the gateway (canary-window-c5a covers
// api-run), for retiring the commands a run leaves pending: the captures
// phase's quota commands, and the due phase's fixtures.
const gatewayClient = () => {
  const headers = async (user = null) => ({
    "X-Serverless-Authorization": `Bearer ${await idToken(gatewayAccount, policyUrl)}`,
    "X-Caller-Identity": await idToken(gatewayAccount, "urn:graffiticode:policy"),
    ...(user ? { Authorization: `Bearer ${user}` } : {}),
  });
  const call = async (method, route, { body, user = null } = {}) => {
    const res = await http({ method, url: `${policyUrl}${route}`, headers: await headers(user), body });
    if (res.status !== 200 || res.json?.status !== "success") {
      throw Object.assign(new Error(`policy ${method} ${route}: ${res.status} ${res.json?.error?.reason ?? ""}`), { reason: res.json?.error?.reason ?? null });
    }
    return res.json.data;
  };
  const at = id => `/v1/commands/${encodeURIComponent(id)}`;
  return {
    allocate: async body => call("POST", "/v1/commands", { body, user: await canary() }),
    get: id => call("GET", at(id)),
    lease: (id, body) => call("POST", `${at(id)}/lease`, { body }),
    finish: (id, generation) => call("POST", `${at(id)}/finish`, { body: { generation, result: null } }),
    due: ({ scopes }) => call("GET", `/v1/commands-due?limit=50&recording=1&repairs=1${scopes ? "&scopes=1" : ""}`),
  };
};
const fixtureWorker = () => `c5a-gate-fixture:${state.runId}`;
// Every command this run may leave executable: the due phase's fixtures and
// every anonymous command of the quota burst (the one past the quota is
// refused its reservation and stays pending). Each id is saved the moment it
// is known. retireFixtures() leaves a finished command as it is, so the
// burst's completed captures keep their results.
const retirable = () => [...Object.values(state.fixtures ?? {}), ...(state.quotaCommands ?? [])];
const retireAll = async client => {
  const ids = retirable();
  if (!ids.length) return;
  await collect("fixtureCleanup", async () => {
    await retireFixtures({ client, ids, worker: fixtureWorker() });
    return verifyRetired({ client, ids });
  });
  await save();
};

// ------------------------------------------------------------------ phases

const need = name => {
  const v = flag(name);
  if (!v) throw new Error(`${name} is required for --phase ${phase}`);
  return v;
};
const key = name => `c5a-gate:${state.runId}:${name}`;

if (phase === "baseline") {
  // Written once per run, never rebased: a later baseline would hide what
  // the run's captures changed. (A baseline whose read failed saved nothing.)
  if (state.baseline || state.capturesStartedAt || state.commands) throw new Error(`this run's baseline is fixed${state.capturesStartedAt ? ` (captures started at ${state.capturesStartedAt})` : ""}; start a new --state`);
  // A baseline read that fails stops here: nothing is compared against it.
  state.baseline = { at: new Date().toISOString(), approvals: await approvalsDigest(), appspot: await appspotListing() };
  console.log(`baseline ${JSON.stringify(state.baseline)}`);
  await save();
}

if (phase === "captures") {
  if (!state.baseline) throw new Error("run --phase baseline first");
  // Recorded, and saved, before the first write.
  state.capturesStartedAt ??= new Date().toISOString();
  await save();
  const plans = [];
  const planOf = async (name, rec) => {
    try {
      plans.push(await observePlan(name, rec));
    } catch (e) {
      state.observations.errors = { ...(state.observations.errors ?? {}), [`plan:${name}`]: String(e?.message ?? e) };
    }
  };
  // Each scenario's published image, read before the next capture of its item
  // overwrites it; a failed read is recorded, and fails the gate.
  const imageOf = async (scenario, rec, expectedCommandIds, kind) => {
    try {
      const item = reservedItem(rec);
      if (!item) throw new Error("no reservation, so no published capture");
      await snapshotImage({ scenario, item, expectedCommandIds, kind });
    } catch (e) {
      state.observations.errors = { ...(state.observations.errors ?? {}), [`image:${scenario}`]: String(e?.message ?? e).slice(0, 300) };
    }
  };
  // The owner's private capture.
  const owner = await command({ id: need("--private-task"), key: key("private"), userToken: await canary() });
  const ownerRec = await commandRecord(owner.commandId);
  await imageOf("private", ownerRec, [owner.commandId], "private");
  await collect("privateOwner", async () => {
    const reservation = ownerRec.reservations[0];
    if (!reservation) throw new Error("the owner's capture has no reservation");
    const object = await published(reservation.item);
    if (!object) throw new Error(`nothing published at gs://${GATE_BUCKET}/${reservation.item}.png`);
    return { outcome: ownerRec.record?.status ?? owner.outcome, reservedSequence: reservation.captureSequence ?? null, published: object };
  });
  await planOf("private", ownerRec);
  // A non-owner's capture of the same item: refused at admission.
  await collect("privateNonOwner", async () => {
    const nonOwnerToken = process.env.C5A_NON_OWNER_TOKEN;
    if (!nonOwnerToken) throw new Error("set C5A_NON_OWNER_TOKEN to a non-owner's access token");
    const other = await command({ id: need("--private-task"), key: key("non-owner"), userToken: nonOwnerToken });
    const otherRec = other.commandId ? await commandRecord(other.commandId) : { record: null };
    // `status` tells Policy's refusal (a command, failed `not-owner`) from the
    // api's own task lookup (404, no command): the latter means the non-owner
    // can't read --private-task, and Policy was never asked.
    return { outcome: otherRec.record?.status ?? other.outcome, reason: otherRec.record?.admissionRefusal?.reason ?? other.reason, status: other.status, commandId: other.commandId };
  });
  // The composition: an L0000 head over the private capture, connectionless.
  const composed = await command({ id: need("--compose-task"), key: key("compose"), userToken: await canary() });
  const composedRec = await commandRecord(composed.commandId);
  await imageOf("composition", composedRec, [composed.commandId], "private");
  await collect("composition", async () => {
    if (!composedRec.record) throw new Error("no command record for the composition");
    return {
      outcome: composedRec.record.status,
      connectionId: composedRec.record.connectionId,
      contractVersion: planContractVersion(composedRec.planDoc),
      itemScopeAuthorized: composedRec.reservations.length > 0,
    };
  });
  await planOf("composition", composedRec);
  // The mixed chain, through the canary's connection: one invocation, each
  // execution token with only its own scope (Broker's execute audit).
  const mixed = await command({ id: need("--mixed-task"), key: key("mixed"), userToken: await canary(), connection: connectionId });
  const mixedRec = await commandRecord(mixed.commandId);
  await imageOf("mixed", mixedRec, [mixed.commandId], "private");
  await collect("mixed", async () => {
    if (!mixedRec.record) throw new Error("no command record for the mixed chain");
    // Both stages' execute records, once Cloud Logging has them.
    const bothStages = entries => ["snap", "save-to-itembank"].every(fn => tokensFromAudit(entries).some(t => t.fn === fn));
    const { entries, poll } = await polledLogs(brokerAuditFilter(mixedRec.record.invocationId), bothStages);
    const tokens = tokensFromAudit(entries);
    if (!tokens.length) throw new Error(`no Broker execute record for ${mixedRec.record.invocationId}`);
    return { invocations: 1, tokens, auditPoll: poll };
  });
  await planOf("mixed", mixedRec);
  // Anonymous captures of the public item, one past the quota; the quota's
  // evidence is Policy's own reservation audit for the item.
  const burstFrom = new Date().toISOString();
  const anonymous = [];
  state.quotaCommands ??= [];
  try {
    for (let i = 0; i < burst; i++) {
      const a = await anonymousCompile(need("--public-task"));
      anonymous.push(a);
      // Saved before the next capture: an interrupted run's cleanup finds it.
      if (a.commandId && !state.quotaCommands.includes(a.commandId)) {
        state.quotaCommands.push(a.commandId);
        await save();
      }
    }
  } finally {
    // The command past the quota is never left executable.
    await retireAll(gatewayClient());
  }
  const anonymousIds = anonymous.map(a => a.commandId).filter(Boolean);
  const firstAnonymous = anonymous.find(a => a.commandId);
  const firstAnonymousRec = firstAnonymous ? await commandRecord(firstAnonymous.commandId) : { record: null, reservations: [] };
  // The public object ends on the burst's last published capture.
  await imageOf("public", firstAnonymousRec, anonymousIds, "public");
  await collect("publicAnonymous", async () => {
    if (!firstAnonymous) throw new Error("no anonymous capture allocated a command");
    const rec = firstAnonymousRec;
    const item = rec.reservations[0]?.item;
    if (!item) throw new Error("the first anonymous capture has no reservation");
    // Every allocated command's reserve, allowed or refused, once ingested.
    const { entries, poll } = await polledLogs(policyReserveFilter(item, burstFrom), reservesCover(anonymousIds));
    return {
      outcome: rec.record?.status ?? firstAnonymous.outcome,
      subject: rec.record?.uid ?? null,
      publicCapture: rec.reservations[0]?.publicCapture ?? null,
      rateLimit: { ...rateLimitFromAudit(entries), attempted: anonymous.length },
      commandIds: anonymousIds,
      auditPoll: poll,
    };
  });
  state.commands = [owner, composed, mixed, ...anonymous].map(c => c.commandId).filter(Boolean);
  observe("plans", plans);
  await collect("images", recordImages);
  await collect("reserveStageBind", async () => {
    const failed = rsbCaptures.filter(c => c.error);
    if (failed.length) throw new Error(`reserve/stage/bind reads failed: ${failed.map(c => `${c.scenario}: ${c.error}`).join("; ")}`);
    return { captures: rsbCaptures };
  });
  await save();
}

if (phase === "due") {
  if (!state.capturesStartedAt) throw new Error("run --phase captures first");
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const client = gatewayClient();
  const spec = (name, { id, connection, scopes }) => ({
    name,
    body: { connectionId: connection, taskId: id, inputDigest: createHash("sha256").update("{}").digest("hex"), idempotencyKey: key(name), lang: "0013", request: JSON.stringify({ id, connectionId: connection, options: {} }), worker: fixtureWorker(), create: true, ...(scopes ? { scopes: 1 } : {}) },
  });
  try {
    await collect("oldWorkers", async () => {
      const fixtures = await ensureFixtures({
        client,
        state,
        save,
        specs: [
          spec("v3-fixture-1", { id: need("--private-task"), connection: null, scopes: true }),
          spec("v3-fixture-2", { id: need("--private-task"), connection: null, scopes: true }),
          spec("v2-control", { id: need("--control-task"), connection: connectionId, scopes: false }),
        ],
      });
      const v3Fixtures = [fixtures["v3-fixture-1"], fixtures["v3-fixture-2"]];
      const control = fixtures["v2-control"];
      // Their leases (60 s) expire; then the due query, as each worker asks it.
      await sleep(62_000);
      const productionQueries = [];
      const scopedQueries = [];
      const seen = (queries, id) => queries.some(q => (q.commands ?? []).some(c => c.commandId === id));
      for (let i = 0; i < 10 && !(seen(productionQueries, control) && seen(scopedQueries, control)); i++) {
        productionQueries.push(await client.due({ scopes: false }));
        scopedQueries.push(await client.due({ scopes: true }));
        await sleep(2_000);
      }
      // Production's takeover lease of a v3 fixture, with its capabilities.
      let productionLease;
      try {
        await client.lease(v3Fixtures[0], { worker: "c5a-gate-production-probe", generation: 1, takeOver: true, recording: 1, repairs: 1 });
        productionLease = "leased";
      } catch (e) {
        if (!e?.reason) throw e;
        productionLease = e.reason;
      }
      return dueObservation({ v3Fixtures, control, productionQueries, scopedQueries, productionLease });
    });
    await save();
  } finally {
    // Never left executable: retired however the phase ended.
    await retireAll(client);
  }
}

if (phase === "cleanup") {
  if (!retirable().length) throw new Error("no fixtures or quota commands recorded in this state");
  await retireAll(gatewayClient());
}

if (phase === "after") {
  if (!state.baseline || !state.commands) throw new Error("run --phase baseline and --phase captures first");
  await collect("approvals", async () => ({ ...(state.observations.approvals ?? {}), beforeDigest: state.baseline.approvals, afterDigest: await approvalsDigest() }));
  await collect("elsewhere", async () => ({ appspotBefore: state.baseline.appspot, appspotAfter: await appspotListing(), thumbnailsObjects: await thumbnailsCount() }));
  await save();
}

if (phase === "judge") {
  const merged = { gateBucket: GATE_BUCKET, ...state.observations };
  for (const file of flags("--evidence")) {
    const evidence = JSON.parse(await readFile(file, "utf8"));
    const { hermetic, ...rest } = evidence;
    Object.assign(merged, rest);
    if (hermetic) merged.hermetic = { ...(merged.hermetic ?? {}), ...hermetic };
  }
  // The commit each service serves now, from its 100% revision's release
  // receipt: hermetic evidence must name it.
  const deployedCommit = async service => {
    const traffic = JSON.parse(await gcloud(["run", "services", "describe", service, `--region=${region}`, "--format=json"])).status?.traffic ?? [];
    const revision = traffic.find(t => t.percent === 100)?.revisionName;
    if (!revision) throw new Error(`${service}: no revision serves 100%`);
    const receipt = JSON.parse(await readFile(new URL(`../.gc-deploy/releases/${revision.slice(service.length + 1)}.json`, import.meta.url), "utf8"));
    if (receipt.revision !== revision || !receipt.commit) throw new Error(`${service}: the receipt for ${revision} doesn't name it`);
    return receipt.commit;
  };
  merged.deployed = {};
  for (const service of ["policy", "broker", "l0013r"]) {
    try {
      merged.deployed[service] = await deployedCommit(service);
    } catch (e) {
      merged.errors = { ...(merged.errors ?? {}), [`deployed:${service}`]: String(e?.message ?? e) };
    }
  }
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
