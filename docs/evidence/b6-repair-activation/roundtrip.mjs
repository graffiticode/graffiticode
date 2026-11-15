// B6 activation: one repair round-trip against a staged api (its tag URL), on
// the canary account through its sandbox connection, through production's
// l0176r and Broker (no faults). docs/b6-command-repair-plan.md slice 5,
// "Activation": production's Broker has no faults, so the failed occurrence
// is made by narrowing, as the drive's originals-narrow did.
//
//   node docs/evidence/b6-repair-activation/roundtrip.mjs <stagedBase> <stagedRevision>
//
// 1. An original: a 2-element map of saves, POSTed to the tag. Once the first
//    write has its final outcome, the canary narrows its own connection to
//    `init` (Policy's console routes), so the second is refused: A completed,
//    B failed. The owner permissions are restored exactly.
// 2. A repair of it, POSTed to the tag: it selects exactly B, completes, and
//    publishes as the original invocation's artifact.
// 3. Evidence: the staged revision logged both commands' calls; Broker's audit
//    has one write for B under the repair and nothing for A under it; the
//    artifact holds A's reference under the original's operation and B's under
//    the repair's; the repair's key answers the same repair.
// Needs the canary window (Secret Manager `canary-api-key`, OpenIdTokenCreator
// on api-run and console-run) and the operator's own credentials for Broker's
// receipts and Cloud Logging.
import { createHash, randomBytes } from "node:crypto";
import { createCanaryEnv, loadDeployServices, http } from "../../../scripts/lib/canary-env.js";
import { savedReferences, auditByOperation } from "../../../scripts/lib/b6-drive-checks.js";

const [staged, revision] = process.argv.slice(2);
if (!staged || !revision) throw new Error("usage: roundtrip.mjs <stagedBase> <stagedRevision>");
const uid = "995cc0bc98105563168b7fbee7b1e59a4256331c";
const connectionId = "conn-686c62bc-b447-4dd8-bba8-60fd2b7a3cfd";
const project = "graffiticode";
const gatewayAccount = "api-run@graffiticode.iam.gserviceaccount.com";
const consoleAccount = "console-run@graffiticode-app.iam.gserviceaccount.com";
const deploy = await loadDeployServices();
const policyUrl = deploy.api.env.POLICY_URL;
const { gcloud, accessToken, idToken, parse } = createCanaryEnv({ uid, project, authUrl: deploy.l0176r.env.AUTH_URL, apiUrl: () => staged });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = randomBytes(3).toString("hex");
const startedAt = new Date().toISOString();
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "ok    " : "FAILED"} ${name}: ${detail}`); };

const tokens = new Map();
const tokenFor = async (account, audience) => {
  const k = `${account} ${audience}`;
  if (!tokens.has(k)) tokens.set(k, await idToken(account, audience));
  return tokens.get(k);
};
const asPolicyCaller = async account => ({ "X-Serverless-Authorization": `Bearer ${await tokenFor(account, policyUrl)}`, "X-Caller-Identity": await tokenFor(account, "urn:graffiticode:policy") });
let userToken = null;
let userTokenAt = 0;
const asUser = async () => {
  if (Date.now() - userTokenAt > 2 * 60_000) [userToken, userTokenAt] = [await accessToken(), Date.now()];
  return { Authorization: userToken };
};
const policyRead = async (commandId, what) => {
  const res = await http({ method: "GET", url: `${policyUrl}/v1/commands/${encodeURIComponent(commandId)}/records/${what}`, headers: await asPolicyCaller(gatewayAccount) });
  if (res.status !== 200) throw new Error(`policy read ${what} of ${commandId}: ${res.status}`);
  return res.json.data;
};
const commandIdFor = key => `c:${createHash("sha256").update(JSON.stringify([uid, key])).digest("hex")}`;
const opPrefix = opid => createHash("sha256").update(opid).digest("hex").slice(0, 16);

let operatorToken;
const operator = async () => (operatorToken ??= await gcloud(["auth", "print-access-token"]));
const claimsOf = async invocationId => {
  const range = (op, value) => ({ fieldFilter: { field: { fieldPath: "operationId" }, op, value: { stringValue: value } } });
  const where = { compositeFilter: { op: "AND", filters: [range("GREATER_THAN_OR_EQUAL", `${invocationId}/`), range("LESS_THAN", `${invocationId}0`)] } };
  const res = await http({ method: "POST", url: `https://firestore.googleapis.com/v1/projects/${project}/databases/broker/documents:runQuery`, headers: { Authorization: `Bearer ${await operator()}` }, body: { structuredQuery: { from: [{ collectionId: "receipts" }], where, select: { fields: [{ fieldPath: "operationId" }] } } } });
  return (Array.isArray(res.json) ? res.json : []).filter(r => r.document).map(r => r.document.fields.operationId.stringValue);
};
const finalOutcomes = async invocationId => {
  let done = 0;
  for (const op of await claimsOf(invocationId)) {
    const name = createHash("sha256").update(op).digest("hex");
    const res = await http({ method: "GET", url: `https://firestore.googleapis.com/v1/projects/${project}/databases/broker/documents/receipts/${name}/outcome/final`, headers: { Authorization: `Bearer ${await operator()}` } });
    if (res.status === 200) done++;
  }
  return done;
};
const logs = async filter => {
  const out = await gcloud(["logging", "read", filter, "--limit=500", "--format=json"]);
  return out ? JSON.parse(out) : [];
};

const consoleCall = async (method, p, body) => http({ method, url: `${policyUrl}${p}`, headers: { ...(await asPolicyCaller(consoleAccount)), ...(await asUser()) }, body });
const permissions = async () => {
  const listed = await consoleCall("GET", "/v1/connections");
  const mine = Array.isArray(listed.json?.data) ? listed.json.data.find(c => c.connectionId === connectionId) : null;
  if (!mine) throw new Error(`GET /v1/connections: ${listed.status}, ${connectionId} not listed`);
  return mine.ownerPermissions ?? null;
};
const setPermissions = async list => {
  const res = await consoleCall("PUT", `/v1/connections/${encodeURIComponent(connectionId)}/owner-permissions`, { permissions: list });
  if (res.status !== 200) throw new Error(`PUT owner-permissions: ${res.status}`);
};
const settled = async commandId => {
  let st = null;
  for (let i = 0; i < 60; i++) {
    st = await policyRead(commandId, "state").catch(() => null);
    if (st && st.status !== "pending" && st.publication?.state !== "due") return st;
    await sleep(5000);
  }
  return st;
};

// 1. The original.
const ITEM = "item [questions [mcq []] {}]";
const tag = `b6act-${run}`;
const postTask = async src => {
  const res = await http({ method: "POST", url: `${staged}/task`, headers: await asUser(), body: { task: { lang: "0176", code: await parse(src) } } });
  if (res.status !== 200) throw new Error(`POST /task: ${res.status}`);
  return res.json.data.id;
};
const chain = await postTask(`set-var "lrn-id" "${tag}" map (<x: save-to-itembank items [${ITEM}] {}>) [1 2]..`);
const originalKey = `b6-activation:${run}:original`;
const originalId = commandIdFor(originalKey);
console.log(`b6 activation round-trip ${run} against ${staged} (${revision}); original ${originalId}`);
const saved = await permissions();
let original;
try {
  const pending = http({ method: "POST", url: `${staged}/command`, headers: await asUser(), body: { id: chain, connectionId, idempotencyKey: originalKey } });
  for (let i = 0; i < 480; i++) {
    const st = await policyRead(originalId, "state").catch(() => null);
    if (st?.invocationId && (await finalOutcomes(st.invocationId)) > 0) break;
    await sleep(250);
  }
  await setPermissions([{ lang: "0176", fn: "init" }]);
  const answer = await pending;
  check("POST /command to the tag answered", answer.status === 200, `${answer.status} ${answer.json?.data?.outcome}`);
} finally {
  await setPermissions(saved);
}
check("the connection's owner permissions restored exactly", JSON.stringify(await permissions()) === JSON.stringify(saved), JSON.stringify(saved));
original = await settled(originalId);
const { outcomes } = await policyRead(originalId, "outcomes");
const A = outcomes.find(o => o.outcome === "completed");
const B = outcomes.find(o => o.outcome === "failed");
check("the original: A completed, B failed", original?.status === "partial" && A && B && outcomes.length === 2, `${original?.status}; ${outcomes.map(o => `${o.occurrenceId.slice(0, 10)}:${o.outcome}`).join(" ")}`);

// 2. The repair.
const repairKey = `b6-activation:${run}:repair`;
const repairAnswer = await http({ method: "POST", url: `${staged}/command/${encodeURIComponent(originalId)}/repair`, headers: await asUser(), body: { idempotencyKey: repairKey } });
const repairId = repairAnswer.json?.data?.commandId ?? commandIdFor(repairKey);
const repair = await settled(repairId);
check("POST /command/:id/repair to the tag answered", repairAnswer.status === 200, `${repairAnswer.status} ${repairAnswer.json?.data?.outcome}`);
check("the repair selected exactly B", JSON.stringify(repair?.selection) === JSON.stringify([{ stage: B.stage, occurrenceId: B.occurrenceId }]), JSON.stringify(repair?.selection));
check("the repair completed and published as the original invocation's artifact",
  repair?.status === "completed" && repair?.publication?.state === "published" && repair?.publication?.artifact?.invocationId === original.invocationId,
  `${repair?.status}, ${JSON.stringify(repair?.publication)}`);

// 3. Evidence.
await sleep(20_000);
const lineEntries = [];
for (const id of [originalId, repairId]) lineEntries.push(...(await logs(`resource.type="cloud_run_revision" AND resource.labels.service_name="api" AND textPayload:"command ${id}:" AND timestamp>="${startedAt}"`)));
const lines = lineEntries.map(e => ({ at: e.timestamp, revision: e.resource.labels.revision_name, line: e.textPayload?.trim() })).sort((a, b) => a.at.localeCompare(b.at));
const calls = lines.filter(l => l.line.includes(": call "));
check("the staged revision ran both commands", calls.some(l => l.line.startsWith(`command ${originalId}: call start`)) && calls.some(l => l.line.startsWith(`command ${repairId}: call start`)) && calls.every(l => l.revision === revision),
  calls.map(l => `${l.revision}: ${l.line.slice(0, 40)}…${l.line.slice(-60)}`).join(" | "));

const opids = {
  "A, original": `${original.invocationId}/${A.stage}/${A.occurrenceId}`,
  "B, original": `${original.invocationId}/${B.stage}/${B.occurrenceId}`,
  "A, repair": `${repair.invocationId}/${A.stage}/${A.occurrenceId}`,
  "B, repair": `${repair.invocationId}/${B.stage}/${B.occurrenceId}`,
};
const auditEntries = await logs(`resource.type="cloud_run_revision" AND (resource.labels.service_name="broker" OR resource.labels.service_name="broker-faults") AND jsonPayload.logName="security_audit" AND (${Object.values(opids).map(o => `jsonPayload.opid="${o}"`).join(" OR ")}) AND timestamp>="${startedAt}"`);
const audit = auditByOperation(auditEntries, Object.values(opids));
const tally = Object.fromEntries(Object.entries(opids).map(([k, o]) => [k, audit.get(o)]));
const dispatched = a => Object.values(a.dispatches).reduce((n, c) => n + c, 0);
check("Broker: A written once by the original, B once by the repair, nothing else",
  tally["A, original"].claims === 1 && dispatched(tally["A, original"]) > 0 && Object.values(tally["A, original"].dispatches).every(c => c === 1) &&
  tally["B, original"].claims === 0 && dispatched(tally["B, original"]) === 0 &&
  tally["A, repair"].claims === 0 && dispatched(tally["A, repair"]) === 0 &&
  tally["B, repair"].claims === 1 && dispatched(tally["B, repair"]) > 0 && Object.values(tally["B, repair"].dispatches).every(c => c === 1) &&
  auditEntries.every(e => e.resource.labels.service_name === "broker"),
  JSON.stringify(tally));
const receipts = { original: await claimsOf(original.invocationId), repair: await claimsOf(repair.invocationId) };
check("Broker's receipts: one under each invocation", receipts.original.length === 1 && receipts.repair.length === 1, JSON.stringify(receipts));

const read = await http({ method: "GET", url: `${staged}/data?id=${encodeURIComponent(chain)}&connection=${connectionId}`, headers: await asUser() });
const references = savedReferences(read.json?.data?.data);
const expected = { A: `gc-${opPrefix(opids["A, original"])}-`, B: `gc-${opPrefix(opids["B, repair"])}-` };
check("the artifact holds A's reference under the original and B's under the repair",
  read.status === 200 && references.length === 2 && references.some(r => r.startsWith(expected.A)) && references.some(r => r.startsWith(expected.B)),
  `${read.status}; ${references.join(" ")}; expected ${expected.A}… ${expected.B}…`);

const again = await http({ method: "POST", url: `${staged}/command/${encodeURIComponent(originalId)}/repair`, headers: await asUser(), body: { idempotencyKey: repairKey } });
check("the repair's key answers the same repair", again.json?.data?.commandId === repairId && again.json?.data?.outcome === "completed", `${again.status} ${again.json?.data?.commandId}`);

const record = {
  run, staged, revision, startedAt, finishedAt: new Date().toISOString(), chain,
  original: { key: originalKey, commandId: originalId, invocationId: original.invocationId, status: original.status, outcomes: outcomes.map(o => ({ stage: o.stage, occurrenceId: o.occurrenceId, outcome: o.outcome, source: o.source, reason: o.reason ?? null })) },
  repair: { key: repairKey, commandId: repairId, invocationId: repair.invocationId, status: repair.status, selection: repair.selection, publication: repair.publication },
  permissions: { saved },
  lines, opids, audit: tally, receipts, references, expectedPrefixes: expected,
  results,
};
console.log(`RECORD ${JSON.stringify(record)}`);
console.log(`b6 activation round-trip ${run}: ${results.every(r => r.ok) ? "passed" : "FAILED"} (${results.filter(r => r.ok).length}/${results.length})`);
process.exitCode = results.every(r => r.ok) ? 0 : 1;
