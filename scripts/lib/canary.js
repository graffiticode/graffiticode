/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
// The W0 canary (capability plan W0, docs/protected-execution.md): an end-to-end
// check of protected execution, run as the dedicated canary account through its
// sandbox connection, usually while protected execution is otherwise paused.
// Everything it needs is injected, so it can be tested without the cloud
// (scripts/test/canary.test.js). Entry point: scripts/canary.js.
//
// Gateway path, as the canary user (gateway -> L0176 -> Policy -> Broker):
//   preview   POST /compile of a preview program through the connection
//             returns a signed preview request
//   write     POST /compile of a save program returns the saved item, and the
//             same request again (same idempotency key, a fresh execution
//             token for the same operation) returns the same outcome
//   effects   (W3b, spec FAIL-01) the write's response says what the save
//             did: one save-to-itembank effect, succeeded, with its steps;
//             the retry's says the same effect was replayed
//
// Direct path, as the gateway and compiler service identities (the only way
// to hold an execution token):
//   token replay    one preview execution token executes once; reusing it is
//                   refused (409 token-replayed)
//   receipt replay  two fresh write tokens for one operation: the first writes,
//                   the second returns the recorded receipt (replayed: true)
//                   and writes nothing
//   revocation probe (W2: live authorization, owner-permission revocation)
//                   the canary owns its connection, so it narrows its own
//                   permissions to `init` and back. A fresh token for an
//                   operation that already wrote is refused once narrowed
//                   (authorization-denied:not-granted) and writes nothing; a
//                   token minted before narrowing records `failed` with no
//                   step taken. The exact original permissions are restored
//                   in a finally and read back; any mismatch fails the run.
//                   Real grant revocation is covered by Broker's tests.
//   author denied   (AUTHOR-01, W1) Author stays disabled for the connection's
//                   own owner, who otherwise holds every function: Policy's
//                   snapshot leaves `author` out of `allowed`, and Broker
//                   refuses learnosity.sign-author with operation-not-enabled
//                   before spending the (otherwise valid) token
//
// Chain admission (W4, capability plan section F; `chainAdmission`, once the
// canary connection is in api's CHAIN_ADMISSION). The canary looks up the
// gateway's own invocation as the gateway: the same connection, task, input
// digest and idempotency key reuse it, which gives the invocation token
// Policy's plan lookup needs.
//   pinned          the write's invocation is marked and has a plan, every
//                   stage pinned to an approved revision with its tag URL;
//                   L0176's is the revision serving now (which must resolve)
//   L0000 stage     a preview with input data, which api runs as an L0000
//                   stage feeding L0176: both stages pinned, each to the
//                   revision serving its language now
//   denied final stage  (AT-03, live) a chain whose first stage saves and
//                   whose final stage would sign an Author activity from
//                   upstream data: refused at admission (fn-not-enabled),
//                   with no effects in the response and no plan stored, so
//                   no stage ran
//   retry across a deploy  (AT-07, live; `retryState`) one run stores its
//                   write's task, key and pinned revision; after L0176 is
//                   deployed, the next run retries it: the same outcome,
//                   replayed, under the same plan, still pinned to the old
//                   revision (no plan-mismatch)
//   direct path     a marked invocation is preflighted at L0176 and admitted
//                   as the gateway would, and its snapshots carry the plan
// After the cutover (`afterCutover`, Policy's MIN_CONTRACT_VERSION=2):
//   v1 refused      every new invocation is marked, and a snapshot without
//                   an admitted plan (the v1 shape) is refused, plan-required
//
// Returns one result per check; the caller decides how to report and exit.

import { createHash, randomBytes } from "node:crypto";
import { argsDigest as canonicalDigest } from "@graffiticode/broker";
import { decodeChainId } from "@graffiticode/common/chain";

const ITEM = "item [questions [mcq []] {}]";
export const PREVIEW_PROGRAM = `set-var "lrn-id" "canary" items [${ITEM}] {}..`;
export const SAVE_PROGRAM = `set-var "lrn-id" "canary" save-to-itembank items [${ITEM}] {}..`;

const sha256 = s => createHash("sha256").update(s).digest("hex");
// The gateway's input digest for a compile without options (api's
// inputDigest({})), so the canary can reuse the gateway's invocation.
const NO_OPTIONS_DIGEST = sha256("{}");
// A final stage that would sign whatever activity arrives as data: L0176's
// preflight declares `author` for it (W4 PR 5), which stays disabled.
export const AUTHOR_FROM_DATA_PROGRAM = "init data {}..";

// Anything in the output carrying a Learnosity signed request: a `security`
// block (object or JSON text) with a string `signature`, as Items requests
// have, or the security fields merged into the request itself, as the SDK
// signs Questions requests (string `signature`, `consumer_key`, `timestamp`).
const isSecurity = value => Boolean(value) && typeof value === "object" && typeof value.signature === "string";
const isQuestionsSigned = value => isSecurity(value) && typeof value.consumer_key === "string" && typeof value.timestamp === "string";
export const hasSignedRequest = value => {
  if (Array.isArray(value)) return value.some(hasSignedRequest);
  if (value && typeof value === "object") {
    let security = value.security;
    if (typeof security === "string") {
      try { security = JSON.parse(security); } catch { security = null; }
    }
    if (isSecurity(security) || isQuestionsSigned(value)) return true;
    return Object.values(value).some(hasSignedRequest);
  }
  if (typeof value === "string" && (value.includes("\"security\"") || value.includes("\"signature\""))) {
    try { return hasSignedRequest(JSON.parse(value)); } catch { return false; }
  }
  return false;
};

// The save's entries in a compile's effects (api returns them beside data).
const saveEffects = res => (Array.isArray(res.json?.data?.effects) ? res.json.data.effects : []).filter(e => e?.fn === "save-to-itembank");
const describeEffects = effects => effects.length ? effects.map(e => `${e.status}${e.replayed ? " replayed" : ""} steps=${JSON.stringify(e.steps)}`).join("; ") : "no save effect in the response";

const hasSavedItem = value => {
  if (Array.isArray(value)) return value.some(hasSavedItem);
  if (value && typeof value === "object") return value.saved === true || Object.values(value).some(hasSavedItem);
  return false;
};

// http({ method, url, headers, body }) -> { status, json }
// idToken(account, audience) -> a Google ID token for that service account
// accessToken() -> the canary user's access token
// parse(src) -> the program's AST (L0176)
// servingRevision(lang) -> the revision serving that language now (W4)
// retryState { load, save, clear } -> the retry across a deploy's record (W4)
export const runCanary = async ({ http, idToken, accessToken, parse, config, servingRevision = null, retryState = null, runId = randomBytes(4).toString("hex"), log = () => {} }) => {
  const {
    apiUrl, policyUrl, brokerUrl, gatewayAccount, compilerAccount, consoleAccount, connectionId, revocationProbe = true,
    chainAdmission = false, afterCutover = false, languageUrl = null
  } = config;
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    return ok;
  };
  const attempt = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      record(name, false, err.message);
    }
  };

  const userToken = await accessToken();
  const asUser = { Authorization: userToken };
  // Private Cloud Run services: the invoker token for the service URL, and the
  // caller identity for its URN, both for the same service account.
  const asService = async (account, url, urn) => ({
    "X-Serverless-Authorization": `Bearer ${await idToken(account, url)}`,
    "X-Caller-Identity": await idToken(account, urn),
  });

  const postTask = async src => {
    const res = await http({ method: "POST", url: `${apiUrl}/task`, headers: asUser, body: { task: { lang: "0176", code: await parse(src) } } });
    const id = res.json?.data?.id;
    if (res.status !== 200 || typeof id !== "string") throw new Error(`POST /task: ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
    return id;
  };
  const compile = (id, idempotencyKey) =>
    http({ method: "POST", url: `${apiUrl}/compile`, headers: asUser, body: { id, data: {}, connectionId, idempotencyKey } });
  const errorsOf = res => [...(res.json?.data?.errors ?? []), ...(res.json?.errors ?? [])];
  const policy = path => `${policyUrl}${path}`;
  const broker = path => `${brokerUrl}${path}`;

  // As the gateway: an invocation (the gateway's own, for the same task, input
  // and key), and its plan.
  const allocate = async ({ taskId, idempotencyKey, inputDigest = NO_OPTIONS_DIGEST, admission = false }) => {
    const res = await http({
      method: "POST",
      url: policy("/v1/invocations"),
      headers: { ...(await asService(gatewayAccount, policyUrl, "urn:graffiticode:policy")), ...asUser },
      body: { connectionId, taskId, inputDigest, idempotencyKey, ...(admission ? { admission: true } : {}) }
    });
    if (typeof res.json?.data?.invocationToken !== "string") throw new Error(`POST /v1/invocations: ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
    return res.json.data;
  };
  const planOf = async (taskId, idempotencyKey) => {
    const invocation = await allocate({ taskId, idempotencyKey });
    const res = await http({
      method: "POST",
      url: policy("/v1/invocations/plan"),
      headers: { ...(await asService(gatewayAccount, policyUrl, "urn:graffiticode:policy")), ...asUser },
      body: { invocationToken: invocation.invocationToken }
    });
    if (res.status !== 200 || !res.json?.data) throw new Error(`POST /v1/invocations/plan: ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
    return { invocation, plan: res.json.data.plan ?? null };
  };
  const allPinned = plan => Boolean(plan) && plan.stages.length > 0 &&
    plan.stages.every(s => s.available === true && typeof s.tagUrl === "string" && typeof s.revision === "string");
  const describePlan = plan => (plan ? `plan ${String(plan.planDigest).slice(0, 12)} ${plan.stages.map(s => `${s.stage}=${s.revision}${s.available ? "" : " (unavailable)"}`).join(" ")}` : "no plan");
  const isWrite = res => res.status === 200 && errorsOf(res).length === 0 && hasSavedItem(res.json?.data);
  const isReplayedWrite = res => {
    const effects = saveEffects(res);
    return effects.length === 1 && effects[0].status === "succeeded" && effects[0].replayed === true;
  };

  // The retry across a deploy (W4): a write recorded by an earlier run, under
  // a plan pinned to the revision that served then, retried now.
  const pending = chainAdmission && retryState ? await retryState.load() : null;
  if (pending) {
    await attempt("retry across a deploy", async () => {
      const now = servingRevision ? await servingRevision("0176") : null;
      if (!record("retry across a deploy: deployed", Boolean(now) && now !== pending.revision,
        now === pending.revision ? `L0176 still serves ${now}, the revision the write was pinned to; deploy L0176, then run the canary again` : `pinned ${pending.revision}, serving ${now}`)) return;
      const again = await compile(pending.taskId, pending.key);
      const { plan } = await planOf(pending.taskId, pending.key);
      const samePlan = plan?.planDigest === pending.planDigest && plan.stages.every(s => s.revision === pending.revision);
      const ok = isWrite(again) && isReplayedWrite(again) && samePlan;
      record("retry across a deploy", ok, ok
        ? `replayed on ${pending.revision} under the same plan`
        : `${again.status} ${JSON.stringify(errorsOf(again))} ${describeEffects(saveEffects(again))}; ${describePlan(plan)}`);
      if (ok) await retryState.clear();
    });
  }

  // Gateway path.
  await attempt("gateway preview", async () => {
    const id = await postTask(PREVIEW_PROGRAM);
    const res = await compile(id, `canary:${runId}:preview`);
    const errors = errorsOf(res);
    record("gateway preview", res.status === 200 && errors.length === 0 && hasSignedRequest(res.json?.data),
      res.status === 200 && errors.length === 0 ? (hasSignedRequest(res.json?.data) ? "signed preview returned" : "no signed request in the output") : `${res.status} ${JSON.stringify(errors)}`);
  });
  let saveTaskId = null;
  await attempt("gateway write", async () => {
    saveTaskId = await postTask(SAVE_PROGRAM);
    const key = `canary:${runId}:save`;
    const first = await compile(saveTaskId, key);
    const ok = first.status === 200 && errorsOf(first).length === 0 && hasSavedItem(first.json?.data);
    if (!record("gateway write", ok, ok ? "draft saved through the connection" : `${first.status} ${JSON.stringify(errorsOf(first))}`)) return;
    const wrote = saveEffects(first);
    record("gateway write effects", wrote.length === 1 && wrote[0].status === "succeeded" && !wrote[0].replayed && Array.isArray(wrote[0].steps) && wrote[0].steps.length > 0,
      describeEffects(wrote));
    const again = await compile(saveTaskId, key);
    const same = again.status === 200 && errorsOf(again).length === 0 && hasSavedItem(again.json?.data);
    record("gateway write retry", same, same ? "same outcome for the same idempotency key" : `${again.status} ${JSON.stringify(errorsOf(again))}`);
    const replayed = saveEffects(again);
    record("gateway write retry effects", replayed.length === 1 && replayed[0].status === "succeeded" && replayed[0].replayed === true,
      describeEffects(replayed));
    if (!chainAdmission) return;
    // W4: that write ran under a plan, pinned to approved revisions.
    const { invocation, plan } = await planOf(saveTaskId, key);
    // Evidence, not assumption: without the serving revision the check fails.
    const serving = servingRevision ? await servingRevision("0176") : null;
    const l0176 = plan ? plan.stages.filter(s => s.lang === "0176") : [];
    const pinned = invocation.reused === true && invocation.contract === 2 && allPinned(plan) &&
      typeof serving === "string" && l0176.length > 0 && l0176.every(s => s.revision === serving);
    record("chain admission: pinned", pinned, invocation.reused !== true
      ? "the gateway's invocation for this write wasn't found"
      : `contract ${invocation.contract}, ${describePlan(plan)}, ${typeof serving === "string" ? `L0176 serving ${serving}` : "L0176's serving revision unknown"}`);
    if (pinned && retryState && !pending) {
      await retryState.save({ taskId: saveTaskId, key, revision: plan.stages[0].revision, planDigest: plan.planDigest });
      log("recorded this write for the retry across a deploy: deploy L0176, then run the canary again");
    }
  });

  // W4: a real L0000 -> L0176 chain. Input data makes the gateway prepend an
  // L0000 stage that runs first (api's compile route), so L0000 is
  // preflighted, admitted and bound as a Policy caller too. A preview, so it
  // writes nothing.
  if (chainAdmission) {
    await attempt("chain admission: L0000 stage", async () => {
      const previewId = await postTask(PREVIEW_PROGRAM);
      const key = `canary:${runId}:chain`;
      const res = await http({ method: "POST", url: `${apiUrl}/compile`, headers: asUser, body: { id: previewId, data: { canary: runId }, connectionId, idempotencyKey: key } });
      const errors = errorsOf(res);
      const chainId = res.json?.id;
      if (!record("chain admission: L0000 stage: compiled", res.status === 200 && errors.length === 0 && hasSignedRequest(res.json?.data) && typeof chainId === "string",
        res.status === 200 && errors.length === 0 ? (hasSignedRequest(res.json?.data) ? "signed preview returned" : "no signed request in the output") : `${res.status} ${JSON.stringify(errors)}`)) return;
      const { invocation, plan } = await planOf(chainId, key);
      const serving = { "0176": servingRevision ? await servingRevision("0176") : null, "0000": servingRevision ? await servingRevision("0000") : null };
      const langs = plan ? plan.stages.map(s => s.lang) : [];
      const ok = invocation.reused === true && allPinned(plan) && JSON.stringify(langs) === JSON.stringify(["0176", "0000"]) &&
        plan.stages.every(s => typeof serving[s.lang] === "string" && s.revision === serving[s.lang]);
      record("chain admission: L0000 stage", ok, invocation.reused !== true
        ? "the gateway's invocation for this chain wasn't found"
        : `${describePlan(plan)}, serving L0176 ${serving["0176"] ?? "unknown"}, L0000 ${serving["0000"] ?? "unknown"}`);
    });
  }

  // W4, AT-03 live: the final stage is refused at admission, so the stage
  // that would save never runs.
  if (chainAdmission) {
    await attempt("denied final stage", async () => {
      const headId = await postTask(AUTHOR_FROM_DATA_PROGRAM);
      const chainId = `${headId}+${saveTaskId ?? await postTask(SAVE_PROGRAM)}`;
      const key = `canary:${runId}:denied`;
      const res = await compile(chainId, key);
      const errors = errorsOf(res);
      const effects = Array.isArray(res.json?.data?.effects) ? res.json.data.effects : [];
      const { plan } = await planOf(chainId, key);
      const ok = res.status === 200 && errors.some(e => e?.code === "fn-not-enabled") && effects.length === 0 && !hasSavedItem(res.json?.data) && plan === null;
      record("denied final stage", ok, `${res.status} ${JSON.stringify(errors.map(e => e?.code ?? e?.message))}, ${effects.length} effects, ${describePlan(plan)}`);
    });
  }

  // Direct path: allocate an invocation as the gateway, then snapshot, mint
  // and execute as the compiler. A marked invocation (W4) is preflighted at
  // L0176 and admitted first, as the gateway does, and its snapshot carries
  // the plan.
  const direct = async () => {
    const compilerAtPolicy = await asService(compilerAccount, policyUrl, "urn:graffiticode:policy");
    const compilerAtBroker = await asService(compilerAccount, brokerUrl, "urn:graffiticode:broker");
    const taskId = saveTaskId ?? await postTask(SAVE_PROGRAM);
    const snapshotAt = (invocationToken, plan = {}) => http({
      method: "POST",
      url: policy("/v1/snapshot"),
      headers: { ...compilerAtPolicy, ...asUser },
      body: { lang: "0176", connectionId, fns: ["init", "save-to-itembank", "author"], invocationToken, stage: "s0", ...plan }
    });

    if (afterCutover) {
      await attempt("v1 refused", async () => {
        const inv = await allocate({ taskId, idempotencyKey: `canary:${runId}:v1`, inputDigest: sha256(`canary:${runId}:v1`) });
        if (!record("v1 refused: invocation marked", inv.contract === 2 && inv.minContractVersion === 2,
          `contract ${inv.contract}, Policy's minimum ${inv.minContractVersion}`)) return;
        const snap = await snapshotAt(inv.invocationToken);
        record("v1 refused", snap.status === 403 && snap.json?.error?.reason === "plan-required",
          `a snapshot without a plan answered ${snap.status} ${snap.json?.error?.reason ?? "with a session"}`);
      });
    }

    const inv = await allocate({ taskId, idempotencyKey: `canary:${runId}:direct`, inputDigest: sha256(`canary:${runId}`), admission: chainAdmission });
    let plan = {};
    if (inv.contract === 2) {
      if (!languageUrl) throw new Error("a marked invocation needs L0176's URL (languageUrl) for its preflight");
      const pre = await http({
        method: "POST",
        url: `${languageUrl}/preflight`,
        headers: { "X-Caller-Identity": await idToken(gatewayAccount, "urn:graffiticode:0176") },
        body: { stage: "s0", lang: "0176", code: await parse(SAVE_PROGRAM) }
      });
      const manifest = pre.json?.data?.manifest;
      if (pre.status !== 200 || !manifest) throw new Error(`L0176 /preflight: ${pre.status} ${JSON.stringify(pre.json?.error ?? null)}`);
      const admitted = await http({
        method: "POST",
        url: policy("/v1/admissions"),
        headers: { ...(await asService(gatewayAccount, policyUrl, "urn:graffiticode:policy")), ...asUser },
        // The canonical chain: a task id is itself an encoded chain of one.
        body: { invocationToken: inv.invocationToken, taskIds: decodeChainId(taskId), stages: [manifest] }
      });
      const admissionToken = admitted.json?.data?.admissionToken;
      if (!record("direct path: admitted", typeof admissionToken === "string",
        typeof admissionToken === "string" ? `s0 pinned to ${manifest.revision}` : `${admitted.status} ${JSON.stringify(admitted.json?.error ?? null)}`)) return;
      plan = { admissionToken, manifest };
    }
    const invocationToken = inv.invocationToken;
    const snap = await snapshotAt(invocationToken, plan);
    const sessionToken = snap.json?.data?.sessionToken;
    if (!sessionToken) throw new Error(`POST /v1/snapshot: ${snap.status} ${JSON.stringify(snap.json?.error ?? null)}`);
    const allowed = snap.json.data.allowed ?? [];
    const mint = async (fn, op, occurrenceId, payload) => {
      const res = await http({
        method: "POST",
        url: policy("/v1/mint"),
        headers: compilerAtPolicy,
        body: { sessionToken, fn, op, occurrenceId, argsDigest: canonicalDigest(payload) }
      });
      const token = res.json?.data?.executionToken;
      if (!token) throw new Error(`POST /v1/mint ${op}: ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
      return token;
    };
    const execute = (token, op, payload) =>
      http({ method: "POST", url: broker("/v1/execute"), headers: { ...compilerAtBroker, Authorization: `Bearer ${token}` }, body: { op, payload } });

    await attempt("author denied", async () => {
      // The canary owns the connection, so only the gate can withhold Author.
      if (!record("author denied: policy", allowed.includes("init") && !allowed.includes("author"),
        `snapshot allowed ${JSON.stringify(allowed)}`)) return;
      const op = "learnosity.sign-items-preview";
      const payload = { id: "canary", questions: [{ type: "mcq", response_id: `canary-author-${runId}` }] };
      const token = await mint("init", op, "CANARY_AUTHOR:1.0", payload);
      const res = await execute(token, "learnosity.sign-author", { reference: "graffiticode-canary" });
      record("author denied", res.status === 403 && res.json?.error?.reason === "operation-not-enabled",
        `broker answered ${res.status} ${res.json?.error?.reason ?? res.json?.data?.status}`);
    });

    await attempt("token replay", async () => {
      const op = "learnosity.sign-items-preview";
      const payload = { id: "canary", questions: [{ type: "mcq", response_id: `canary-${runId}` }] };
      const token = await mint("init", op, "CANARY_PREVIEW:1.0", payload);
      const first = await execute(token, op, payload);
      if (!record("token replay: first use", first.status === 200 && first.json?.data?.status === "succeeded", `${first.status} ${first.json?.data?.status ?? JSON.stringify(first.json?.error ?? null)}`)) return;
      const reused = await execute(token, op, payload);
      record("token replay", reused.status === 409 && reused.json?.error?.reason === "token-replayed",
        `reuse answered ${reused.status} ${reused.json?.error?.reason ?? reused.json?.data?.status}`);
    });

    await attempt("receipt replay", async () => {
      const op = "learnosity.write-items";
      const payload = {
        questionRecords: [{ type: "mcq", reference: "canary-q-0", data: { type: "mcq", stimulus: "Canary", options: [{ label: "A", value: "0" }], validation: { valid_response: { score: 1, value: ["0"] } } } }],
        itemRecords: [{ reference: "graffiticode-canary", status: "unpublished", definition: { widgets: [{ reference: "canary-q-0" }] }, questions: [{ reference: "canary-q-0" }] }]
      };
      const [a, b] = [await mint("save-to-itembank", op, "CANARY_SAVE:1.0", payload), await mint("save-to-itembank", op, "CANARY_SAVE:1.0", payload)];
      const first = await execute(a, op, payload);
      if (!record("receipt replay: first write", first.status === 200 && first.json?.data?.status === "succeeded" && !first.json?.data?.replayed,
        `${first.status} ${first.json?.data?.status ?? JSON.stringify(first.json?.error ?? null)}`)) return;
      const second = await execute(b, op, payload);
      record("receipt replay", second.status === 200 && second.json?.data?.replayed === true && second.json?.data?.status === "succeeded",
        `fresh token for the same operation answered ${second.status} ${second.json?.data?.status} replayed=${second.json?.data?.replayed}`);
    });

    if (!revocationProbe) return;
    // The probe acts on the connection through Policy's console routes, as
    // the console caller with the canary's own user token.
    const asConsole = await asService(consoleAccount, policyUrl, "urn:graffiticode:policy");
    const manage = (method, path, body) => http({ method, url: policy(path), headers: { ...asConsole, ...asUser }, body });
    const listed = await manage("GET", "/v1/connections");
    const mine = Array.isArray(listed.json?.data) ? listed.json.data.find(c => c.connectionId === connectionId) : null;
    if (!mine) throw new Error(`GET /v1/connections: ${listed.status}, ${connectionId} not listed`);
    const saved = mine.ownerPermissions ?? null;
    const setPermissions = async permissions => {
      const res = await manage("PUT", `/v1/connections/${encodeURIComponent(connectionId)}/owner-permissions`, { permissions });
      if (res.status !== 200) throw new Error(`PUT owner-permissions: ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
    };
    const narrow = () => setPermissions([{ lang: "0176", fn: "init" }]);
    const op = "learnosity.write-items";
    const payload = {
      questionRecords: [{ type: "mcq", reference: "canary-q-0", data: { type: "mcq", stimulus: "Canary", options: [{ label: "A", value: "0" }], validation: { valid_response: { score: 1, value: ["0"] } } } }],
      itemRecords: [{ reference: "graffiticode-canary", status: "unpublished", definition: { widgets: [{ reference: "canary-q-0" }] }, questions: [{ reference: "canary-q-0" }] }]
    };
    try {
      await attempt("revocation probe", async () => {
        // A writes; B, a fresh token for the same operation, is held.
        const [a, b] = [await mint("save-to-itembank", op, "CANARY_PROBE:1.0", payload), await mint("save-to-itembank", op, "CANARY_PROBE:1.0", payload)];
        const first = await execute(a, op, payload);
        if (!record("revocation probe: first write", first.status === 200 && first.json?.data?.status === "succeeded",
          `${first.status} ${first.json?.data?.status ?? JSON.stringify(first.json?.error ?? null)}`)) return;
        await narrow();
        const replay = await execute(b, op, payload);
        record("revocation probe: replay after narrowing", replay.status === 403 && replay.json?.error?.reason === "authorization-denied:not-granted",
          `answered ${replay.status} ${replay.json?.error?.reason ?? replay.json?.data?.status}`);
        // C is minted with the permissions back, then they're narrowed again.
        await setPermissions(saved);
        const c = await mint("save-to-itembank", op, "CANARY_PROBE:2.0", payload);
        await narrow();
        const late = await execute(c, op, payload);
        const data = late.json?.data;
        record("revocation probe: minted, then narrowed", late.status === 200 && data?.status === "failed" &&
          Array.isArray(data.steps) && data.steps.length === 0 && data.reason === "authorization-denied:not-granted",
        `answered ${late.status} ${data?.status ?? JSON.stringify(late.json?.error ?? null)} steps=${JSON.stringify(data?.steps)} ${data?.reason ?? ""}`);
      });
    } finally {
      // Restore exactly what was there, and prove it.
      await attempt("revocation probe: permissions restored", async () => {
        await setPermissions(saved);
        const after = await manage("GET", "/v1/connections");
        const now = Array.isArray(after.json?.data) ? after.json.data.find(c => c.connectionId === connectionId) : null;
        const restored = JSON.stringify(now?.ownerPermissions ?? null) === JSON.stringify(saved);
        record("revocation probe: permissions restored", restored, `owner permissions ${JSON.stringify(now?.ownerPermissions ?? null)}, expected ${JSON.stringify(saved)}`);
      });
    }
  };
  await attempt("direct path", direct);

  return { ok: results.length > 0 && results.every(r => r.ok), results };
};
