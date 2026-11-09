#!/usr/bin/env node
// L0176's activation drive (C6, docs/c6-l0176-commands-plan.md §6 step 3):
// saves as commands through api-drive -> l0176r-drive -> broker-faults, as the
// canary account through its sandbox connection only.
//
//   node scripts/c6-drive.js --phase checks
//   node scripts/c6-drive.js --phase clean [--count 188]
//   node scripts/c6-drive.js --phase faults [--count 12]
//   node scripts/c6-drive.js --phase reconcile
//
// Phases (state accumulates in --state, default .gc-deploy/c6-drive/state.json):
//   checks     read-only, before any command: api-drive routes L0176 to
//              l0176r-drive, l0176r-drive's BROKER_URL is broker-faults, its
//              serving revision is approved for 0176, and a gateway preflight
//              at it reports that revision. Any mismatch exits non-zero.
//   clean      broker-faults with no fault set (refused otherwise): commands
//              across one save, two saves and a save inside map, alternating
//              POST /command and the compile bridge. After the first command,
//              its admission must name the approved revision, or the drive
//              stops. Then same-key retries (no new receipt, same references)
//              and 16 concurrent duplicates of one key (one command).
//   retries    every tenth clean command, retried with its own key and path.
//   faults     broker-faults with BROKER_FAULTS=drop-outcome (refused
//              otherwise): commands whose writes succeed with their outcome
//              dropped. Each must end uncertain.
//   reconcile  each faulted command's key through Policy's
//              /v1/receipts/reconcile, as the console with the canary's token.
//              `applied` is the established completion; the command's own
//              outcome must stay uncertain (D1).
//   kill       api-drive with API_COMMAND_FAULTS=exit-after-write: each worker
//              exits once its stage's writes have run. The production
//              sweeper must take each command over and finish it completed,
//              with one receipt per write (none repeated).
//   lost-head  api-drive with API_COMMAND_FAULTS=lose-head-answer: each
//              command ends completed with no result (result unavailable).
//   revoke     no faults: a save inside a 10-element map; once its first write
//              has its final outcome (--narrow-after claim: once it's claimed,
//              which cuts it between its steps), the canary narrows its own connection to `init`
//              (Policy's console routes), and restores it after. The command
//              ends partial: the saves before the narrowing completed, the
//              rest failed by Policy's refusal, nothing repeated.
// The rule throughout: every provider reference is unique to its operation,
// so no write was repeated.
//
// Needs the canary window: Secret Manager `canary-api-key`, and
// roles/iam.serviceAccountOpenIdTokenCreator on api-run (the preflight) and
// console-run@graffiticode-app (reconcile). Reads the policy and revisions
// databases with the operator's own credentials.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createCanaryEnv, loadDeployServices, http, serviceEnv } from "./lib/canary-env.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const phase = flag("--phase");
const uid = flag("--uid", "995cc0bc98105563168b7fbee7b1e59a4256331c");
const connectionId = flag("--connection", "conn-686c62bc-b447-4dd8-bba8-60fd2b7a3cfd");
const project = flag("--project", "graffiticode");
const region = flag("--region", "us-central1");
const stateFile = flag("--state", new URL("../.gc-deploy/c6-drive/state.json", import.meta.url).pathname);
const gatewayAccount = "api-run@graffiticode.iam.gserviceaccount.com";
const consoleAccount = flag("--console-account", "console-run@graffiticode-app.iam.gserviceaccount.com");
if (!["checks", "clean", "retries", "faults", "reconcile", "kill", "lost-head", "revoke"].includes(phase)) {
  console.error("usage: node scripts/c6-drive.js --phase checks|clean|retries|faults|reconcile|kill|lost-head|revoke [--count N]");
  process.exit(2);
}

const deploy = await loadDeployServices();
const authUrl = deploy.l0176r.env.AUTH_URL;
let apiUrl = null;
const { gcloud, accessToken, idToken, parse } = createCanaryEnv({ uid, project, region, authUrl, apiUrl: () => apiUrl });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const describe = async name => JSON.parse(await gcloud(["run", "services", "describe", name, `--region=${region}`, "--format=json"]));

const state = await readFile(stateFile, "utf8").then(JSON.parse, () => ({ runs: [], commands: [], faulted: [], reconciled: [] }));
const save = async () => {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n");
};

// Firestore over REST with the operator's token, decoded to plain values.
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
const firestore = async (database, docPath) => {
  operatorToken ??= await gcloud(["auth", "print-access-token"]);
  const res = await http({ method: "GET", url: `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents/${docPath}?pageSize=300`, headers: { Authorization: `Bearer ${operatorToken}` } });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`Firestore ${database}/${docPath}: ${res.status}`);
  if (Array.isArray(res.json?.documents)) return res.json.documents.map(d => decode({ mapValue: d }));
  return res.json?.fields ? decode({ mapValue: res.json }) : [];
};
const commandRecord = async commandId => {
  const id = encodeURIComponent(commandId);
  const [record, outcomes, result] = await Promise.all([
    firestore("policy", `commands/${id}`),
    firestore("policy", `commands/${id}/outcomes`),
    firestore("policy", `commands/${id}/result/final`),
  ]);
  return { record, outcomes: outcomes ?? [], result };
};

// Every string in a `references` array anywhere in a value.
const referencesIn = (value, out = []) => {
  if (Array.isArray(value)) value.forEach(v => referencesIn(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "references" && Array.isArray(v)) v.filter(r => typeof r === "string").forEach(r => out.push(r));
      else referencesIn(v, out);
    }
  }
  return out;
};
const findKey = (value, key) => {
  if (Array.isArray(value)) {
    for (const v of value) { const f = findKey(v, key); if (f !== undefined) return f; }
  } else if (value && typeof value === "object") {
    if (key in value) return value[key];
    for (const v of Object.values(value)) { const f = findKey(v, key); if (f !== undefined) return f; }
  }
  return undefined;
};

const ITEM = "item [questions [mcq []] {}]";
const SHAPES = {
  one: { writes: 1, src: tag => `set-var "lrn-id" "${tag}" save-to-itembank items [${ITEM}] {}..` },
  two: { writes: 2, src: tag => `set-var "lrn-id" "${tag}" [save-to-itembank items [${ITEM}] {} save-to-itembank items [${ITEM}] {}]..` },
  map: { writes: 2, src: tag => `set-var "lrn-id" "${tag}" map (<x: save-to-itembank items [${ITEM}] {}>) [1 2]..` },
  long: { writes: 10, src: tag => `set-var "lrn-id" "${tag}" map (<x: save-to-itembank items [${ITEM}] {}>) [1 2 3 4 5 6 7 8 9 10]..` },
};

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok    " : "FAILED"} ${name}: ${detail}`);
};

// What the drive routes through, read from what is deployed.
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
console.log(`c6 drive ${phase} ${runId}: canary ${uid} on ${connectionId} via ${apiUrl}; l0176r-drive ${route.compilerRevision}`);

if (phase === "checks") {
  const routed = route.apiEnv.BASE_URL_L0176 === route.compilerUrl;
  record("api-drive routes L0176 to l0176r-drive", routed, `BASE_URL_L0176 ${route.apiEnv.BASE_URL_L0176}`);
  record("api-drive allocates L0176 commands", route.apiEnv.COMMANDS_L0176 === "on", `COMMANDS_L0176 ${route.apiEnv.COMMANDS_L0176}, generation ${route.apiEnv.COMPILE_GENERATION_L0176}`);
  record("l0176r-drive reaches broker-faults", route.compilerEnv.BROKER_URL === route.brokerUrl, `BROKER_URL ${route.compilerEnv.BROKER_URL}`);
  record("broker-faults faults the canary only", (route.brokerEnv.BROKER_FAULT_PRINCIPALS ?? "") === uid, `BROKER_FAULTS ${route.brokerEnv.BROKER_FAULTS ?? "unset"}, principals ${route.brokerEnv.BROKER_FAULT_PRINCIPALS}`);
  const approval = await firestore("revisions", `languages/0176/revisions/${route.compilerRevision}`);
  record("the serving l0176r-drive revision is approved", approval?.status === "approved" && approval?.service === "l0176r-drive" && typeof approval?.tagUrl === "string",
    approval ? `${approval.status}, ${approval.service}, ${approval.tagUrl}, ${approval.imageDigest}` : "no approval record");
  const pre = await http({
    method: "POST",
    url: `${route.compilerUrl}/preflight`,
    headers: { "X-Caller-Identity": await idToken(gatewayAccount, "urn:graffiticode:0176") },
    body: { stage: "s0", lang: "0176", code: await parse(SHAPES.one.src("c6-drive-check")) },
  });
  const manifest = pre.json?.data?.manifest;
  const reported = JSON.stringify(manifest ?? {});
  const same = Boolean(manifest) && reported.includes(route.compilerRevision) && Boolean(approval?.imageDigest) && reported.includes(approval.imageDigest);
  record("a gateway preflight at l0176r-drive reports that revision and image", same,
    manifest ? `revision ${findKey(manifest, "revision")}, image ${findKey(manifest, "imageDigest") ?? findKey(manifest, "image_digest")}` : `${pre.status} ${JSON.stringify(pre.json?.error ?? null)}`);
  state.checks = { at: new Date().toISOString(), route, approval, ok: results.every(r => r.ok) };
}

// The canary's access token (300 s), refreshed well before it expires.
let userToken = null;
let userTokenAt = 0;
const refreshUser = async () => {
  if (Date.now() - userTokenAt > 2 * 60_000) [userToken, userTokenAt] = [await accessToken(), Date.now()];
};
if (phase !== "checks") await refreshUser();
const asUser = () => ({ Authorization: userToken });

const postTask = async src => {
  await refreshUser();
  const res = await http({ method: "POST", url: `${apiUrl}/task`, headers: asUser(), body: { task: { lang: "0176", code: await parse(src) } } });
  const id = res.json?.data?.id;
  if (res.status !== 200 || typeof id !== "string") throw new Error(`POST /task: ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
  return id;
};

// One command by either path. The bridge answers in the compile envelope,
// which names the command; POST /command answers with it directly.
const send = async ({ id, key, via }) => {
  await refreshUser();
  if (via === "command") {
    const res = await http({ method: "POST", url: `${apiUrl}/command`, headers: asUser(), body: { id, connectionId, idempotencyKey: key } });
    return { status: res.status, commandId: res.json?.data?.commandId ?? null, outcome: res.json?.data?.outcome ?? null, body: res.json };
  }
  const res = await http({ method: "POST", url: `${apiUrl}/compile`, headers: asUser(), body: { id, data: {}, connectionId, idempotencyKey: key } });
  const command = findKey(res.json, "command");
  return { status: res.status, commandId: command?.commandId ?? null, outcome: command?.outcome ?? null, body: res.json };
};

// A command's record, once it is no longer pending (the sweeper may finish it).
const settled = async commandId => {
  for (let i = 0; ; i++) {
    const read = await commandRecord(commandId);
    if (read.record?.status && read.record.status !== "pending") return read;
    if (i >= 36) return read;
    await sleep(5000);
  }
};

const runOne = async ({ shape, via, expect }) => {
  const tag = `c6drive-${runId}-${state.commands.length}`;
  const id = await postTask(SHAPES[shape].src(tag));
  const key = `c6-drive:${runId}:${state.commands.length}`;
  const answer = await send({ id, key, via });
  const entry = { key, id, via, shape, writes: SHAPES[shape].writes, phase, httpStatus: answer.status, commandId: answer.commandId };
  if (!answer.commandId) {
    entry.error = JSON.stringify(answer.body?.error ?? answer.body?.data?.errors ?? null).slice(0, 300);
    state.commands.push(entry);
    return entry;
  }
  const read = await settled(answer.commandId);
  entry.status = read.record?.status ?? null;
  entry.result = read.record?.result?.state ?? read.record?.result ?? null;
  entry.revision = read.record?.admission?.stages?.s0?.revision ?? null;
  entry.tagUrl = read.record?.admission?.stages?.s0?.tagUrl ?? null;
  entry.outcomes = read.outcomes.map(o => ({ outcome: o.outcome, source: o.source, receipt: o.receipt ?? null }));
  entry.references = read.result?.text ? referencesIn(JSON.parse(read.result.text)) : [];
  entry.ok = entry.status === expect && (expect !== "completed" ||
    (entry.outcomes.length === entry.writes && entry.outcomes.every(o => o.outcome === "completed" && o.source === "receipt") && entry.references.length >= entry.writes));
  state.commands.push(entry);
  return entry;
};

// Same-key retries, by each command's own path: the recorded command again,
// with no new receipt and the same references.
const retry = async commands => {
  let same = 0;
  for (const c of commands) {
    const again = await send({ id: c.id, key: c.key, via: c.via });
    const read = await commandRecord(c.commandId);
    const refs = read.result?.text ? referencesIn(JSON.parse(read.result.text)) : [];
    if (again.commandId === c.commandId && read.outcomes.length === c.outcomes.length && JSON.stringify(refs) === JSON.stringify(c.references)) same++;
  }
  record("same-key retries return the recorded command and write nothing", same === commands.length, `${same}/${commands.length}`);
};

const brokerFault = route.brokerEnv.BROKER_FAULTS ?? null;

if (phase === "clean" || phase === "faults") {
  if (!state.checks?.ok) throw new Error("run --phase checks first; it must pass");
  if (phase === "clean" && brokerFault) throw new Error(`broker-faults has BROKER_FAULTS=${brokerFault}; the clean phase needs it unset`);
  if (phase === "faults" && brokerFault !== "drop-outcome") throw new Error("the faults phase needs broker-faults' BROKER_FAULTS=drop-outcome");
  const expect = phase === "clean" ? "completed" : "uncertain";
  const count = Number(flag("--count", phase === "clean" ? 188 : 12));
  const shapes = phase === "clean" ? ["one", "two", "map"] : ["one", "map"];
  const approved = state.checks.approval;
  for (let n = 0; n < count; n++) {
    const shape = shapes[n % shapes.length];
    const via = n % 2 === 0 ? "command" : "bridge";
    const entry = await runOne({ shape, via, expect });
    if (phase === "faults") state.faulted.push(entry.key);
    console.log(`  ${state.commands.length - 1} ${shape}/${via}: ${entry.status ?? entry.error} (${entry.outcomes?.map(o => `${o.outcome}:${o.source}`).join(" ") ?? ""})`);
    if (state.commands.filter(c => c.commandId).length === 1 || n === 0) {
      // The post-run check: the first command's admission names the approved revision.
      const pinned = entry.revision === approved.revision && entry.tagUrl === approved.tagUrl;
      record("the first command was admitted at the approved l0176r-drive revision", pinned, `${entry.revision} ${entry.tagUrl}`);
      if (!pinned) break;
    }
    await save();
  }
  const mine = state.commands.filter(c => c.phase === phase && c.key.includes(runId));
  record(`${phase}: every command ended ${expect}`, mine.length === count && mine.every(c => c.ok),
    `${mine.filter(c => c.ok).length}/${count}; ${[...new Set(mine.filter(c => !c.ok).map(c => c.status ?? c.error))].join(", ")}`);

  if (phase === "clean") {
    await retry(mine.filter(c => c.ok).filter((_, i) => i % 10 === 0));

    // 16 concurrent duplicates of one new key: one command, written once.
    const id = await postTask(SHAPES.one.src(`c6drive-${runId}-dup`));
    const key = `c6-drive:${runId}:dup`;
    const answers = await Promise.all(Array.from({ length: 16 }, () => send({ id, key, via: "command" })));
    const ids = new Set(answers.map(a => a.commandId).filter(Boolean));
    const [commandId] = ids;
    const read = commandId ? await settled(commandId) : null;
    const refs = read?.result?.text ? referencesIn(JSON.parse(read.result.text)) : [];
    state.commands.push({ key, id, via: "command", shape: "one", writes: 1, phase, commandId, status: read?.record?.status, outcomes: read?.outcomes?.map(o => ({ outcome: o.outcome, source: o.source })), references: refs, duplicates: 16 });
    record("16 concurrent duplicates make one command with one write", ids.size === 1 && read?.outcomes?.length === 1 && read?.record?.status === "completed",
      `${ids.size} command id(s), ${read?.outcomes?.length ?? 0} outcome(s), ${read?.record?.status}; refused: ${answers.filter(a => !a.commandId).map(a => a.status).join(" ") || "none"}`);
  }
}

// Broker's write claims for an invocation (the broker database), by operation id.
const claimsOf = async invocationId => {
  operatorToken ??= await gcloud(["auth", "print-access-token"]);
  const range = (op, value) => ({ fieldFilter: { field: { fieldPath: "operationId" }, op, value: { stringValue: value } } });
  const where = { compositeFilter: { op: "AND", filters: [range("GREATER_THAN_OR_EQUAL", `${invocationId}/`), range("LESS_THAN", `${invocationId}/\uf8ff`)] } };
  const structuredQuery = { from: [{ collectionId: "receipts" }], where, select: { fields: [{ fieldPath: "operationId" }] } };
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/broker/documents:runQuery`;
  const res = await http({ method: "POST", url, headers: { Authorization: `Bearer ${operatorToken}` }, body: { structuredQuery } });
  return (Array.isArray(res.json) ? res.json : []).filter(r => r.document).map(r => r.document.fields.operationId.stringValue);
};
// How many of an invocation's claims have a final outcome recorded.
const finishedClaims = async invocationId => {
  const ids = await claimsOf(invocationId);
  let done = 0;
  for (const op of ids) {
    // Broker keys a receipt by its operation id's SHA-256 (broker/src/firestore.ts).
    const name = createHash("sha256").update(op).digest("hex");
    const doc = await firestore("broker", `receipts/${name}/outcome/final`).catch(() => null);
    if (doc && !Array.isArray(doc)) done++;
  }
  return { claims: ids.length, done };
};
const commandIdFor = key => `c:${createHash("sha256").update(JSON.stringify([uid, key])).digest("hex")}`;
const apiFaults = (route.apiEnv.API_COMMAND_FAULTS ?? "").split(",").filter(Boolean);

// A worker fault: the commands' own requests may fail (the worker died), so
// each is read from its record once it is no longer pending.
if (phase === "kill" || phase === "lost-head") {
  if (!state.checks?.ok) throw new Error("run --phase checks first; it must pass");
  const fault = phase === "kill" ? "exit-after-write" : "lose-head-answer";
  if (JSON.stringify(apiFaults) !== JSON.stringify([fault])) throw new Error(`the ${phase} phase needs api-drive's API_COMMAND_FAULTS=${fault} alone, not ${apiFaults.join(",") || "unset"}`);
  if (route.apiEnv.API_COMMAND_FAULT_PRINCIPALS !== uid) throw new Error("api-drive's faults must name the canary alone");
  if (brokerFault) throw new Error(`broker-faults has BROKER_FAULTS=${brokerFault}; unset it first`);
  const count = Number(flag("--count", 3));
  const shapes = ["one", "two", "map"];
  const expect = phase === "kill" ? { status: "completed", result: "available" } : { status: "completed", result: "unavailable" };
  for (let n = 0; n < count; n++) {
    const shape = shapes[n % shapes.length];
    const tag = `c6drive-${runId}-${state.commands.length}`;
    const id = await postTask(SHAPES[shape].src(tag));
    const key = `c6-drive:${runId}:${state.commands.length}`;
    const answer = await send({ id, key, via: "command" }).catch(e => ({ status: null, error: String(e?.message ?? e) }));
    const commandId = commandIdFor(key);
    // The sweeper runs each minute and a dead worker's lease lasts 60 s.
    let read = await commandRecord(commandId);
    for (let i = 0; i < 60 && (!read.record || read.record.status === "pending" || read.record.publication?.state === "due"); i++) {
      await sleep(5000);
      read = await commandRecord(commandId);
    }
    const claims = read.record?.invocationId ? await claimsOf(read.record.invocationId) : [];
    const entry = {
      key,
      id,
      via: "command",
      shape,
      writes: SHAPES[shape].writes,
      phase,
      fault,
      httpStatus: answer.status,
      commandId,
      status: read.record?.status ?? null,
      result: read.record?.result?.state ?? null,
      generation: read.record?.owner?.generation ?? read.record?.generation ?? null,
      finishedBy: read.record?.owner?.worker ?? null,
      revision: read.record?.admission?.stages?.s0?.revision ?? null,
      outcomes: read.outcomes.map(o => ({ outcome: o.outcome, source: o.source, receipt: o.receipt ?? null })),
      claims: claims.length,
      references: read.result?.text ? referencesIn(JSON.parse(read.result.text)) : [],
    };
    entry.ok = entry.status === expect.status && entry.result === expect.result && entry.claims === entry.writes &&
      entry.outcomes.length === entry.writes && entry.outcomes.every(o => o.outcome === "completed" && o.source === "receipt") &&
      (phase === "lost-head" || (entry.references.length === entry.writes && /^api-/.test(entry.finishedBy ?? "") && !/^api-drive/.test(entry.finishedBy ?? "")));
    state.commands.push(entry);
    console.log(`  ${state.commands.length - 1} ${shape}: http ${entry.httpStatus}; ${entry.status}, result ${entry.result}, ${entry.claims} claim(s) for ${entry.writes} write(s), finished by ${entry.finishedBy}`);
    await save();
  }
  const mine = state.commands.filter(c => c.phase === phase && c.key.includes(runId));
  record(phase === "kill"
    ? "a worker killed after its writes: the production sweeper finished each command completed, one receipt per write"
    : "a lost head answer: each command completed from its receipts, with no result",
  mine.length === count && mine.every(c => c.ok), `${mine.filter(c => c.ok).length}/${count}`);
}

// Revocation mid-command: narrow the canary's own connection once the first
// write is claimed, then restore exactly what was there.
if (phase === "revoke") {
  if (!state.checks?.ok) throw new Error("run --phase checks first; it must pass");
  if (apiFaults.length || brokerFault) throw new Error("the revoke phase needs no api-drive or broker-faults fault set");
  const policyUrl = "https://policy-sja7fatcta-uc.a.run.app";
  const asConsole = async () => ({
    "X-Serverless-Authorization": `Bearer ${await idToken(consoleAccount, policyUrl)}`,
    "X-Caller-Identity": await idToken(consoleAccount, "urn:graffiticode:policy"),
  });
  const manage = async (method, p, body) => { await refreshUser(); return http({ method, url: `${policyUrl}${p}`, headers: { ...(await asConsole()), ...asUser() }, body }); };
  const permissions = async () => {
    const listed = await manage("GET", "/v1/connections");
    const mine = Array.isArray(listed.json?.data) ? listed.json.data.find(c => c.connectionId === connectionId) : null;
    if (!mine) throw new Error(`GET /v1/connections: ${listed.status}, ${connectionId} not listed`);
    return mine.ownerPermissions ?? null;
  };
  const setPermissions = async list => {
    const res = await manage("PUT", `/v1/connections/${encodeURIComponent(connectionId)}/owner-permissions`, { permissions: list });
    if (res.status !== 200) throw new Error(`PUT owner-permissions: ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
  };
  const count = Number(flag("--count", 2));
  const narrowAfter = flag("--narrow-after", "outcome");
  const saved = await permissions();
  console.log(`  owner permissions before: ${JSON.stringify(saved)}`);
  try {
    for (let n = 0; n < count; n++) {
      const tag = `c6drive-${runId}-${state.commands.length}`;
      const id = await postTask(SHAPES.long.src(tag));
      const key = `c6-drive:${runId}:${state.commands.length}`;
      const commandId = commandIdFor(key);
      const pending = send({ id, key, via: "command" }).catch(e => ({ status: null, error: String(e?.message ?? e) }));
      // Narrow once the first write is claimed (--narrow-after claim: between
      // its steps), or once it has its final outcome (the default: between
      // operations).
      let claimsAtNarrow = 0;
      for (let i = 0; i < 480; i++) {
        const rec = await firestore("policy", `commands/${encodeURIComponent(commandId)}`);
        if (rec?.invocationId) {
          const { claims, done } = await finishedClaims(rec.invocationId);
          claimsAtNarrow = claims;
          if (narrowAfter === "claim" ? claims > 0 : done > 0) break;
        }
        await sleep(250);
      }
      await setPermissions([{ lang: "0176", fn: "init" }]);
      const answer = await pending;
      await setPermissions(saved);
      const read = await settled(commandId);
      const claims = read.record?.invocationId ? await claimsOf(read.record.invocationId) : [];
      const outcomes = read.outcomes.map(o => ({ outcome: o.outcome, source: o.source, reason: o.reason ?? null }));
      const refusals = (await firestore("policy", `commands/${encodeURIComponent(commandId)}/refusals`)) ?? [];
      const completed = outcomes.filter(o => o.outcome === "completed" && o.source === "receipt").length;
      const entry = {
        key,
        id,
        via: "command",
        shape: "long",
        writes: completed,
        phase,
        httpStatus: answer.status,
        commandId,
        claimsAtNarrow,
        status: read.record?.status ?? null,
        result: read.record?.result?.state ?? null,
        outcomes,
        refusals: refusals.length,
        claims: claims.length,
        references: read.result?.text ? referencesIn(JSON.parse(read.result.text)) : [],
      };
      // Partial: what ran before the narrowing written once (a completed
      // operation, or one cut between its steps), every receipt one claim,
      // and the rest refused by Policy, never written.
      const fromReceipts = outcomes.filter(o => o.source === "receipt");
      const cut = fromReceipts.filter(o => o.outcome === "partial").length;
      entry.narrowAfter = narrowAfter;
      entry.cutBetweenSteps = cut;
      entry.ok = entry.status === "partial" && completed + cut >= 1 && completed < 10 && claims.length === fromReceipts.length &&
        outcomes.filter(o => o.source === "policy-refusal").every(o => o.outcome === "failed") &&
        outcomes.some(o => o.outcome === "failed" && o.source === "policy-refusal") && outcomes.length === 10;
      state.commands.push(entry);
      console.log(`  ${state.commands.length - 1} long: http ${entry.httpStatus}; ${entry.status}; narrowed at ${claimsAtNarrow} claim(s); ${completed} completed, ${outcomes.filter(o => o.outcome === "failed").length} failed (${[...new Set(outcomes.map(o => o.source + ":" + (o.reason ?? "")))].join(" ")}), ${entry.refusals} refusal record(s); ${claims.length} claim(s)`);
      await save();
    }
  } finally {
    await setPermissions(saved);
    const now = await permissions();
    record("the canary connection's owner permissions restored exactly", JSON.stringify(now) === JSON.stringify(saved), JSON.stringify(now));
  }
  const mine = state.commands.filter(c => c.phase === phase && c.key.includes(runId));
  record("revocation mid-command: partial, the saves before it written once, the rest refused unwritten", mine.length === count && mine.every(c => c.ok), `${mine.filter(c => c.ok).length}/${count}`);
}

// Every tenth clean command of every run, retried.
if (phase === "retries") await retry(state.commands.filter(c => c.phase === "clean" && c.ok && !c.duplicates).filter((_, i) => i % 10 === 0));

if (phase === "reconcile") {
  const asConsole = {
    "X-Serverless-Authorization": `Bearer ${await idToken(consoleAccount, deploy.policy.env?.PUBLIC_URL ?? "https://policy-sja7fatcta-uc.a.run.app")}`,
    "X-Caller-Identity": await idToken(consoleAccount, "urn:graffiticode:policy"),
  };
  const policyUrl = "https://policy-sja7fatcta-uc.a.run.app";
  for (const key of state.faulted.filter(k => !state.reconciled.some(r => r.key === k))) {
    await refreshUser();
    const ask = () => http({ method: "POST", url: `${policyUrl}/v1/receipts/reconcile`, headers: { ...asConsole, ...asUser() }, body: { connectionId, idempotencyKey: key } });
    let res = await ask();
    const early = (res.json?.data?.operations ?? []).filter(o => o.verdict === "too-early");
    if (res.status === 200 && early.length) {
      const wait = Math.min(Math.max(Math.max(...early.map(o => Date.parse(o.retryAfter))) - Date.now(), 0) + 2000, 180_000);
      console.log(`  ${key}: waiting ${Math.round(wait / 1000)} s for the deadline and grace period`);
      await sleep(wait);
      res = await ask();
    }
    const ops = res.json?.data?.operations ?? [];
    const command = state.commands.find(c => c.key === key);
    const after = command?.commandId ? (await commandRecord(command.commandId)).record?.status : null;
    state.reconciled.push({ key, commandId: command?.commandId ?? null, httpStatus: res.status, reason: res.json?.error?.reason ?? null, verdicts: ops.map(o => ({ operationId: o.operationId ?? null, verdict: o.verdict, final: o.final ?? null, landed: (o.records ?? []).filter(r => r.landed).length })), statusAfter: after });
    console.log(`  ${key}: ${res.status} ${ops.map(o => o.verdict).join(", ") || res.json?.error?.reason || ""}; command ${after}`);
    await save();
  }
  const applied = state.reconciled.flatMap(r => r.verdicts).filter(v => v.verdict === "applied" && v.final);
  record("at least 10 dropped-outcome operations reconciled applied", applied.length >= 10, `${applied.length} applied of ${state.reconciled.flatMap(r => r.verdicts).length}`);
  record("reconciled commands keep their uncertain outcome (D1)", state.reconciled.every(r => r.statusAfter === "uncertain"), [...new Set(state.reconciled.map(r => r.statusAfter))].join(", "));
}

if (phase !== "checks") {
  const refs = state.commands.flatMap(c => c.references ?? []);
  const repeated = refs.filter((r, i) => refs.indexOf(r) !== i);
  record("no provider reference is shared by two operations", repeated.length === 0, `${refs.length} references, ${repeated.length} repeated`);
}

state.runs.push({ runId, phase, at: new Date().toISOString(), results });
await save();
const ok = results.length > 0 && results.every(r => r.ok);
console.log(`${ok ? "PASSED" : "FAILED"} c6 drive ${phase} ${runId} (state ${stateFile})`);
process.exit(ok ? 0 : 1);
