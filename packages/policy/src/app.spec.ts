/* eslint-disable camelcase -- Google ID-token and Learnosity wire fields */
import request from "supertest";
import { generateKeyPair, exportJWK } from "jose";
import {
  createPolicy,
  createPolicyApp,
  createConnectionManager,
  createCallerIdentity,
  createLocalSigner,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryPublicationStore,
  createMemoryGrantStore,
  createAudit,
  createPseudonymizer,
  createProtectedSwitch
} from "./index.js";

const OWNER = "0xowneruid";
const AUD = "urn:graffiticode:policy";
const SA = {
  l0176: "l0176-run@graffiticode.iam.gserviceaccount.com",
  l0000: "l0000-run@graffiticode.iam.gserviceaccount.com",
  console: "console-run@graffiticode-app.iam.gserviceaccount.com",
  gateway: "api-run@graffiticode.iam.gserviceaccount.com",
  broker: "broker-run@graffiticode.iam.gserviceaccount.com",
  stranger: "stranger@example.iam.gserviceaccount.com"
};

// Stand-ins for Google's ID-token verification and the auth service.
// "idt|<email>|<audience>" verifies for that audience; anything else fails.
const verifyIdToken = async (token, audience) => {
  const [kind, email, aud] = token.split("|");
  if (kind !== "idt" || aud !== audience) throw new Error("bad token");
  return { iss: "https://accounts.google.com", email, email_verified: true, aud };
};
const idt = (email, aud = AUD) => `idt|${email}|${aud}`;
// What Cloud Run forwards: the invoker token with its signature stripped.
const forwarded = email =>
  `Bearer ${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.`;
const verifyUser = async token => {
  if (!token.startsWith("user:")) throw new Error("bad user token");
  return { uid: token.slice(5) };
};

let app;
let records;
let brokerSecrets;
let SNAPSHOT;
let grants;
let protectedEnabled;

beforeEach(async () => {
  protectedEnabled = true;
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const publicJwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  records = [];
  const audit = createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
  grants = createMemoryGrantStore();
  const connections = createMemoryConnectionStore([
    { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" },
    { connectionId: "conn-sys", ownerUid: "0xgraffiticode", backend: "learnosity", status: "active" }
  ]);
  const policy = createPolicy({
    protectedSwitch: createProtectedSwitch({ cacheMs: 0, readFlag: async () => ({ enabled: protectedEnabled }) }),
    signer,
    jwks: publicJwks,
    connections,
    invocations: createMemoryInvocationStore(),
    publications: createMemoryPublicationStore(),
    grants,
    systemConnections: { learnosity: "conn-sys" },
    audit
  });
  const identifyCaller = createCallerIdentity({
    verifyIdToken,
    audience: AUD,
    callers: {
      [SA.l0176]: { role: "compiler", lang: "0176" },
      [SA.l0000]: { role: "compiler", lang: "0000" },
      [SA.console]: { role: "console" },
      [SA.gateway]: { role: "gateway" },
      [SA.broker]: { role: "broker" }
    }
  });
  brokerSecrets = new Map();
  const manager = createConnectionManager({
    connections,
    grants,
    audit,
    brokerAdmin: {
      createSecret: async (id, cred) => { brokerSecrets.set(id, cred); },
      rotateSecret: async (id, cred) => { brokerSecrets.set(id, cred); },
      deleteSecret: async id => { brokerSecrets.delete(id); }
    }
  });
  app = createPolicyApp({ policy, manager, identifyCaller, verifyUser, publicJwks, audit });
  SNAPSHOT = await snapshotBody("conn-1");
});

const as = (req, email, { identity = idt(email), invoker = email, user = `user:${OWNER}` } = {}) => {
  let r = req.set("X-Caller-Identity", identity).set("X-Serverless-Authorization", forwarded(invoker));
  if (user) r = r.set("Authorization", `Bearer ${user}`);
  return r;
};

const invocation = (connectionId, extra = {}) =>
  as(request(app).post("/v1/invocations"), SA.gateway).send({ connectionId, taskId: "task-1", inputDigest: "b".repeat(64), ...extra });
const snapshotBody = async connectionId => ({
  lang: "0176",
  connectionId,
  fns: ["init", "save-to-itembank"],
  invocationToken: (await invocation(connectionId)).body.data?.invocationToken,
  stage: "s0"
});

describe("invocations over http", () => {
  it("are allocated for the gateway only, and reused by idempotency key", async () => {
    const first = await invocation("conn-1", { idempotencyKey: "job-1" });
    expect(first.status).toBe(200);
    const retry = await invocation("conn-1", { idempotencyKey: "job-1" });
    expect(retry.body.data).toMatchObject({ invocationId: first.body.data.invocationId, reused: true });
    const denied = await as(request(app).post("/v1/invocations"), SA.console).send({ connectionId: "conn-1", taskId: "t", inputDigest: "b".repeat(64) });
    expect(denied.status).toBe(403);
    const compiler = await as(request(app).post("/v1/invocations"), SA.l0176).send({ connectionId: "conn-1", taskId: "t", inputDigest: "b".repeat(64) });
    expect(compiler.status).toBe(403);
  });
});

// Chain admission over HTTP (W4 PR 2): the marker, the plan lookup and
// admissions are the gateway's, and a snapshot carries its admission token.
describe("chain admission over http", () => {
  it("marks an invocation for admission, and keeps its plan lookup and admissions to the gateway", async () => {
    const marked = await invocation("conn-1", { idempotencyKey: "job-w4", admission: true });
    expect(marked.body.data).toMatchObject({ contract: 2, planDigest: null });
    const { invocationToken } = marked.body.data;
    const lookup = await as(request(app).post("/v1/invocations/plan"), SA.gateway).send({ invocationToken });
    expect(lookup.status).toBe(200);
    expect(lookup.headers["cache-control"]).toBe("no-store");
    expect(lookup.body.data).toEqual({ contract: 2, plan: null });
    for (const route of ["/v1/invocations/plan", "/v1/admissions"]) {
      const compiler = await as(request(app).post(route), SA.l0176).send({ invocationToken });
      expect(compiler.status).toBe(403);
    }
    // This Policy has no approvals store: admission is refused, not guessed.
    const admitted = await as(request(app).post("/v1/admissions"), SA.gateway).send({ invocationToken, taskIds: ["task-1"], stages: [] });
    expect(admitted.body.error).toMatchObject({ reason: "unavailable", category: "unavailable" });
  });

  it("refuses a marked invocation's snapshot without its plan, or with a forged admission token", async () => {
    const { invocationToken } = (await invocation("conn-1", { idempotencyKey: "job-w4b", admission: true })).body.data;
    const unbound = await as(request(app).post("/v1/snapshot"), SA.l0176).send({ ...SNAPSHOT, invocationToken });
    expect(unbound.body.error).toMatchObject({ reason: "plan-required", category: "conflict" });
    const forged = await as(request(app).post("/v1/snapshot"), SA.l0176).send({ ...SNAPSHOT, invocationToken, admissionToken: "x.y.z", manifest: {} });
    expect(forged.body.error).toMatchObject({ reason: "bad-token", category: "authentication" });
  });
});

describe("sharing over http", () => {
  it("lets the owner share, list and revoke, and the recipient see it", async () => {
    const shared = await as(request(app).post("/v1/connections/conn-1/grants"), SA.console).send({ recipientUid: "0xalice", recipientLabel: "alice@example.com", permissions: [{ lang: "0176", fn: "save-to-itembank" }] });
    expect(shared.status).toBe(200);
    const list = await as(request(app).get("/v1/connections/conn-1/grants"), SA.console);
    expect(list.body.data).toEqual([expect.objectContaining({ recipientLabel: "alice@example.com", pending: false })]);
    const mine = await as(request(app).get("/v1/shared"), SA.console, { user: "user:0xalice" });
    expect(mine.body.data).toEqual([expect.objectContaining({ connectionId: "conn-1", permissions: [{ lang: "0176", fn: "save-to-itembank" }] })]);
    const reshare = await as(request(app).post("/v1/connections/conn-1/grants"), SA.console, { user: "user:0xalice" }).send({ recipientUid: "0xbob", permissions: [{ lang: "0176", fn: "save-to-itembank" }] });
    expect(reshare.body.error.reason).toBe("not-owner");
    const revoked = await as(request(app).delete(`/v1/connections/conn-1/grants/${shared.body.data.grantId}`), SA.console);
    expect(revoked.status).toBe(200);
    expect((await as(request(app).get("/v1/shared"), SA.console, { user: "user:0xalice" })).body.data).toEqual([]);
  });

  it("refuses compilers on the sharing routes", async () => {
    const res = await as(request(app).post("/v1/connections/conn-1/grants"), SA.l0176).send({ recipientUid: "0xalice", permissions: [{ lang: "0176", fn: "save-to-itembank" }] });
    expect(res.status).toBe(403);
  });
});

describe("publications over http", () => {
  it("lets the gateway publish for the owner, and a compiler snapshot a view with no user", async () => {
    const created = await as(request(app).post("/v1/publications"), SA.gateway)
      .send({ connectionId: "conn-1", taskId: "task-1", lang: "0176", artifactInvocationId: "inv-run" });
    expect(created.status).toBe(200);
    const { publicationId } = created.body.data;

    const view = await as(request(app).post(`/v1/publications/${publicationId}/view`), SA.gateway, { user: null }).send();
    expect(view.status).toBe(200);
    const snap = await as(request(app).post("/v1/snapshot"), SA.l0176, { user: null }).send({
      lang: "0176", connectionId: "conn-1", fns: ["init", "save-to-itembank"], invocationToken: view.body.data.invocationToken, stage: "view"
    });
    expect(snap.status).toBe(200);
    expect(snap.body.data.allowed).toEqual(["init"]);

    expect((await as(request(app).delete(`/v1/publications/${publicationId}`), SA.gateway)).status).toBe(200);
    const after = await as(request(app).post(`/v1/publications/${publicationId}/view`), SA.gateway, { user: null }).send();
    expect(after.body.error.reason).toBe("publication-not-found");
  });

  it("refuses anyone but the gateway", async () => {
    const res = await as(request(app).post("/v1/publications"), SA.console)
      .send({ connectionId: "conn-1", taskId: "task-1", lang: "0176", artifactInvocationId: "inv-run" });
    expect(res.status).toBe(403);
  });
});

describe("system preview sessions over http", () => {
  it("give a compiler, with no user, a session that mints preview signing and nothing else", async () => {
    const res = await as(request(app).post("/v1/preview-session"), SA.l0176, { user: null }).send({ lang: "0176" });
    expect(res.status).toBe(200);
    expect(res.body.data.allowed).toEqual(["init"]);
    const mint = body => as(request(app).post("/v1/mint"), SA.l0176, { user: null })
      .send({ sessionToken: res.body.data.sessionToken, occurrenceId: "prog.0", argsDigest: "a".repeat(64), ...body });
    expect((await mint({ fn: "init", op: "learnosity.sign-questions-preview" })).status).toBe(200);
    const write = await mint({ fn: "save-to-itembank", op: "learnosity.write-items" });
    expect(write.status).toBe(403);
    expect(write.body.error.reason).toBe("fn-not-in-session");
  });

  it("refuse the console, the gateway, and another language's compiler", async () => {
    expect((await as(request(app).post("/v1/preview-session"), SA.console).send({ lang: "0176" })).status).toBe(403);
    expect((await as(request(app).post("/v1/preview-session"), SA.gateway).send({ lang: "0176" })).status).toBe(403);
    const other = await as(request(app).post("/v1/preview-session"), SA.l0000, { user: null }).send({ lang: "0176" });
    expect(other.status).toBe(403);
    expect(other.body.error.reason).toBe("caller-language-mismatch");
  });

  it("refuse a missing caller identity", async () => {
    expect((await request(app).post("/v1/preview-session").send({ lang: "0176" })).status).toBe(401);
  });
});

describe("caller identity", () => {
  it("admits a known compiler whose verified identity matches the invoker", async () => {
    const res = await as(request(app).post("/v1/snapshot"), SA.l0176).send(SNAPSHOT);
    expect(res.status).toBe(200);
    expect(res.body.data.allowed).toEqual(["init", "save-to-itembank"]);
  });

  it("refuses a missing caller identity", async () => {
    const res = await request(app).post("/v1/snapshot").set("Authorization", `Bearer user:${OWNER}`).send(SNAPSHOT);
    expect(res.status).toBe(401);
  });

  it("refuses a caller token for another audience", async () => {
    const res = await as(request(app).post("/v1/snapshot"), SA.l0176, { identity: idt(SA.l0176, "urn:graffiticode:broker") }).send(SNAPSHOT);
    expect(res.status).toBe(401);
  });

  it("refuses an unsigned, crafted caller identity", async () => {
    const crafted = forwarded(SA.l0176).replace("Bearer ", "");
    const res = await as(request(app).post("/v1/snapshot"), SA.l0176, { identity: crafted }).send(SNAPSHOT);
    expect(res.status).toBe(401);
  });

  it("refuses a caller identity that differs from the invoker", async () => {
    const res = await as(request(app).post("/v1/snapshot"), SA.l0176, { invoker: SA.l0000 }).send(SNAPSHOT);
    expect(res.status).toBe(403);
  });

  it("refuses an unknown service account", async () => {
    const res = await as(request(app).post("/v1/snapshot"), SA.stranger).send(SNAPSHOT);
    expect(res.status).toBe(403);
  });
});

describe("route authorization by caller", () => {
  it("refuses the console on compiler routes", async () => {
    expect((await as(request(app).post("/v1/snapshot"), SA.console).send(SNAPSHOT)).status).toBe(403);
    expect((await as(request(app).post("/v1/mint"), SA.console).send({})).status).toBe(403);
  });

  it("refuses a compiler on the gateway's routes", async () => {
    const res = await as(request(app).post("/v1/invocations"), SA.l0176).send({ connectionId: "conn-1" });
    expect(res.status).toBe(403);
    expect(records.some(r => r.reason === "route-not-allowed-for-caller")).toBe(true);
  });

  it("has no intent route", async () => {
    const res = await as(request(app).post("/v1/intents"), SA.console).send({ mode: "save", connectionId: "conn-1" });
    expect(res.status).toBe(404);
  });

  it("binds a compiler to its own language", async () => {
    const res = await as(request(app).post("/v1/snapshot"), SA.l0000).send(SNAPSHOT);
    expect(res.status).toBe(403);
    expect(res.body.error.reason).toBe("caller-language-mismatch");
  });
});

describe("end to end: invocation, snapshot, mint", () => {
  it("lets a compiler's session for the owner mint a write token, with no intent", async () => {
    const snap = await as(request(app).post("/v1/snapshot"), SA.l0176).send(SNAPSHOT);
    expect(snap.body.data.allowed).toEqual(["init", "save-to-itembank"]);
    const mint = await as(request(app).post("/v1/mint"), SA.l0176, { user: null }).send({
      sessionToken: snap.body.data.sessionToken,
      fn: "save-to-itembank",
      op: "learnosity.write-items",
      occurrenceId: "n1.0",
      argsDigest: "a".repeat(64)
    });
    expect(mint.status).toBe(200);
    expect(mint.body.data.operationId).toMatch(/^inv-[0-9a-f-]+\/s0\/n1\.0$/);
  });

  it("lets only Broker ask authorize-execution, and never caches the decision", async () => {
    const snap = await as(request(app).post("/v1/snapshot"), SA.l0176).send(SNAPSHOT);
    const mint = await as(request(app).post("/v1/mint"), SA.l0176, { user: null }).send({
      sessionToken: snap.body.data.sessionToken, fn: "init", op: "learnosity.sign-items-preview", occurrenceId: "n1.0", argsDigest: "a".repeat(64)
    });
    const body = { executionToken: mint.body.data.executionToken, op: "learnosity.sign-items-preview", argsDigest: "a".repeat(64), step: "sign", purpose: "sign", after: null };
    const asked = await as(request(app).post("/v1/authorize-execution"), SA.broker, { user: null }).send(body);
    expect(asked.status).toBe(200);
    expect(asked.body.data.decisionId).toEqual(expect.any(String));
    expect(asked.headers["cache-control"]).toBe("no-store");
    for (const other of [SA.l0176, SA.console, SA.gateway]) {
      const res = await as(request(app).post("/v1/authorize-execution"), other, { user: null }).send(body);
      expect(res.status).toBe(403);
    }
    // Broker reaches nothing else: not mint, not the connection routes.
    expect((await as(request(app).post("/v1/mint"), SA.broker, { user: null }).send({})).status).toBe(403);
    expect((await as(request(app).get("/v1/connections"), SA.broker).send()).status).toBe(403);
    const refused = await as(request(app).post("/v1/authorize-execution"), SA.broker, { user: null }).send({ ...body, argsDigest: "b".repeat(64) });
    expect(refused.status).toBe(403);
    expect(refused.body.error.reason).toBe("args-mismatch");
  });

  it("requires a verified user", async () => {
    const res = await as(request(app).post("/v1/snapshot"), SA.l0176, { user: "forged" }).send(SNAPSHOT);
    expect(res.status).toBe(401);
  });

  it("publishes the verification keys", async () => {
    const res = await request(app).get("/v1/jwks");
    expect(res.body.keys[0]).toMatchObject({ kid: "k1", alg: "ES256" });
    expect(res.body.keys[0].d).toBeUndefined();
  });
});

describe("connection management over http", () => {
  const CRED = { key: "consumer-key", secret: "super-secret-value" };

  it("lets the console create, list, use, disable and delete a user's connection", async () => {
    const created = await as(request(app).post("/v1/connections"), SA.console).send({ backend: "learnosity", label: "Mine", credential: CRED });
    expect(created.status).toBe(200);
    const { connectionId } = created.body.data;
    expect(JSON.stringify(created.body)).not.toContain(CRED.secret);
    expect(brokerSecrets.get(connectionId)).toMatchObject({ backend: "learnosity", ...CRED });

    const listed = await as(request(app).get("/v1/connections"), SA.console);
    expect(listed.body.data.map(c => c.connectionId)).toContain(connectionId);

    const body = await snapshotBody(connectionId);
    const snap = await as(request(app).post("/v1/snapshot"), SA.l0176).send(body);
    expect(snap.body.data.allowed).toEqual(["init", "save-to-itembank"]);

    expect((await as(request(app).post(`/v1/connections/${connectionId}/disable`), SA.console).send()).status).toBe(200);
    const after = await as(request(app).post("/v1/snapshot"), SA.l0176).send(body);
    expect(after.body.error.reason).toBe("connection-disabled");

    expect((await as(request(app).delete(`/v1/connections/${connectionId}`), SA.console)).status).toBe(200);
    expect(brokerSecrets.has(connectionId)).toBe(false);
  });

  it("refuses compilers on management routes", async () => {
    const res = await as(request(app).post("/v1/connections"), SA.l0176).send({ backend: "learnosity", credential: CRED });
    expect(res.status).toBe(403);
    expect(brokerSecrets.size).toBe(0);
  });

  it("refuses another user's connection", async () => {
    const res = await as(request(app).post("/v1/connections/conn-1/rotate"), SA.console, { user: "user:0xsomeoneelse" }).send({ credential: CRED });
    expect(res.status).toBe(403);
    expect(res.body.error.reason).toBe("not-owner");
  });
});

// Every error body carries its failure category (common/failures, spec
// FAIL-01); statuses and reasons are unchanged.
describe("failure categories over http", () => {
  it("classifies denials, maintenance and the generic paths, keeping each status and reason", async () => {
    const denied = await as(request(app).post("/v1/snapshot"), SA.l0000).send(SNAPSHOT);
    expect([denied.status, denied.body.error.reason, denied.body.error.category]).toEqual([403, "caller-language-mismatch", "permission"]);
    // Caller authentication (no identity) and route permission, on the generic path.
    const anonymous = await request(app).post("/v1/snapshot").send(SNAPSHOT);
    expect([anonymous.status, anonymous.body.error.category]).toEqual([401, "authentication"]);
    const wrongRoute = await as(request(app).post("/v1/invocations"), SA.l0176).send({ connectionId: "conn-1" });
    expect([wrongRoute.status, wrongRoute.body.error.category]).toEqual([403, "permission"]);
    // A user token that doesn't verify.
    const forged = await as(request(app).post("/v1/snapshot"), SA.l0176, { user: "forged" }).send(SNAPSHOT);
    expect([forged.status, forged.body.error.category]).toEqual([401, "authentication"]);
    protectedEnabled = false;
    const paused = await as(request(app).post("/v1/preview-session"), SA.l0176, { user: null }).send({ lang: "0176" });
    expect([paused.status, paused.body.error.reason, paused.body.error.category]).toEqual([503, "maintenance", "unavailable"]);
  });

  it("classifies a body the JSON parser rejects as malformed, keeping its status", async () => {
    const res = await as(request(app).post("/v1/snapshot"), SA.l0176).set("Content-Type", "application/json").send("{ not json");
    expect(res.status).toBe(500);
    expect(res.body.error.category).toBe("malformed");
  });
});

describe("request correlation over http (spec AUDIT-01)", () => {
  it("names each request's records with its own server-generated id", async () => {
    records.length = 0;
    await invocation("conn-1");
    const first = records.map(r => r.requestId);
    expect(first.length).toBeGreaterThan(0);
    expect(new Set(first).size).toBe(1);
    expect(first[0]).toMatch(/^[0-9a-f-]{36}$/);
    records.length = 0;
    await invocation("conn-1");
    expect(records[0].requestId).not.toBe(first[0]);
  });

  it("names a refusal before the caller is verified with the request id alone", async () => {
    records.length = 0;
    await request(app).post("/v1/snapshot").set("X-Request-Id", "client-chosen").send(SNAPSHOT);
    const [record] = records;
    expect(record).toMatchObject({ outcome: "denied", reason: "caller-rejected" });
    expect(record.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(record).not.toHaveProperty("callerRole");
    expect(JSON.stringify(records)).not.toContain("client-chosen");
  });
});

describe("maintenance over http", () => {
  it("answers 503 maintenance for protected routes while switched off, and reports the state", async () => {
    expect((await request(app).get("/v1/protected-execution")).body).toEqual({ enabled: true, source: "flag" });
    protectedEnabled = false;
    const res = await as(request(app).post("/v1/preview-session"), SA.l0176, { user: null }).send({ lang: "0176" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 503, reason: "maintenance" });
    const snap = await as(request(app).post("/v1/snapshot"), SA.l0176).send(SNAPSHOT);
    expect(snap.status).toBe(503);
    expect((await request(app).get("/v1/protected-execution")).body).toEqual({ enabled: false, source: "flag" });
    // Invocations are still allocated; they authorize nothing by themselves.
    expect((await invocation("conn-1")).status).toBe(200);
  });
});
