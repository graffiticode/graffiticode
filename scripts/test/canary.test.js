import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK } from "jose";
import {
  createPolicy, createLocalSigner, createMemoryConnectionStore, createMemoryInvocationStore, createMemoryPublicationStore,
  createAudit, createPseudonymizer, createProtectedSwitch, PolicyDenied
} from "../../packages/policy/src/index.js";
import {
  createBroker, buildOperations, createMemoryOnceStore, createMemoryReceiptStore, createMemorySecretStore, createMemoryActivityStore, BrokerRefused
} from "../../packages/broker/src/index.js";
import { runCanary, hasSignedRequest } from "../lib/canary.js";

const CANARY = "0xcanary";
const CONN = "conn-canary";
const config = {
  apiUrl: "https://api.test",
  policyUrl: "https://policy.test",
  brokerUrl: "https://broker.test",
  gatewayAccount: "api-run@p.iam.gserviceaccount.com",
  compilerAccount: "l0176-run@p.iam.gserviceaccount.com",
  connectionId: CONN
};
const CALLERS = { [config.gatewayAccount]: { role: "gateway" }, [config.compilerAccount]: { role: "compiler", lang: "0176" } };

// Real in-memory Policy and Broker behind a fake HTTP router. `tweak` breaks a
// rule to prove the canary notices.
const world = async ({ tweak = {} } = {}) => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const audit = createAudit({ sink: () => {}, pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
  // Paused, with the canary configured: the canary still runs.
  const protectedSwitch = createProtectedSwitch({ cacheMs: 0, readFlag: async () => ({ enabled: false, canary: { uid: CANARY, connectionId: CONN } }) });
  const policy = createPolicy({
    signer,
    jwks,
    protectedSwitch,
    connections: createMemoryConnectionStore([{ connectionId: CONN, ownerUid: CANARY, backend: "learnosity", status: "active" }]),
    invocations: createMemoryInvocationStore(),
    publications: createMemoryPublicationStore(),
    ...(tweak.authorEnabled ? { enabledGated: new Set(["0176:author"]) } : {}),
    audit
  });
  const writes = [];
  const broker = createBroker({
    jwks,
    audit,
    protectedSwitch,
    operations: buildOperations({
      sdk: { init: (service, consumer, secret, body) => ({ service, body }) },
      domain: "d",
      dataApi: async ({ route }) => { writes.push(route); return { meta: { status: true } }; },
      ...(tweak.authorEnabled || tweak.brokerAuthorEnabled ? { enabledGated: new Set(["learnosity.sign-author"]) } : {})
    }),
    secrets: createMemorySecretStore({ [CONN]: { ownerUid: CANARY, backend: "learnosity", key: "k", secret: "s" } }),
    once: tweak.noReplayProtection ? { claim: async () => true } : createMemoryOnceStore(),
    receipts: tweak.noReceipts ? { claim: async () => ({ created: true }), putStep: async () => {}, getSteps: async () => [], getOutcome: async () => null, putOutcome: async () => {} } : createMemoryReceiptStore(),
    activity: createMemoryActivityStore()
  });

  const callerOf = (headers, urn) => {
    const [kind, account, aud] = String(headers["X-Caller-Identity"] ?? "").split("|");
    const invoker = String(headers["X-Serverless-Authorization"] ?? "").replace(/^Bearer /, "").split("|");
    assert.equal(kind, "id");
    assert.equal(aud, urn);
    assert.equal(invoker[1], account, "invoker and caller identity must be the same account");
    return CALLERS[account];
  };
  const user = headers => (headers.Authorization === "user-token" ? { uid: CANARY } : null);
  const ok = data => ({ status: 200, json: { status: "success", data } });
  const refused = (status, reason) => ({ status, json: { status: "error", error: { code: status, reason } } });
  const tasks = [];

  const http = async ({ url, headers, body }) => {
    const { origin, pathname } = new URL(url);
    try {
      if (origin === config.apiUrl && pathname === "/task") {
        tasks.push(body.task);
        return ok({ id: `task-${tasks.length}` });
      }
      if (origin === config.apiUrl && pathname === "/compile") {
        const saving = tasks[Number(body.id.split("-")[1]) - 1].code.src.includes("save-to-itembank");
        if (tweak.unsignedPreview && !saving) return ok({ data: { request: "{}" }, errors: [] });
        return ok({ data: saving ? { itemBank: { saved: true } } : { request: JSON.stringify({ security: { signature: "sig" } }) }, errors: [] });
      }
      if (origin === config.policyUrl) {
        const caller = callerOf(headers, "urn:graffiticode:policy");
        if (pathname === "/v1/invocations") return ok(await policy.allocateInvocation({ caller, user: user(headers), ...body }));
        if (pathname === "/v1/snapshot") return ok(await policy.snapshot({ caller, user: user(headers), ...body }));
        if (pathname === "/v1/mint") return ok(await policy.mint({ caller, ...body }));
      }
      if (origin === config.brokerUrl && pathname === "/v1/execute") {
        const caller = callerOf(headers, "urn:graffiticode:broker");
        return ok(await broker.execute({ caller, token: headers.Authorization.replace(/^Bearer /, ""), op: body.op, payload: body.payload }));
      }
    } catch (err) {
      if (err instanceof BrokerRefused) return refused(err.status, err.reason);
      if (err instanceof PolicyDenied) return refused(403, err.reason);
      throw err;
    }
    return { status: 404, json: null };
  };
  const idToken = async (account, audience) => (tweak.noImpersonation ? Promise.reject(new Error("permission denied to impersonate")) : `id|${account}|${audience}`);
  return { http, idToken, writes };
};

const run = async w => runCanary({ http: w.http, idToken: w.idToken, accessToken: async () => "user-token", parse: async src => ({ src, code: src }), config, runId: "t1" });
const byName = results => Object.fromEntries(results.map(r => [r.name, r.ok]));

test("passes end to end while paused with the canary configured, writing once for the replayed operation", async () => {
  const w = await world();
  const { ok, results } = await run(w);
  assert.equal(ok, true, JSON.stringify(results));
  assert.deepEqual(Object.keys(byName(results)), [
    "gateway preview", "gateway write", "gateway write retry",
    "author denied: policy", "author denied",
    "token replay: first use", "token replay", "receipt replay: first write", "receipt replay"
  ]);
  assert.deepEqual(w.writes, ["/itembank/questions", "/itembank/items"]);
});

test("fails token replay when the broker accepts a reused execution token", async () => {
  const { results, ok } = await run(await world({ tweak: { noReplayProtection: true } }));
  assert.equal(ok, false);
  assert.equal(byName(results)["token replay"], false);
});

test("fails receipt replay when a fresh token for the same operation writes again", async () => {
  const w = await world({ tweak: { noReceipts: true } });
  const { results, ok } = await run(w);
  assert.equal(ok, false);
  assert.equal(byName(results)["receipt replay"], false);
  assert.equal(w.writes.length, 4);
});

test("fails the gateway preview without a signed request, and the direct path without impersonation", async () => {
  const unsigned = await run(await world({ tweak: { unsignedPreview: true } }));
  assert.equal(byName(unsigned.results)["gateway preview"], false);
  const noImpersonation = await run(await world({ tweak: { noImpersonation: true } }));
  assert.equal(noImpersonation.ok, false);
  assert.match(noImpersonation.results.find(r => r.name === "direct path").detail, /impersonate/);
  assert.equal(byName(noImpersonation.results)["gateway write"], true);
});

test("recognizes signed requests as objects or JSON text, and nothing else", () => {
  assert.equal(hasSignedRequest({ request: { security: { signature: "s" } } }), true);
  assert.equal(hasSignedRequest({ request: JSON.stringify({ security: { signature: "s" } }) }), true);
  assert.equal(hasSignedRequest({ text: "mentions security and signature" }), false);
  assert.equal(hasSignedRequest({ security: { signature: 7 } }), false);
  // Questions requests carry the security fields at the top level.
  // eslint-disable-next-line camelcase -- Learnosity's field names
  const questions = { consumer_key: "k", timestamp: "20261005-2012", user_id: "u", signature: "s", questions: [] };
  assert.equal(hasSignedRequest({ request: questions }), true);
  assert.equal(hasSignedRequest({ request: JSON.stringify(questions) }), true);
  assert.equal(hasSignedRequest({ request: { signature: "s" } }), false);
});

test("fails author denied when this deployment enables Author", async () => {
  const { results, ok } = await run(await world({ tweak: { authorEnabled: true } }));
  assert.equal(ok, false);
  assert.equal(byName(results)["author denied: policy"], false);
  assert.equal(byName(results)["token replay"], true);
});

test("fails author denied when only the broker enables Author", async () => {
  const { results, ok } = await run(await world({ tweak: { brokerAuthorEnabled: true } }));
  assert.equal(ok, false);
  assert.equal(byName(results)["author denied: policy"], true);
  assert.equal(byName(results)["author denied"], false);
  assert.match(results.find(r => r.name === "author denied").detail, /operation-mismatch/);
});
