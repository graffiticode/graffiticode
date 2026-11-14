// B6's drive (docs/b6-command-repair-plan.md slice 5, "The drive, in detail"):
// repairs and materializations through api-drive -> l0176r-drive ->
// broker-faults, as the canary account through its sandbox connection only.
//
//   node scripts/b6-drive.js --phase <phase> [--source gs://<bucket>/<object>]
//
// Phases, in order (state accumulates in --state, default
// .gc-deploy/b6-drive/state.json). Each refuses to run unless the services'
// fault settings are the ones it needs, and stops on any failed check.
//   checks           read-only: the routing and fault principals, l0176r-drive's
//                    serving revision approved and `replay: 1` at preflight,
//                    REPAIR_L0176 on at api-drive, the source readable, and
//                    every drive program compiling with no connection.
//   originals-fail   BROKER_FAULTS=fail-write: the failed-only originals (one,
//                    two, map of 3; two each), the exclusion original, and two
//                    L0176 -> L0176 originals whose lower save fails.
//   originals-drop   BROKER_FAULTS=drop-outcome: two one-save originals (head
//                    lost), two L0176 -> L0176 originals (lower lost), and two
//                    L0185 -> L0176 originals over the source (head lost).
//   originals-narrow no faults: two saves in a 2-element map, narrowed to
//                    `init` once the first has its final outcome (A completed,
//                    B failed), and one 10-element map narrowed once the first
//                    write is claimed (a `partial` occurrence).
//   probes           no faults: selecting a completed, a partial and an
//                    uncertain occurrence, and asking the uncertain command
//                    with no selection; each refused, with no ledger entry,
//                    claim or dispatch.
//   repairs          no faults: a repair of each failed-only, partly
//                    completed and L0176 -> L0176 original.
//   exclusion        no faults: 8 concurrent repairs of the exclusion original.
//   reconcile        each drop-outcome original's writes through Policy's
//                    /v1/receipts/reconcile, as the console.
//   dropped          no faults: /materialize the head-lost originals, and
//                    repair the lower-lost ones (the lower stage rebuilt).
//   boundary         api-drive API_COMMAND_FAULTS=exit-after-output: L0185 ->
//                    L0176 over the source; the source changed after the exit;
//                    the production sweeper finishes from the recorded output.
//   source-change    no faults: the L0185 -> L0176 drop-outcome originals,
//                    reconciled, materialized after the source changed.
//   retries          every counted repair again, by its key.
//   report           the count of distinct completed repairs, and the
//                    dispatch evidence for every original and repair.
//
// Evidence comes from Policy's gateway reads (the gateway's identity), the
// api's call lines and Broker's audit in Cloud Logging, l0185r's request log,
// and the egress proxy's log. Narrowing is timed on Broker's receipts, read
// with the operator's own credentials, as C6's drive did; so are the revision
// approval check. Needs the canary window (docs/capability-policy-iam-review.md
// Step 24): Secret Manager `canary-api-key`, and
// roles/iam.serviceAccountOpenIdTokenCreator on api-run and console-run.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createCanaryEnv, loadDeployServices, http, serviceEnv } from "./lib/canary-env.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const PHASES = ["checks", "originals-fail", "originals-drop", "originals-narrow", "probes", "repairs", "exclusion", "reconcile", "dropped", "boundary", "source-change", "retries", "report"];
const phase = flag("--phase");
if (!PHASES.includes(phase)) {
  console.error(`usage: node scripts/b6-drive.js --phase ${PHASES.join("|")} [--source gs://bucket/object]`);
  process.exit(2);
}
const uid = flag("--uid", "995cc0bc98105563168b7fbee7b1e59a4256331c");
const connectionId = flag("--connection", "conn-686c62bc-b447-4dd8-bba8-60fd2b7a3cfd");
const project = flag("--project", "graffiticode");
const region = flag("--region", "us-central1");
const stateFile = flag("--state", new URL("../.gc-deploy/b6-drive/state.json", import.meta.url).pathname);
const gatewayAccount = "api-run@graffiticode.iam.gserviceaccount.com";
const consoleAccount = flag("--console-account", "console-run@graffiticode-app.iam.gserviceaccount.com");

const deploy = await loadDeployServices();
const authUrl = deploy.l0176r.env.AUTH_URL;
const policyUrl = deploy.api.env.POLICY_URL;
let apiUrl = null;
const { gcloud, accessToken, idToken, parse } = createCanaryEnv({ uid, project, region, authUrl, apiUrl: () => apiUrl });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const describe = async name => JSON.parse(await gcloud(["run", "services", "describe", name, `--region=${region}`, "--format=json"]));

const state = await readFile(stateFile, "utf8").then(JSON.parse, () => ({ runs: [], originals: [], repairs: [], probes: [], materialized: [], boundary: [], retries: [] }));
const save = async () => {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n");
};
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok    " : "FAILED"} ${name}: ${detail}`);
};

// ---------------------------------------------------------------- identities

// ID tokens last an hour; each is fetched once per audience per run.
const tokens = new Map();
const tokenFor = async (account, audience) => {
  const k = `${account} ${audience}`;
  if (!tokens.has(k)) tokens.set(k, await idToken(account, audience));
  return tokens.get(k);
};
const asPolicyCaller = async account => ({
  "X-Serverless-Authorization": `Bearer ${await tokenFor(account, policyUrl)}`,
  "X-Caller-Identity": await tokenFor(account, "urn:graffiticode:policy"),
});
// The canary's access token (300 s), refreshed well before it expires.
let userToken = null;
let userTokenAt = 0;
const asUser = async () => {
  if (Date.now() - userTokenAt > 2 * 60_000) [userToken, userTokenAt] = [await accessToken(), Date.now()];
  return { Authorization: userToken };
};

// Policy's gateway reads: what the api's worker reads.
const policyRead = async (commandId, what, stage = null) => {
  const res = await http({
    method: "GET",
    url: `${policyUrl}/v1/commands/${encodeURIComponent(commandId)}/records/${what}${stage ? `?stage=${stage}` : ""}`,
    headers: await asPolicyCaller(gatewayAccount),
  });
  if (res.status !== 200) throw new Error(`policy read ${what} of ${commandId}: ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
  return res.json.data;
};
const commandIdFor = key => `c:${createHash("sha256").update(JSON.stringify([uid, key])).digest("hex")}`;

// --------------------------------------------- the operator's reads (as C6)

let operatorToken;
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
const firestoreDoc = async (database, docPath) => {
  operatorToken ??= await gcloud(["auth", "print-access-token"]);
  const res = await http({ method: "GET", url: `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents/${docPath}`, headers: { Authorization: `Bearer ${operatorToken}` } });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`Firestore ${database}/${docPath}: ${res.status}`);
  return decode({ mapValue: res.json });
};
// Broker's write claims for an invocation, and how many have a final outcome.
const claimsOf = async invocationId => {
  operatorToken ??= await gcloud(["auth", "print-access-token"]);
  const range = (op, value) => ({ fieldFilter: { field: { fieldPath: "operationId" }, op, value: { stringValue: value } } });
  const where = { compositeFilter: { op: "AND", filters: [range("GREATER_THAN_OR_EQUAL", `${invocationId}/`), range("LESS_THAN", `${invocationId}/`)] } };
  const structuredQuery = { from: [{ collectionId: "receipts" }], where, select: { fields: [{ fieldPath: "operationId" }] } };
  const res = await http({ method: "POST", url: `https://firestore.googleapis.com/v1/projects/${project}/databases/broker/documents:runQuery`, headers: { Authorization: `Bearer ${operatorToken}` }, body: { structuredQuery } });
  return (Array.isArray(res.json) ? res.json : []).filter(r => r.document).map(r => r.document.fields.operationId.stringValue);
};
const finishedClaims = async invocationId => {
  const ids = await claimsOf(invocationId);
  let done = 0;
  for (const op of ids) {
    const name = createHash("sha256").update(op).digest("hex");
    if (await firestoreDoc("broker", `receipts/${name}/outcome/final`)) done++;
  }
  return { claims: ids.length, done };
};

// ------------------------------------------------------------------- logs

const logs = async (filter, limit = 1000) => {
  const out = await gcloud(["logging", "read", filter, `--limit=${limit}`, "--format=json"]);
  return out ? JSON.parse(out) : [];
};
const since = iso => `timestamp>="${iso}"`;
// Broker's audit for a set of operation ids: claims (execute, not a replay or
// a denial) and provider dispatches (execute-step, purpose dispatch).
const brokerAudit = async (opids, from) => {
  const found = new Map(opids.map(o => [o, { claims: 0, dispatches: 0, replays: 0 }]));
  for (let i = 0; i < opids.length; i += 20) {
    const chunk = opids.slice(i, i + 20);
    const filter = [
      "resource.type=\"cloud_run_revision\"",
      "(resource.labels.service_name=\"broker-faults\" OR resource.labels.service_name=\"broker\")",
      "jsonPayload.logName=\"security_audit\"",
      `(${chunk.map(o => `jsonPayload.opid="${o}"`).join(" OR ")})`,
      since(from),
    ].join(" AND ");
    for (const entry of await logs(filter)) {
      const p = entry.jsonPayload ?? {};
      const at = found.get(p.opid);
      if (!at) continue;
      if (p.event === "execute-step" && p.purpose === "dispatch") at.dispatches++;
      else if (p.event === "execute" && p.outcome === "replayed") at.replays++;
      else if (p.event === "execute" && p.outcome !== "denied") at.claims++;
    }
  }
  return found;
};
// The api's call lines for one command (api-drive's and the production api's).
const callLines = async (commandId, from) => {
  const filter = [
    "resource.type=\"cloud_run_revision\"",
    "(resource.labels.service_name=\"api-drive\" OR resource.labels.service_name=\"api\")",
    `textPayload:"command ${commandId}:"`,
    since(from),
  ].join(" AND ");
  return (await logs(filter)).map(e => e.textPayload).filter(Boolean).reverse();
};
// Requests l0185r answered at /interpret in a window.
const l0185Requests = async (from, to) => (await logs([
  "resource.type=\"cloud_run_revision\"", "resource.labels.service_name=\"l0185r\"", "httpRequest.requestUrl:\"/interpret\"", since(from), `timestamp<="${to}"`,
].join(" AND "))).length;
// The egress proxy's lines for the source object's path.
const proxyFetches = async (objectPath, from) => (await logs([`textPayload:"${objectPath}"`, since(from)].join(" AND "))).length;

// -------------------------------------------------------------- programs

const ITEM = "item [questions [mcq []] {}]";
const SHAPES = {
  one: { writes: 1, src: tag => `set-var "lrn-id" "${tag}" save-to-itembank items [${ITEM}] {}..` },
  two: { writes: 2, src: tag => `set-var "lrn-id" "${tag}" [save-to-itembank items [${ITEM}] {} save-to-itembank items [${ITEM}] {}]..` },
  map2: { writes: 2, src: tag => `set-var "lrn-id" "${tag}" map (<x: save-to-itembank items [${ITEM}] {}>) [1 2]..` },
  map3: { writes: 3, src: tag => `set-var "lrn-id" "${tag}" map (<x: save-to-itembank items [${ITEM}] {}>) [1 2 3]..` },
  long: { writes: 10, src: tag => `set-var "lrn-id" "${tag}" map (<x: save-to-itembank items [${ITEM}] {}>) [1 2 3 4 5 6 7 8 9 10]..` },
  // Over the source: the item id comes from what L0185 fetched.
  fromSource: { writes: 1, src: () => `set-var "lrn-id" get "tag" data {} save-to-itembank items [${ITEM}] {}..` },
};
// `fetch "<url>" {}..`, as L0185's parser writes it.
const fetchTask = url => ({ lang: "0185", code: { 1: { tag: "STR", elts: [url] }, 2: { tag: "RECORD", elts: [] }, 3: { tag: "FETCH", elts: [1, 2] }, 4: { tag: "EXPRS", elts: [3] }, 5: { tag: "PROG", elts: [4] }, root: 5 } });

const source = flag("--source", null);
const sourceParts = source ? /^gs:\/\/([^/]+)\/(.+)$/.exec(source) : null;
const sourceUrl = sourceParts ? `https://www.googleapis.com/storage/v1/b/${sourceParts[1]}/o/${encodeURIComponent(sourceParts[2])}?alt=media` : null;
const sourcePath = sourceParts ? `/storage/v1/b/${sourceParts[1]}/o/${encodeURIComponent(sourceParts[2])}` : null;
const needSource = () => {
  if (!sourceUrl) throw new Error("this phase needs --source gs://<bucket>/<object>");
};
const setSource = async tag => {
  const file = path.join(tmpdir(), `b6-drive-source-${randomBytes(4).toString("hex")}.json`);
  await writeFile(file, JSON.stringify({ tag }));
  await gcloud(["storage", "cp", file, source, "--content-type=application/json", "--cache-control=no-store"]);
  for (let i = 0; i < 20; i++) {
    const read = await http({ method: "GET", url: sourceUrl });
    if (read.json?.tag === tag) return;
    await sleep(1000);
  }
  throw new Error(`the source didn't come to read ${tag}`);
};

// ------------------------------------------------------------ the routes

const routing = async () => {
  const [api, compiler, broker] = await Promise.all([describe("api-drive"), describe("l0176r-drive"), describe("broker-faults")]);
  return {
    apiUrl: api.status.url,
    apiEnv: serviceEnv(api),
    compilerUrl: compiler.status.url,
    compilerEnv: serviceEnv(compiler),
    compilerRevision: compiler.status.traffic.find(t => t.percent === 100)?.revisionName ?? compiler.status.latestReadyRevisionName,
    brokerUrl: broker.status.url,
    brokerEnv: serviceEnv(broker),
  };
};
const route = await routing();
apiUrl = route.apiUrl;
const runId = randomBytes(3).toString("hex");
const startedAt = new Date().toISOString();
state.runs.push({ runId, phase, startedAt });
console.log(`b6 drive ${phase} ${runId}: canary ${uid} on ${connectionId} via ${apiUrl}; l0176r-drive ${route.compilerRevision}`);
const brokerFault = route.brokerEnv.BROKER_FAULTS ?? null;
const apiFaults = (route.apiEnv.API_COMMAND_FAULTS ?? "").split(",").filter(Boolean);
const needFaults = ({ broker = null, api = [] }) => {
  if (brokerFault !== broker) throw new Error(`${phase} needs broker-faults' BROKER_FAULTS=${broker ?? "unset"}, not ${brokerFault ?? "unset"}`);
  if (JSON.stringify(apiFaults) !== JSON.stringify(api)) throw new Error(`${phase} needs api-drive's API_COMMAND_FAULTS=${api.join(",") || "unset"}, not ${apiFaults.join(",") || "unset"}`);
  if (phase !== "checks" && !state.checks?.ok) throw new Error("run --phase checks first; it must pass");
};

const postTask = async task => {
  const res = await http({ method: "POST", url: `${apiUrl}/task`, headers: await asUser(), body: { task } });
  const id = res.json?.data?.id;
  if (res.status !== 200 || typeof id !== "string") throw new Error(`POST /task: ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
  return id;
};
const l0176Task = async src => ({ lang: "0176", code: await parse(src) });
const chainOf = async kind => {
  const tag = `b6drive-${runId}-${state.originals.length}`;
  if (kind === "stack") return { chain: `${await postTask(await l0176Task(SHAPES.one.src(`${tag}-head`)))}+${await postTask(await l0176Task(SHAPES.one.src(`${tag}-lower`)))}`, writes: 2 };
  if (kind === "overSource") return { chain: `${await postTask(await l0176Task(SHAPES.fromSource.src()))}+${await postTask(fetchTask(sourceUrl))}`, writes: 1 };
  return { chain: await postTask(await l0176Task(SHAPES[kind].src(tag))), writes: SHAPES[kind].writes };
};
const postCommand = async (chain, key) => {
  const res = await http({ method: "POST", url: `${apiUrl}/command`, headers: await asUser(), body: { id: chain, connectionId, idempotencyKey: key } });
  return { status: res.status, data: res.json?.data ?? null, error: res.json?.error ?? null };
};
const postRepair = async (commandId, key, occurrences = null) => {
  const res = await http({ method: "POST", url: `${apiUrl}/command/${encodeURIComponent(commandId)}/repair`, headers: await asUser(), body: { idempotencyKey: key, ...(occurrences ? { occurrences } : {}) } });
  return { status: res.status, data: res.json?.data ?? null, error: res.json?.error ?? null };
};
const postMaterialize = async commandId => {
  const res = await http({ method: "POST", url: `${apiUrl}/command/${encodeURIComponent(commandId)}/materialize`, headers: await asUser(), body: {} });
  return { status: res.status, data: res.json?.data ?? null, error: res.json?.error ?? null };
};
// A command's state once it is no longer pending (the sweeper may finish it).
const settled = async (commandId, tries = 60) => {
  let read = null;
  for (let i = 0; i < tries; i++) {
    read = await policyRead(commandId, "state").catch(() => null);
    if (read && read.status !== "pending" && read.publication?.state !== "due") return read;
    await sleep(5000);
  }
  return read;
};
const view = async commandId => {
  const [st, { occurrences }, { outcomes }, { refusals }, { ledger }] = await Promise.all([
    policyRead(commandId, "state"), policyRead(commandId, "occurrences"), policyRead(commandId, "outcomes"), policyRead(commandId, "refusals"), policyRead(commandId, "ledger"),
  ]);
  return { state: st, occurrences, outcomes, refusals, ledger };
};

// One original: its command, made under the phase's fault, and what it ended as.
const makeOriginal = async ({ kind, purpose }) => {
  const { chain, writes } = await chainOf(kind);
  const key = `b6-drive:${runId}:o${state.originals.length}`;
  const answer = await postCommand(chain, key).catch(e => ({ status: null, error: String(e?.message ?? e) }));
  const commandId = commandIdFor(key);
  const st = await settled(commandId);
  const v = st ? await view(commandId) : null;
  const entry = {
    key,
    chain,
    kind,
    purpose,
    writes,
    commandId,
    phase,
    fault: brokerFault,
    apiFaults,
    httpStatus: answer.status,
    invocationId: st?.invocationId ?? null,
    seq: st?.seq ?? null,
    status: st?.status ?? null,
    result: st?.result?.state ?? null,
    revision: st?.admission?.stages?.s0?.revision ?? null,
    replay: st?.admission?.stages?.s0?.replay ?? null,
    recording: st?.admission?.recording ?? null,
    outcomes: (v?.outcomes ?? []).map(o => ({ stage: o.stage, occurrenceId: o.occurrenceId, outcome: o.outcome, source: o.source, reason: o.reason ?? null })),
    refusals: (v?.refusals ?? []).map(r => ({ stage: r.stage, occurrenceId: r.occurrenceId, reason: r.reason })),
    at: new Date().toISOString(),
  };
  state.originals.push(entry);
  await save();
  console.log(`  original ${state.originals.length - 1} ${kind} (${purpose}): http ${entry.httpStatus}; ${entry.status}; ${entry.outcomes.map(o => `${o.stage}/${o.occurrenceId}:${o.outcome}`).join(" ") || "no outcomes"}`);
  return entry;
};
const originalsFor = purpose => state.originals.filter(o => o.purpose === purpose);

// ---------------------------------------------------------------- phases

if (phase === "checks") {
  record("api-drive routes L0176 to l0176r-drive", route.apiEnv.BASE_URL_L0176 === route.compilerUrl, `BASE_URL_L0176 ${route.apiEnv.BASE_URL_L0176}`);
  record("api-drive allocates commands and repairs for L0176", route.apiEnv.COMMANDS_L0176 === "on" && route.apiEnv.REPAIR_L0176 === "on",
    `COMMANDS_L0176 ${route.apiEnv.COMMANDS_L0176}, REPAIR_L0176 ${route.apiEnv.REPAIR_L0176}, generation ${route.apiEnv.COMPILE_GENERATION_L0176}`);
  record("api-drive has no sweeper", !route.apiEnv.SWEEP_AUDIENCE && !route.apiEnv.SWEEP_CALLERS, "SWEEP_* unset");
  record("l0176r-drive reaches broker-faults", route.compilerEnv.BROKER_URL === route.brokerUrl, `BROKER_URL ${route.compilerEnv.BROKER_URL}`);
  record("broker-faults faults the canary only", route.brokerEnv.BROKER_FAULT_PRINCIPALS === uid, `BROKER_FAULTS ${brokerFault ?? "unset"}, principals ${route.brokerEnv.BROKER_FAULT_PRINCIPALS}`);
  record("api-drive's faults name the canary only", route.apiEnv.API_COMMAND_FAULT_PRINCIPALS === uid, `API_COMMAND_FAULTS ${apiFaults.join(",") || "unset"}`);
  const approval = await firestoreDoc("revisions", `languages/0176/revisions/${route.compilerRevision}`);
  record("the serving l0176r-drive revision is approved", approval?.status === "approved" && approval?.service === "l0176r-drive", approval ? `${approval.status}, ${approval.service}, ${approval.tagUrl}` : "no approval record");
  const pre = await http({
    method: "POST",
    url: `${route.compilerUrl}/preflight`,
    headers: { "X-Caller-Identity": await tokenFor(gatewayAccount, "urn:graffiticode:0176") },
    body: { stage: "s0", lang: "0176", code: await parse(SHAPES.one.src("b6-drive-check")) },
  });
  const manifest = pre.json?.data?.manifest;
  record("its preflight reports that revision with replay: 1", manifest?.revision === route.compilerRevision && manifest?.replay === 1, manifest ? `revision ${manifest.revision}, replay ${manifest.replay}` : `${pre.status}`);
  const [api, prodPolicy] = await Promise.all([describe("api"), describe("policy")]);
  const servingOf = s => s.status.traffic.find(t => t.percent === 100)?.revisionName;
  record("the production api and Policy", true, `api ${servingOf(api)}, policy ${servingOf(prodPolicy)}`);
  if (sourceUrl) {
    const read = await http({ method: "GET", url: sourceUrl });
    record("the source is readable, unauthenticated", read.status === 200 && typeof read.json?.tag === "string", `${read.status} ${JSON.stringify(read.json)}`);
  }
  // Every drive program compiles with no connection: nothing is written.
  for (const kind of ["one", "two", "map2", "map3", "long", ...(sourceUrl ? ["overSource"] : []), "stack"]) {
    const { chain } = await chainOf(kind);
    const res = await http({ method: "POST", url: `${apiUrl}/compile`, headers: await asUser(), body: { id: chain, data: {} } });
    const errors = res.json?.errors ?? res.json?.data?.errors ?? [];
    record(`the ${kind} program compiles`, res.status === 200 && errors.length === 0, `${res.status} ${JSON.stringify(errors).slice(0, 200)}`);
  }
  state.checks = { at: startedAt, route, approval, ok: results.every(r => r.ok) };
}

if (phase === "originals-fail") {
  needFaults({ broker: "fail-write" });
  for (const kind of ["one", "two", "map3", "one", "two", "map3"]) await makeOriginal({ kind, purpose: "failed-only" });
  await makeOriginal({ kind: "one", purpose: "exclusion" });
  for (let n = 0; n < 2; n++) await makeOriginal({ kind: "stack", purpose: "resume" });
  const made = state.originals.filter(o => o.phase === phase && o.key.includes(runId));
  record("fail-write originals: failed, every outcome a provider rejection, nothing written",
    made.every(o => o.status === "failed" && o.outcomes.length > 0 && o.outcomes.every(x => x.outcome === "failed" && x.reason === "provider-rejected")),
    made.map(o => `${o.kind}:${o.status}`).join(" "));
  record("every original is recorded and admitted with replay", made.every(o => o.recording === 1 && o.replay === 1), made.map(o => `${o.recording}/${o.replay}`).join(" "));
}

if (phase === "originals-drop") {
  needFaults({ broker: "drop-outcome" });
  needSource();
  await setSource(`b6drive-${runId}-old`);
  for (let n = 0; n < 2; n++) await makeOriginal({ kind: "one", purpose: "head-lost" });
  for (let n = 0; n < 2; n++) await makeOriginal({ kind: "stack", purpose: "lower-lost" });
  for (let n = 0; n < 2; n++) {
    const o = await makeOriginal({ kind: "overSource", purpose: "source-change" });
    o.sourceTag = `b6drive-${runId}-old`;
  }
  await save();
  const made = state.originals.filter(o => o.phase === phase && o.key.includes(runId));
  record("drop-outcome originals: uncertain, with no result", made.every(o => o.status === "uncertain" && o.result !== "available"), made.map(o => `${o.kind}:${o.status}`).join(" "));
}

// Narrowing: the canary narrows its own connection to `init`, through
// Policy's console routes, and restores exactly what was there.
const consoleCall = async (method, p, body) => http({ method, url: `${policyUrl}${p}`, headers: { ...(await asPolicyCaller(consoleAccount)), ...(await asUser()) }, body });
const permissions = async () => {
  const listed = await consoleCall("GET", "/v1/connections");
  const mine = Array.isArray(listed.json?.data) ? listed.json.data.find(c => c.connectionId === connectionId) : null;
  if (!mine) throw new Error(`GET /v1/connections: ${listed.status}, ${connectionId} not listed`);
  return mine.ownerPermissions ?? null;
};
const setPermissions = async list => {
  const res = await consoleCall("PUT", `/v1/connections/${encodeURIComponent(connectionId)}/owner-permissions`, { permissions: list });
  if (res.status !== 200) throw new Error(`PUT owner-permissions: ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
};

if (phase === "originals-narrow") {
  needFaults({});
  const saved = await permissions();
  try {
    for (const [kind, purpose, narrowAfter] of [["map2", "partly", "outcome"], ["map2", "partly", "outcome"], ["long", "partial-probe", "claim"]]) {
      const { chain, writes } = await chainOf(kind);
      const key = `b6-drive:${runId}:o${state.originals.length}`;
      const commandId = commandIdFor(key);
      const pending = postCommand(chain, key).catch(e => ({ status: null, error: String(e?.message ?? e) }));
      let atNarrow = { claims: 0, done: 0 };
      for (let i = 0; i < 480; i++) {
        const st = await policyRead(commandId, "state").catch(() => null);
        if (st?.invocationId) {
          atNarrow = await finishedClaims(st.invocationId);
          if (narrowAfter === "claim" ? atNarrow.claims > 0 : atNarrow.done > 0) break;
        }
        await sleep(250);
      }
      await setPermissions([{ lang: "0176", fn: "init" }]);
      await pending;
      await setPermissions(saved);
      const st = await settled(commandId);
      const v = await view(commandId);
      state.originals.push({
        key,
        chain,
        kind,
        purpose,
        writes,
        commandId,
        phase,
        narrowAfter,
        atNarrow,
        invocationId: st?.invocationId,
        seq: st?.seq,
        status: st?.status,
        outcomes: v.outcomes.map(o => ({ stage: o.stage, occurrenceId: o.occurrenceId, outcome: o.outcome, source: o.source, reason: o.reason ?? null })),
        refusals: v.refusals.map(r => ({ stage: r.stage, occurrenceId: r.occurrenceId, reason: r.reason })),
        at: new Date().toISOString(),
      });
      await save();
      console.log(`  original ${state.originals.length - 1} ${kind} (${purpose}), narrowed at ${JSON.stringify(atNarrow)}: ${st?.status}; ${v.outcomes.map(o => `${o.occurrenceId}:${o.outcome}`).join(" ")}`);
    }
  } finally {
    await setPermissions(saved);
    record("the canary connection's owner permissions restored exactly", JSON.stringify(await permissions()) === JSON.stringify(saved), JSON.stringify(saved));
  }
  const partly = originalsFor("partly").filter(o => o.key.includes(runId));
  record("partly completed originals: A completed, B failed", partly.length === 2 && partly.every(o => o.outcomes.some(x => x.outcome === "completed") && o.outcomes.some(x => x.outcome === "failed")),
    partly.map(o => o.outcomes.map(x => x.outcome).join("/")).join(" "));
  const cut = originalsFor("partial-probe").filter(o => o.key.includes(runId));
  record("a partial occurrence for the probe", cut.length === 1 && cut[0].outcomes.some(x => x.outcome === "partial"), cut.map(o => o.outcomes.map(x => x.outcome).join("/")).join(" "));
}

// The ledger, and Broker's claims, for an original: unchanged by a refusal.
const footprint = async original => {
  const { ledger } = await policyRead(original.commandId, "ledger");
  return { ledger: ledger.length, claims: (await claimsOf(original.invocationId)).length };
};

if (phase === "probes") {
  needFaults({});
  const one = (purpose, outcome) => {
    for (const o of originalsFor(purpose)) {
      const hit = o.outcomes.find(x => x.outcome === outcome);
      if (hit) return { original: o, occurrence: { stage: hit.stage, occurrenceId: hit.occurrenceId } };
    }
    return null;
  };
  const probes = [
    ["completed", one("partly", "completed"), "not-eligible"],
    ["partial", one("partial-probe", "partial"), "not-eligible"],
    ["uncertain", one("head-lost", "uncertain"), "not-eligible"],
  ];
  for (const [what, target, expected] of probes) {
    if (!target) {
      record(`a selected ${what} occurrence is refused`, false, "no such occurrence among the originals");
      continue;
    }
    const before = await footprint(target.original);
    const res = await postRepair(target.original.commandId, `b6-drive:${runId}:probe-${what}`, [target.occurrence]);
    const after = await footprint(target.original);
    state.probes.push({ what, commandId: target.original.commandId, occurrence: target.occurrence, httpStatus: res.status, reason: res.error?.reason ?? null, before, after });
    record(`a selected ${what} occurrence is refused ${expected}, with no ledger entry or claim`, res.status === 409 && res.error?.reason === expected && JSON.stringify(before) === JSON.stringify(after),
      `${res.status} ${res.error?.reason}; ledger ${before.ledger}→${after.ledger}, claims ${before.claims}→${after.claims}`);
  }
  const uncertain = originalsFor("head-lost")[0];
  if (uncertain) {
    const before = await footprint(uncertain);
    const res = await postRepair(uncertain.commandId, `b6-drive:${runId}:probe-none`);
    const after = await footprint(uncertain);
    state.probes.push({ what: "uncertain, no selection", commandId: uncertain.commandId, httpStatus: res.status, reason: res.error?.reason ?? null, before, after });
    record("the uncertain command with no selection is refused nothing-to-repair, with nothing claimed", res.status === 409 && res.error?.reason === "nothing-to-repair" && JSON.stringify(before) === JSON.stringify(after),
      `${res.status} ${res.error?.reason}`);
  }
}

// A repair through api-drive, and its record.
const runRepair = async (original, { occurrences = null, purpose }) => {
  const key = `b6-drive:${runId}:r${state.repairs.length}`;
  const res = await postRepair(original.commandId, key, occurrences);
  const repairId = res.data?.commandId ?? commandIdFor(key);
  const st = await settled(repairId);
  const v = st ? await view(repairId) : null;
  const entry = {
    key,
    repairId,
    originalId: original.commandId,
    originalInvocation: original.invocationId,
    purpose,
    phase,
    httpStatus: res.status,
    reason: res.error?.reason ?? null,
    invocationId: st?.invocationId ?? null,
    selection: st?.selection ?? null,
    status: st?.status ?? null,
    publication: st?.publication ?? null,
    occurrences: (v?.occurrences ?? []).map(o => ({ stage: o.stage, occurrenceId: o.occurrenceId })),
    counted: st?.status === "completed" && st?.publication?.state === "published" && st?.publication?.artifact?.invocationId === original.invocationId,
    at: new Date().toISOString(),
  };
  state.repairs.push(entry);
  await save();
  console.log(`  repair ${state.repairs.length - 1} of ${original.kind} (${purpose}): http ${res.status}; ${entry.status}; publication ${entry.publication?.state}; selection ${JSON.stringify(entry.selection)}`);
  return entry;
};
const failedOf = original => original.outcomes.filter(o => o.outcome === "failed").map(({ stage, occurrenceId }) => ({ stage, occurrenceId }))
  .concat(original.refusals.map(({ stage, occurrenceId }) => ({ stage, occurrenceId })))
  .sort((a, b) => `${a.stage}:${a.occurrenceId}`.localeCompare(`${b.stage}:${b.occurrenceId}`));
const sameSet = (a, b) => JSON.stringify([...a].map(o => `${o.stage}:${o.occurrenceId}`).sort()) === JSON.stringify([...b].map(o => `${o.stage}:${o.occurrenceId}`).sort());

if (phase === "repairs") {
  needFaults({});
  for (const original of [...originalsFor("failed-only"), ...originalsFor("partly"), ...originalsFor("resume")]) {
    if (state.repairs.some(r => r.originalId === original.commandId && r.counted)) continue;
    const repair = await runRepair(original, { purpose: original.purpose });
    if (original.purpose !== "resume") {
      record(`the repair of ${original.key} selected exactly its failed occurrences`, sameSet(repair.selection ?? [], failedOf(original)), JSON.stringify(repair.selection));
    }
    record(`the repair of ${original.key} completed and published as the original's artifact`, repair.counted, `${repair.status}, ${JSON.stringify(repair.publication)}`);
  }
}

if (phase === "exclusion") {
  needFaults({});
  const original = originalsFor("exclusion")[0];
  if (!original) throw new Error("no exclusion original: run originals-fail first");
  const keys = Array.from({ length: 8 }, (_, i) => `b6-drive:${runId}:x${i}`);
  const answers = await Promise.all(keys.map(key => postRepair(original.commandId, key)));
  const winners = answers.filter(a => a.status === 200);
  const refused = answers.filter(a => a.status !== 200).map(a => a.error?.reason);
  record("exactly one of 8 concurrent repairs claims", winners.length === 1 && refused.every(r => r === "occurrence-claimed" || r === "nothing-to-repair"),
    `${winners.length} ran; refused ${refused.join(", ")}`);
  if (winners.length === 1) {
    const repairId = winners[0].data.commandId;
    const st = await settled(repairId);
    const entry = {
      key: keys[answers.indexOf(winners[0])],
      repairId,
      originalId: original.commandId,
      originalInvocation: original.invocationId,
      purpose: "exclusion",
      phase,
      status: st?.status,
      publication: st?.publication,
      selection: st?.selection,
      invocationId: st?.invocationId,
      counted: st?.status === "completed" && st?.publication?.state === "published" && st?.publication?.artifact?.invocationId === original.invocationId,
      concurrent: answers.map(a => ({ status: a.status, reason: a.error?.reason ?? null, repairId: a.data?.commandId ?? null })),
      at: new Date().toISOString()
    };
    state.repairs.push(entry);
    const again = await postRepair(original.commandId, entry.key);
    record("the winner's key answers the same repair", again.data?.commandId === repairId, `${again.status} ${again.data?.commandId}`);
    record("the winner completed and published", entry.counted, `${entry.status} ${JSON.stringify(entry.publication)}`);
  }
}

if (phase === "reconcile") {
  needFaults({});
  for (const original of state.originals.filter(o => o.fault === "drop-outcome" && !o.reconciled)) {
    const res = await consoleCall("POST", "/v1/receipts/reconcile", { connectionId, idempotencyKey: original.key });
    const ops = res.json?.data?.operations ?? [];
    const { ledger } = await policyRead(original.commandId, "ledger");
    original.reconciled = { httpStatus: res.status, verdicts: ops.map(o => ({ operationId: o.operationId, verdict: o.verdict, final: o.final ?? null, resultSource: o.resultSource ?? null })), ledger: ledger.map(e => ({ stage: e.stage, occurrenceId: e.occurrenceId, status: e.status, source: e.source, output: e.output ? Object.keys(e.output) : null })) };
    await save();
    record(`${original.key} reconciled applied, and recorded completed in the ledger with its output`,
      res.status === 200 && ops.length > 0 && ops.every(o => o.verdict === "applied" && o.final === true) && ledger.length === ops.length && ledger.every(e => e.status === "completed" && e.source === "reconciliation" && typeof e.output?.text === "string"),
      `${res.status}; ${ops.map(o => `${o.verdict}/${o.resultSource}`).join(" ")}; ledger ${ledger.map(e => e.status).join(" ")}`);
  }
}

// What the read path serves for an original's chain: an artifact, or not.
const artifactOf = async original => {
  const res = await http({ method: "GET", url: `${apiUrl}/data?id=${encodeURIComponent(original.chain)}&connection=${encodeURIComponent(connectionId)}`, headers: await asUser() });
  return { status: res.status, has: res.status === 200 && (res.json?.errors ?? []).length === 0 && res.json?.data != null, body: res.json };
};

if (phase === "dropped") {
  needFaults({});
  for (const original of originalsFor("head-lost")) {
    const before = await artifactOf(original);
    const from = new Date().toISOString();
    const res = await postMaterialize(original.commandId);
    await sleep(20_000);
    const lines = await callLines(original.commandId, from);
    const after = await artifactOf(original);
    state.materialized.push({ commandId: original.commandId, purpose: "head-lost", before: before.has, httpStatus: res.status, published: res.data?.published ?? null, reason: res.error?.reason ?? null, lines, after: after.has });
    await save();
    record(`${original.key}: no artifact before, an actual materialization, an artifact after`,
      !before.has && res.status === 200 && res.data?.published === "current" && after.has && lines.some(l => l.includes("call materialize s0")) && !lines.some(l => l.includes("call start")),
      `${before.has} → ${res.status} ${res.data?.published ?? res.error?.reason} → ${after.has}; ${lines.length} call line(s)`);
  }
  for (const original of originalsFor("lower-lost")) {
    const from = new Date().toISOString();
    const repair = await runRepair(original, { purpose: "lower-lost" });
    await sleep(20_000);
    const lines = await callLines(repair.repairId, from);
    repair.lines = lines;
    await save();
    record(`${original.key}: the repair rebuilt the lower stage by replay, resumed the head, and published`,
      repair.counted && sameSet(repair.selection ?? [], []) && lines.some(l => l.includes("call materialize s1")) && !lines.some(l => l.includes("call start s1")) && lines.some(l => l.includes("call start s0")),
      `${repair.status}; ${lines.filter(l => l.includes(": call ")).join(" | ")}`);
  }
}

if (phase === "boundary") {
  needFaults({ api: ["exit-after-output"] });
  needSource();
  for (let n = 0; n < 2; n++) {
    const oldTag = `b6drive-${runId}-b${n}-old`;
    await setSource(oldTag);
    const { chain } = await chainOf("overSource");
    const key = `b6-drive:${runId}:b${n}`;
    const commandId = commandIdFor(key);
    const from = new Date().toISOString();
    const answer = await postCommand(chain, key).catch(e => ({ status: null, error: String(e?.message ?? e) }));
    // The worker exited after L0185's output was recorded: change the source.
    const crashedAt = new Date().toISOString();
    await setSource(`b6drive-${runId}-b${n}-new`);
    const st = await settled(commandId, 72);
    const until = new Date().toISOString();
    const [input, output] = await Promise.all([policyRead(commandId, "input", "s0"), policyRead(commandId, "output", "s1")]);
    const lines = await callLines(commandId, from);
    const takeover = lines.slice(lines.findIndex(l => l.includes("resuming")));
    const requests = await l0185Requests(crashedAt, until);
    const fetches = sourcePath ? await proxyFetches(sourcePath, from) : null;
    const entry = { key, commandId, httpStatus: answer.status, status: st?.status, finishedBy: null, oldTag, inputHasOld: input.input?.text?.includes(oldTag) ?? false, outputDigestMatches: Boolean(input.input && output.output && input.input.digest === output.output.digest), lines, takeoverCalls: takeover.filter(l => l.includes(": call ")), l0185Requests: requests, proxyFetches: fetches };
    state.boundary.push(entry);
    await save();
    record(`boundary ${n}: finished from the recorded output, with the old content and no L0185 call after the exit`,
      st?.status === "completed" && entry.inputHasOld && entry.outputDigestMatches && !takeover.some(l => l.includes("call interpret s1")) && requests === 0,
      `${st?.status}; pinned input carries ${entry.inputHasOld ? "the old" : "NOT the old"} tag; takeover calls ${entry.takeoverCalls.join(" | ") || "none"}; l0185r requests ${requests}; proxy fetches ${fetches}`);
  }
}

if (phase === "source-change") {
  needFaults({});
  needSource();
  for (const original of originalsFor("source-change")) {
    if (!original.reconciled) throw new Error(`${original.key} isn't reconciled: run --phase reconcile first`);
    await setSource(`${original.sourceTag}-changed`);
    const before = await artifactOf(original);
    const from = new Date().toISOString();
    const res = await postMaterialize(original.commandId);
    const until = new Date().toISOString();
    await sleep(20_000);
    const lines = await callLines(original.commandId, from);
    const after = await artifactOf(original);
    const requests = await l0185Requests(from, until);
    const carriesOld = JSON.stringify(after.body ?? {}).includes(original.sourceTag);
    state.materialized.push({ commandId: original.commandId, purpose: "source-change", before: before.has, httpStatus: res.status, published: res.data?.published ?? null, lines, after: after.has, l0185Requests: requests, carriesOld });
    await save();
    record(`${original.key}: materialized after the source changed, from the recorded L0185 output`,
      !before.has && res.data?.published === "current" && after.has && lines.some(l => l.includes("s1 from its recorded output, not run")) && lines.some(l => l.includes("call materialize s0")) && !lines.some(l => l.includes("call interpret")) && requests === 0,
      `${before.has} → ${res.data?.published ?? res.error?.reason} → ${after.has}; ${lines.join(" | ")}; l0185r requests ${requests}; artifact carries the old tag: ${carriesOld}`);
  }
}

if (phase === "retries") {
  needFaults({});
  for (const repair of state.repairs.filter(r => r.counted && !state.retries.some(x => x.repairId === r.repairId))) {
    const original = state.originals.find(o => o.commandId === repair.originalId);
    const res = await postRepair(original.commandId, repair.key);
    const again = { repairId: repair.repairId, httpStatus: res.status, same: res.data?.commandId === repair.repairId, outcome: res.data?.outcome ?? null, at: new Date().toISOString() };
    state.retries.push(again);
    await save();
    record(`${repair.key} again answers its own record`, again.same && again.outcome === "completed", `${res.status} ${res.data?.commandId}`);
  }
}

if (phase === "report") {
  const counted = [...new Map(state.repairs.filter(r => r.counted).map(r => [r.repairId, r])).values()];
  record("at least 10 distinct completed repairs, each published as its original's artifact", counted.length >= 10, `${counted.length}: ${counted.map(r => r.repairId.slice(0, 12)).join(" ")}`);
  // Dispatch evidence: per original occurrence, one claim per operation, and
  // dispatches under at most one operation id.
  const from = state.runs[0]?.startedAt ?? startedAt;
  const operations = [];
  for (const o of state.originals.filter(x => x.invocationId)) {
    const { occurrences } = await policyRead(o.commandId, "occurrences");
    for (const occ of occurrences) operations.push({ original: o.commandId, stage: occ.stage, occurrenceId: occ.occurrenceId, opid: `${o.invocationId}/${occ.stage}/${occ.occurrenceId}` });
    for (const r of state.repairs.filter(x => x.originalId === o.commandId && x.invocationId)) {
      // Every occurrence of the stage under the repair's invocation, bound or
      // not: an occurrence answered from its record must have no operation there.
      for (const occ of occurrences) operations.push({ original: o.commandId, stage: occ.stage, occurrenceId: occ.occurrenceId, opid: `${r.invocationId}/${occ.stage}/${occ.occurrenceId}`, repair: r.repairId });
      for (const occ of r.occurrences ?? []) operations.push({ original: o.commandId, stage: occ.stage, occurrenceId: occ.occurrenceId, opid: `${r.invocationId}/${occ.stage}/${occ.occurrenceId}`, repair: r.repairId });
    }
  }
  const unique = [...new Map(operations.map(o => [o.opid, o])).values()];
  const audit = await brokerAudit(unique.map(o => o.opid), from);
  const byOccurrence = new Map();
  for (const op of unique) {
    const k = `${op.original} ${op.stage} ${op.occurrenceId}`;
    if (!byOccurrence.has(k)) byOccurrence.set(k, []);
    byOccurrence.get(k).push({ ...op, ...audit.get(op.opid) });
  }
  const problems = [];
  for (const [k, ops] of byOccurrence) {
    if (ops.some(o => o.claims > 1)) problems.push(`${k}: an operation claimed twice`);
    if (ops.filter(o => o.dispatches > 0).length > 1) problems.push(`${k}: dispatched under ${ops.filter(o => o.dispatches > 0).length} operation ids`);
  }
  state.evidence = { at: startedAt, operations: [...byOccurrence].map(([k, ops]) => ({ occurrence: k, ops: ops.map(o => ({ opid: o.opid, repair: o.repair ?? null, claims: o.claims, dispatches: o.dispatches, replays: o.replays })) })), problems };
  record("no write repeated: one claim per operation, and each occurrence dispatched under at most one operation id", problems.length === 0, problems.join("; ") || `${byOccurrence.size} occurrence(s), ${unique.length} operation id(s)`);
}

state.runs.at(-1).results = results;
state.runs.at(-1).ok = results.every(r => r.ok);
await save();
const failed = results.filter(r => !r.ok);
console.log(failed.length ? `b6 drive ${phase}: ${failed.length} check(s) FAILED` : `b6 drive ${phase}: passed (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
