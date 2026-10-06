// AT-12, audit portion (spec AUDIT-01, FAIL-01; W3 PR 4). Gateway (api's real
// /compile route, behind its body parser, request context and auth
// middleware, as app.js mounts them), Policy and Broker run as real HTTP
// servers in this process and talk through their real clients: api's policy client, Broker's HTTP authorizer, and a
// compiler stand-in that does what L0176 does over HTTP (snapshot, mint,
// execute) with the same identity headers. Every service's audit records are
// captured together and inspected for correlation, categories, effects and
// redaction, across success, denial, partial, outage, uncertain, failures of
// authentication and parsing, artifact storage, replay, publications, system
// previews, and requests that put sensitive markers where records copy them.
// (AT-12's mixed-version cutover/rollback portion is W4's.)
import http from "node:http";
import { generateKeyPair, exportJWK } from "jose";
import {
  createPolicy, createPolicyApp, createConnectionManager, createCallerIdentity, createLocalSigner,
  createMemoryConnectionStore, createMemoryInvocationStore, createMemoryPublicationStore, createMemoryGrantStore,
  grantIdFor, createAudit, createPseudonymizer, createProtectedSwitch
} from "@graffiticode/policy";
import { buildPolicyRequest } from "@graffiticode/policy/client";
import {
  createBroker, createBrokerApp, buildOperations, createMemoryOnceStore, createMemoryReceiptStore,
  createMemoryActivityStore, createMemorySecretStore, buildPolicyAuthorizer, argsDigest
} from "@graffiticode/broker";
import express from "express";
import { requestContextMiddleware } from "@graffiticode/policy/audit";
import * as routes from "./routes/index.js";
import { buildDataApi } from "./data.js";
import { buildAllocateInvocation } from "./invocations.js";
import { createApiAudit } from "./audit.js";
import { buildMemoryArtifactStorer } from "./storage/artifacts.js";
import { createStorers } from "./storage/index.js";
import { clearFirestore } from "./testing/firestore.js";

// The markers redaction must keep out of every record.
const OWNER = "0x00000000000000000000000000000000000c0ffee";
const OTHER = "0x0000000000000000000000000000000000000bad";
const KEY = "consumer-key-MARKER";
const SECRET = "consumer-secret-MARKER";
const STIMULUS = "STIMULUS-MARKER what is 2+2";
const EMAIL = "marker@example.com";
const SOURCE = "SOURCE-MARKER";
const FORBIDDEN = [OWNER, OTHER, KEY, SECRET, "STIMULUS-MARKER", EMAIL, SOURCE, /eyJ[A-Za-z0-9_-]{8,}/];

const SA = {
  gateway: "api-run@graffiticode.iam.gserviceaccount.com",
  compiler: "l0176-run@graffiticode.iam.gserviceaccount.com",
  broker: "broker-run@graffiticode.iam.gserviceaccount.com",
  console: "console-run@graffiticode-app.iam.gserviceaccount.com",
  stranger: "stranger@example.iam.gserviceaccount.com",
};
// Stand-ins for Google's ID tokens: a caller identity is "idt|<email>|<urn>";
// an invoker token is the unsigned JWT Cloud Run forwards, naming the email.
const b64 = v => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const idTokenFor = account => async audience => (audience.startsWith("urn:") ? `idt|${account}|${audience}` : `${b64("{}")}.${b64({ email: account })}.`);
const verifyIdToken = async (token, audience) => {
  const [kind, email, aud] = token.split("|");
  if (kind !== "idt" || aud !== audience) throw new Error("bad token");
  return { iss: "https://accounts.google.com", email, email_verified: true, aud };
};
const verifyUser = async token => { if (!token.startsWith("user:")) throw new Error("bad user token"); return { uid: token.slice(5) }; };

// Every server is tracked as it starts, so afterEach closes them all even if
// setup failed partway.
const openServers = [];
const listen = app => new Promise(resolve => {
  const server = http.createServer(app).listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}` }));
  openServers.push(server);
});

let world;
let records;

const PAYLOAD = {
  questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq", stimulus: STIMULUS, options: [{ label: "A", value: "0" }], validation: { valid_response: { score: 1, value: ["0"] } } } }],
  itemRecords: [{ reference: "item-0", status: "unpublished", definition: { widgets: [{ reference: "q-0" }] }, questions: [{ reference: "q-0" }] }]
};
const PREVIEW = { id: "p", questions: [{ type: "mcq", response_id: "r1", stimulus: STIMULUS }] };
const WRITE_OP = "learnosity.write-items";
const SIGN_OP = "learnosity.sign-items-preview";

beforeEach(async () => {
  await clearFirestore();
  records = [];
  const tag = service => r => records.push({ service, ...r });
  const pseudonymize = createPseudonymizer({ secret: "test-secret-0123456789" });
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const on = createProtectedSwitch({ cacheMs: 0, readFlag: async () => ({ enabled: true }) });
  const connections = createMemoryConnectionStore([
    { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" },
    { connectionId: "conn-sys", ownerUid: "0xsystemowner", backend: "learnosity", status: "active" },
  ]);
  const grants = createMemoryGrantStore([{
    grantId: grantIdFor({ connectionId: "conn-1", recipientUid: OTHER }),
    connectionId: "conn-1", ownerUid: OWNER, recipientUid: OTHER, expiresAt: null,
    permissions: [{ lang: "0176", fn: "init" }, { lang: "0176", fn: "save-to-itembank" }],
  }]);
  const publications = createMemoryPublicationStore();
  const policyAudit = createAudit({ sink: tag("policy"), pseudonymize });
  const policy = createPolicy({
    protectedSwitch: on, signer, jwks, connections, grants, publications,
    invocations: createMemoryInvocationStore(), systemConnections: { learnosity: "conn-sys" }, audit: policyAudit,
  });
  const manager = createConnectionManager({ connections, grants, audit: policyAudit, brokerAdmin: { createSecret: async () => {}, rotateSecret: async () => {}, deleteSecret: async () => {} } });
  const policyApp = createPolicyApp({
    policy, manager, verifyUser, publicJwks: jwks, audit: policyAudit,
    identifyCaller: createCallerIdentity({ verifyIdToken, audience: "urn:graffiticode:policy", callers: {
      [SA.gateway]: { role: "gateway" }, [SA.compiler]: { role: "compiler", lang: "0176" }, [SA.broker]: { role: "broker" }, [SA.console]: { role: "console" },
    } }),
  });
  const policyServer = await listen(policyApp);

  const providerCalls = [];
  const hooks = { onRoute: null };
  const brokerAudit = createAudit({ sink: tag("broker"), pseudonymize });
  const brokerFor = policyUrl => createBroker({
    protectedSwitch: on, jwks, audit: brokerAudit,
    operations: buildOperations({
      sdk: { init: (service, consumer, secret, body) => ({ service, signature: "sig", body }) },
      domain: "d",
      dataApi: async ({ route }) => { providerCalls.push(route); await hooks.onRoute?.(route); return { meta: { status: true } }; },
    }),
    secrets: createMemorySecretStore({
      "conn-1": { ownerUid: OWNER, backend: "learnosity", key: KEY, secret: SECRET },
      "conn-sys": { ownerUid: "0xsystemowner", backend: "learnosity", key: KEY, secret: SECRET },
    }),
    once: createMemoryOnceStore(), receipts: createMemoryReceiptStore(), activity: createMemoryActivityStore(),
    authorize: buildPolicyAuthorizer({ policyUrl, idToken: idTokenFor(SA.broker) }),
  });
  const brokerIdentity = createCallerIdentity({ verifyIdToken, audience: "urn:graffiticode:broker", callers: { [SA.compiler]: { role: "compiler", lang: "0176" }, [SA.broker]: { role: "policy" } } });
  const brokerServer = await listen(createBrokerApp({ broker: brokerFor(policyServer.url), secrets: null, identifyCaller: brokerIdentity, audit: brokerAudit }));
  // A Broker whose Policy is unreachable: every authorization is unavailable.
  const deadPolicy = await listen((_req, res) => res.destroy());
  const outageBroker = await listen(createBrokerApp({ broker: brokerFor(deadPolicy.url), secrets: null, identifyCaller: brokerIdentity, audit: brokerAudit }));

  // The compiler stand-in: what L0176 does over HTTP, and the effects W3b's
  // languages report beside their output.
  const asCompiler = buildPolicyRequest({ policyUrl: policyServer.url, idToken: idTokenFor(SA.compiler) });
  const execute = async (brokerUrl, executionToken, op, payload) => {
    const compilerToken = idTokenFor(SA.compiler);
    const res = await fetch(`${brokerUrl}/v1/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${executionToken}`,
        "X-Caller-Identity": await compilerToken("urn:graffiticode:broker"),
        "X-Serverless-Authorization": `Bearer ${await compilerToken(brokerUrl)}`,
      },
      body: JSON.stringify({ op, payload }),
    });
    return { status: res.status, body: /** @type {any} */ (await res.json()) };
  };
  const program = { kind: "save", brokerUrl: brokerServer.url };
  const compile = async ({ lang, data, auth, connectionId, invocationToken, stage }) => {
    // Only L0176 acts; any other stage (the data task api's /compile appends)
    // is a plain literal compiler, as L0000 is.
    if (lang !== "0176") return { data, errors: [] };
    const save = program.kind === "save";
    const fn = save ? "save-to-itembank" : "init";
    const op = save ? WRITE_OP : SIGN_OP;
    const payload = save ? PAYLOAD : PREVIEW;
    const snap = /** @type {any} */ (await asCompiler("POST", "/v1/snapshot", { authToken: auth, body: { lang: "0176", connectionId, fns: [fn], invocationToken, stage } }).catch(e => ({ refused: e })));
    if (snap.refused) return { errors: [{ message: `refused: ${snap.refused.reason}` }], effects: [{ fn, op, status: "failed", steps: [], reason: snap.refused.reason }] };
    const mint = /** @type {any} */ (await asCompiler("POST", "/v1/mint", { body: { sessionToken: snap.body.data.sessionToken, fn, op, occurrenceId: "n1.0", argsDigest: argsDigest(payload) } }).catch(e => ({ refused: e })));
    if (mint.refused) return { errors: [{ message: `refused: ${mint.refused.reason}` }], effects: [{ fn, op, status: "failed", steps: [], reason: mint.refused.reason }] };
    const out = await execute(program.brokerUrl, mint.body.data.executionToken, op, payload);
    const effect = out.status === 200
      ? { fn, op, ...pick(out.body.data, ["status", "steps", "failedStep", "reason", "category", "replayed"]) }
      : { fn, op, status: "failed", steps: [], reason: out.body.error.reason, category: out.body.error.category };
    return effect.status === "succeeded"
      ? { data: { saved: save }, errors: [], effects: [effect] }
      : { errors: [{ message: `${op} ${effect.status}` }], effects: [effect] };
  };

  const { taskStorer, compileStorer } = createStorers();
  const apiAudit = createApiAudit({ sink: tag("api") });
  const makeDataApi = ({ artifactStorer = buildMemoryArtifactStorer() } = {}) => buildDataApi(/** @type {any} */ ({
    compile,
    allocateInvocation: buildAllocateInvocation({ policyUrl: policyServer.url, idToken: idTokenFor(SA.gateway) }),
    artifactStorer,
    audit: apiAudit,
  }));
  const taskId = await taskStorer.create(/** @type {any} */ ({ task: { lang: "0176", code: { 1: { tag: "STR", elts: [SOURCE] }, 2: { tag: "EXPRS", elts: [1] }, root: 2 } } }));
  // api over HTTP: its real /compile route and middleware order (app.js).
  const apiServerFor = async dataApi => {
    const app = express();
    app.use(express.json({ limit: "50mb" }));
    app.use(requestContextMiddleware);
    app.use(routes.auth({ validateToken: async token => { if (!token.startsWith("user:")) throw new Error("bad user token"); return { uid: token.slice(5) }; } }));
    app.use("/compile", routes.compile(/** @type {any} */ ({ taskStorer, compileStorer, dataApi })));
    return listen(app);
  };
  const apiServer = await apiServerFor(makeDataApi());
  world = {
    policy, grants, publications, providerCalls, hooks, program, taskStorer, compileStorer, taskId, makeDataApi, execute, asCompiler,
    policyUrl: policyServer.url, brokerUrl: brokerServer.url, outageBrokerUrl: outageBroker.url,
    asGateway: buildPolicyRequest({ policyUrl: policyServer.url, idToken: idTokenFor(SA.gateway) }),
    asBroker: buildPolicyRequest({ policyUrl: policyServer.url, idToken: idTokenFor(SA.broker) }),
    apiUrl: apiServer.url, apiServerFor,
  };
});

afterEach(async () => {
  const servers = openServers.splice(0);
  await Promise.all(servers.map(s => new Promise(resolve => { s.closeAllConnections?.(); s.close(() => resolve()); })));
});

const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]));
// POST /compile to api, as the console does; resolves to the compile result.
const compileAs = async (uid, { dataApi = null, idempotencyKey = "job-1" } = {}) => {
  let url = world.apiUrl;
  if (dataApi) url = (await world.apiServerFor(dataApi)).url;
  const res = await fetch(`${url}/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer user:${uid}` },
    body: JSON.stringify({ id: world.taskId, connectionId: "conn-1", idempotencyKey }),
  });
  const body = /** @type {any} */ (await res.json());
  if (res.status !== 200) throw new Error(`POST /compile ${res.status} ${JSON.stringify(body.error)}`);
  return body.data;
};
const of = (service, event) => records.filter(r => r.service === service && r.event === event);

// Redaction holds for every record of every case: checked after each test.
afterEach(() => {
  const text = JSON.stringify(records);
  for (const marker of FORBIDDEN) {
    if (marker instanceof RegExp) expect(text).not.toMatch(marker);
    else expect(text).not.toContain(marker);
  }
  for (const r of records.filter(r => r.service === "api")) {
    expect(r).not.toHaveProperty("user");
    expect(r).not.toHaveProperty("owner");
  }
});

describe("AT-12: one compile through the connection", () => {
  it("is traceable gateway -> Policy -> Broker by trusted ids, one decision per step", async () => {
    const out = await compileAs(OWNER);
    expect(out.errors).toEqual([]);
    expect(out.effects).toEqual([{ fn: "save-to-itembank", op: WRITE_OP, status: "succeeded", steps: ["questions", "items"], stage: "s0" }]);
    const [gateway] = of("api", "gateway-invocation");
    const { invocationId } = gateway;
    expect(gateway).toMatchObject({ outcome: "allowed", connectionId: "conn-1" });
    expect(gateway.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(of("policy", "invocation")).toEqual([expect.objectContaining({ outcome: "allowed", invocationId, callerRole: "gateway" })]);
    expect(of("policy", "snapshot")).toEqual([expect.objectContaining({ outcome: "allowed", invocationId, stage: "s0", callerRole: "compiler" })]);
    const [mint] = of("policy", "mint");
    expect(mint).toMatchObject({ outcome: "allowed", invocationId, stage: "s0", callerRole: "compiler" });
    const decisions = of("policy", "authorize-execution");
    const steps = of("broker", "execute-step");
    expect(decisions.map(r => [r.step, r.purpose, r.opid, r.invocationId, r.callerRole])).toEqual([
      ["questions", "dispatch", mint.opid, invocationId, "broker"],
      ["items", "dispatch", mint.opid, invocationId, "broker"],
    ]);
    // Each Broker step is the one Policy decided: same decision id.
    expect(steps.map(r => r.decisionId)).toEqual(decisions.map(r => r.decisionId));
    const [final] = of("broker", "execute");
    expect(final).toMatchObject({ outcome: "allowed", opid: mint.opid, invocationId, stage: "s0", steps: ["questions", "items"], callerRole: "compiler" });
    expect(of("api", "artifact")).toEqual([expect.objectContaining({ outcome: "succeeded", invocationId })]);
    // Every record of every service names the request it was written in.
    expect(records.every(r => typeof r.requestId === "string")).toBe(true);
  });

  it("replays a retry with the same idempotency key, deciding the replay too", async () => {
    await compileAs(OWNER);
    records.length = 0;
    const out = await compileAs(OWNER);
    expect(out.effects).toEqual([expect.objectContaining({ status: "succeeded", replayed: true })]);
    expect(of("policy", "authorize-execution").map(r => [r.step, r.purpose])).toEqual([["receipt", "replay"]]);
    expect(of("broker", "execute").at(-1)).toMatchObject({ outcome: "replayed" });
    expect(world.providerCalls).toEqual(["/itembank/questions", "/itembank/items"]);
  });
});

describe("AT-12: denials, partial and uncertain effects, outages", () => {
  it("records a denial before allocation with only what was verified", async () => {
    const out = await compileAs("0x000000000000000000000000000000000000dead");
    expect(out.errors[0]).toMatchObject({ code: "not-owner", category: "permission" });
    const [refused] = of("policy", "invocation");
    expect(refused).toMatchObject({ outcome: "denied", reason: "not-owner", callerRole: "gateway" });
    expect(refused).not.toHaveProperty("invocationId");
    expect(of("api", "gateway-invocation")[0]).toMatchObject({ outcome: "denied", reason: "not-owner", category: "permission" });
    expect(of("api", "gateway-invocation")[0]).not.toHaveProperty("invocationId");
  });

  it("reports a revocation between writes as partial, end to end, with prior effects", async () => {
    world.hooks.onRoute = async route => { if (route === "/itembank/questions") await world.grants.delete(grantIdFor({ connectionId: "conn-1", recipientUid: OTHER })); };
    const out = await compileAs(OTHER);
    expect(out.effects).toEqual([expect.objectContaining({ status: "partial", steps: ["questions"], failedStep: "items", reason: "authorization-denied:not-owner", category: "permission" })]);
    expect(of("policy", "authorize-execution").map(r => [r.step, r.outcome, r.reason])).toEqual([["questions", "allowed", undefined], ["items", "denied", "not-owner"]]);
    expect(of("broker", "execute").at(-1)).toMatchObject({ outcome: "partial", steps: ["questions"], failedStep: "items", category: "permission" });
    expect(world.providerCalls).toEqual(["/itembank/questions"]);
  });

  it("keeps uncertain with no completed step when the first response is lost", async () => {
    world.hooks.onRoute = async route => { if (route === "/itembank/questions") throw new Error("socket hang up"); };
    const out = await compileAs(OWNER);
    expect(out.effects).toEqual([expect.objectContaining({ status: "uncertain", steps: [], failedStep: "questions" })]);
    expect(of("broker", "execute").at(-1)).toMatchObject({ outcome: "uncertain", steps: [], failedStep: "questions" });
  });

  it("reports an authorization outage as unavailable, with nothing dispatched", async () => {
    world.program.brokerUrl = world.outageBrokerUrl;
    const out = await compileAs(OWNER);
    expect(out.effects).toEqual([expect.objectContaining({ status: "failed", steps: [], failedStep: "questions", reason: "authorization-unavailable", category: "unavailable" })]);
    expect(of("broker", "execute").at(-1)).toMatchObject({ outcome: "failed", reason: "authorization-unavailable", category: "unavailable" });
    expect(world.providerCalls).toEqual([]);
  });

  it("audits an artifact that couldn't be stored, with its category", async () => {
    const out = await compileAs(OWNER, { dataApi: world.makeDataApi({ artifactStorer: { put: async () => { throw new Error("down"); } } }) });
    expect(out.artifact).toMatchObject({ stored: false, error: "artifact-storage-unavailable", category: "unavailable" });
    expect(of("api", "artifact")[0]).toMatchObject({ outcome: "failed", reason: "artifact-storage-unavailable", category: "unavailable" });
  });
});

describe("AT-12: authentication and malformed requests over HTTP", () => {
  it("categorizes a missing or unregistered caller and a bad user token", async () => {
    const anonymous = await fetch(`${world.brokerUrl}/v1/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect([anonymous.status, /** @type {any} */ (await anonymous.json()).error.category]).toEqual([401, "authentication"]);
    const stranger = buildPolicyRequest({ policyUrl: world.policyUrl, idToken: idTokenFor(SA.stranger) });
    const res = await stranger("POST", "/v1/snapshot", { body: {} }).then(r => r, e => e);
    expect(res.reason ?? res.body?.error?.category).toBeDefined();
    const badUser = await world.asCompiler("POST", "/v1/snapshot", { authToken: "forged", body: { lang: "0176", connectionId: "conn-1", fns: ["init"], invocationToken: "x", stage: "s0" } });
    expect([badUser.status, badUser.body.error.category]).toEqual([401, "authentication"]);
  });

  it("categorizes a body the JSON parser rejects as malformed", async () => {
    const token = idTokenFor(SA.compiler);
    const res = await fetch(`${world.policyUrl}/v1/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Identity": await token("urn:graffiticode:policy"), "X-Serverless-Authorization": `Bearer ${await token(world.policyUrl)}` },
      body: `{ "lang": "${EMAIL}"`,
    });
    expect(/** @type {any} */ (await res.json()).error.category).toBe("malformed");
  });
});

describe("AT-12: publications and system previews", () => {
  it("traces a publication from its creation to a view, naming it only once it exists", async () => {
    await compileAs(OWNER);
    const [artifact] = of("api", "artifact");
    const created = await world.asGateway("POST", "/v1/publications", { authToken: `user:${OWNER}`, body: { connectionId: "conn-1", taskId: world.taskId, lang: "0176", artifactInvocationId: artifact.invocationId } });
    const { publicationId } = created.body.data;
    await world.asGateway("POST", `/v1/publications/${publicationId}/view`, { body: {} });
    expect(of("policy", "publication-create")).toEqual([expect.objectContaining({ outcome: "allowed", publicationId, callerRole: "gateway" })]);
    expect(of("policy", "publication-view")).toEqual([expect.objectContaining({ outcome: "allowed", publicationId })]);
    await world.asGateway("POST", `/v1/publications/pub-${EMAIL.replace(/[@.]/g, "-")}/view`, { body: {} }).catch(() => {});
    expect(of("policy", "publication-view").at(-1)).not.toHaveProperty("publicationId");
  });

  it("names a system preview's own session, with no gateway invocation", async () => {
    const session = await world.asCompiler("POST", "/v1/preview-session", { body: { lang: "0176" } });
    const mint = await world.asCompiler("POST", "/v1/mint", { body: { sessionToken: session.body.data.sessionToken, fn: "init", op: SIGN_OP, occurrenceId: "prog.0", argsDigest: argsDigest(PREVIEW) } });
    const out = await world.execute(world.brokerUrl, mint.body.data.executionToken, SIGN_OP, PREVIEW);
    expect(out.body.data.status).toBe("succeeded");
    const [preview] = of("policy", "preview-session");
    expect(preview.invocationId).toMatch(/^sys-/);
    expect(of("policy", "authorize-execution")[0]).toMatchObject({ step: "sign", provenance: "system", invocationId: preview.invocationId });
    expect(of("api", "gateway-invocation")).toEqual([]);
  });
});

describe("AT-12: sensitive markers where records copy request fields", () => {
  it("never records them, from any service", async () => {
    // Policy: op, step and purpose from a caller who isn't Broker; a bad
    // session's fn and op; an allocation's connection id.
    await world.asCompiler("POST", "/v1/authorize-execution", { body: { executionToken: "x", op: EMAIL, step: STIMULUS, purpose: SOURCE, argsDigest: "a".repeat(64) } }).catch(() => {});
    await world.asBroker("POST", "/v1/authorize-execution", { body: { executionToken: `eyJ${"x".repeat(20)}`, op: EMAIL, step: STIMULUS, purpose: SOURCE, argsDigest: "a".repeat(64) } }).catch(() => {});
    await world.asCompiler("POST", "/v1/mint", { body: { sessionToken: "bad", fn: EMAIL, op: STIMULUS, occurrenceId: "n1.0", argsDigest: "a".repeat(64) } }).catch(() => {});
    await world.asGateway("POST", "/v1/invocations", { authToken: `user:${OWNER}`, body: { connectionId: OWNER, taskId: SOURCE, inputDigest: "b".repeat(64), idempotencyKey: EMAIL } }).catch(() => {});
    // Broker: an op and a payload carrying the markers.
    await world.execute(world.brokerUrl, "not-a-token", EMAIL, { stimulus: STIMULUS, secret: SECRET });
    // api: an idempotency key it refuses outright (malformed), and one it
    // accepts but must never record.
    await expect(compileAs(OWNER, { idempotencyKey: `job-${EMAIL}` })).rejects.toThrow(/400.*malformed/);
    await compileAs(OWNER, { idempotencyKey: `job-${SOURCE}` });
    expect(records.length).toBeGreaterThan(5);
    const copied = records.filter(r => ["op", "fn", "step", "purpose", "connectionId"].some(f => r[f] === "invalid"));
    expect(copied.length).toBeGreaterThan(0);
    // (The redaction check after each test scans every record for the markers.)
  });
});
