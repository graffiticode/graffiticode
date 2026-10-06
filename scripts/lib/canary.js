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
// Returns one result per check; the caller decides how to report and exit.

import { createHash, randomBytes } from "node:crypto";
import { argsDigest as canonicalDigest } from "@graffiticode/broker";

const ITEM = "item [questions [mcq []] {}]";
export const PREVIEW_PROGRAM = `set-var "lrn-id" "canary" items [${ITEM}] {}..`;
export const SAVE_PROGRAM = `set-var "lrn-id" "canary" save-to-itembank items [${ITEM}] {}..`;

const sha256 = s => createHash("sha256").update(s).digest("hex");

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

const hasSavedItem = value => {
  if (Array.isArray(value)) return value.some(hasSavedItem);
  if (value && typeof value === "object") return value.saved === true || Object.values(value).some(hasSavedItem);
  return false;
};

// http({ method, url, headers, body }) -> { status, json }
// idToken(account, audience) -> a Google ID token for that service account
// accessToken() -> the canary user's access token
// parse(src) -> the program's AST (L0176)
export const runCanary = async ({ http, idToken, accessToken, parse, config, runId = randomBytes(4).toString("hex"), log = () => {} }) => {
  const { apiUrl, policyUrl, brokerUrl, gatewayAccount, compilerAccount, consoleAccount, connectionId, revocationProbe = true } = config;
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
    const again = await compile(saveTaskId, key);
    const same = again.status === 200 && errorsOf(again).length === 0 && hasSavedItem(again.json?.data);
    record("gateway write retry", same, same ? "same outcome for the same idempotency key" : `${again.status} ${JSON.stringify(errorsOf(again))}`);
  });

  // Direct path: allocate an invocation as the gateway, then snapshot, mint
  // and execute as the compiler.
  const policy = path => `${policyUrl}${path}`;
  const broker = path => `${brokerUrl}${path}`;
  const direct = async () => {
    const gateway = await asService(gatewayAccount, policyUrl, "urn:graffiticode:policy");
    const compilerAtPolicy = await asService(compilerAccount, policyUrl, "urn:graffiticode:policy");
    const compilerAtBroker = await asService(compilerAccount, brokerUrl, "urn:graffiticode:broker");
    const taskId = saveTaskId ?? await postTask(SAVE_PROGRAM);
    const inv = await http({
      method: "POST",
      url: policy("/v1/invocations"),
      headers: { ...gateway, ...asUser },
      body: { connectionId, taskId, inputDigest: sha256(`canary:${runId}`), idempotencyKey: `canary:${runId}:direct` }
    });
    const invocationToken = inv.json?.data?.invocationToken;
    if (!invocationToken) throw new Error(`POST /v1/invocations: ${inv.status} ${JSON.stringify(inv.json?.error ?? null)}`);
    const snap = await http({
      method: "POST",
      url: policy("/v1/snapshot"),
      headers: { ...compilerAtPolicy, ...asUser },
      body: { lang: "0176", connectionId, fns: ["init", "save-to-itembank", "author"], invocationToken, stage: "s0" }
    });
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
