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
  createAudit,
  createPseudonymizer
} from "./index.js";

const OWNER = "0xowneruid";
const AUD = "urn:graffiticode:policy";
const SA = {
  l0176: "l0176-run@graffiticode.iam.gserviceaccount.com",
  l0000: "l0000-run@graffiticode.iam.gserviceaccount.com",
  console: "console-run@graffiticode-app.iam.gserviceaccount.com",
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

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const publicJwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  records = [];
  const audit = createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
  const connections = createMemoryConnectionStore([
    { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }
  ]);
  const policy = createPolicy({ signer, jwks: publicJwks, connections, audit });
  const identifyCaller = createCallerIdentity({
    verifyIdToken,
    audience: AUD,
    callers: {
      [SA.l0176]: { role: "compiler", lang: "0176" },
      [SA.l0000]: { role: "compiler", lang: "0000" },
      [SA.console]: { role: "console" }
    }
  });
  brokerSecrets = new Map();
  const manager = createConnectionManager({
    connections,
    audit,
    brokerAdmin: {
      putSecret: async (id, cred) => { brokerSecrets.set(id, cred); },
      deleteSecret: async id => { brokerSecrets.delete(id); }
    }
  });
  app = createPolicyApp({ policy, manager, identifyCaller, verifyUser, publicJwks, audit });
});

const as = (req, email, { identity = idt(email), invoker = email, user = `user:${OWNER}` } = {}) => {
  let r = req.set("X-Caller-Identity", identity).set("X-Serverless-Authorization", forwarded(invoker));
  if (user) r = r.set("Authorization", `Bearer ${user}`);
  return r;
};

const SNAPSHOT = { lang: "0176", connectionId: "conn-1", fns: ["preview-itembank", "save-to-itembank"], invocationId: "inv-1" };

describe("caller identity", () => {
  it("admits a known compiler whose verified identity matches the invoker", async () => {
    const res = await as(request(app).post("/v1/snapshot"), SA.l0176).send(SNAPSHOT);
    expect(res.status).toBe(200);
    expect(res.body.data.allowed).toEqual(["preview-itembank"]);
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

  it("refuses a compiler on the intent route", async () => {
    const res = await as(request(app).post("/v1/intents"), SA.l0176).send({ mode: "save", connectionId: "conn-1" });
    expect(res.status).toBe(403);
    expect(records.some(r => r.reason === "route-not-allowed-for-caller")).toBe(true);
  });

  it("binds a compiler to its own language", async () => {
    const res = await as(request(app).post("/v1/snapshot"), SA.l0000).send(SNAPSHOT);
    expect(res.status).toBe(403);
    expect(res.body.error.reason).toBe("caller-language-mismatch");
  });
});

describe("end to end: intent, snapshot, mint", () => {
  it("lets the console's save intent carry a compiler's session to a write token", async () => {
    const intent = await as(request(app).post("/v1/intents"), SA.console).send({ mode: "save", connectionId: "conn-1" });
    expect(intent.status).toBe(200);
    const snap = await as(request(app).post("/v1/snapshot"), SA.l0176).send({ ...SNAPSHOT, intentToken: intent.body.data.intentToken });
    expect(snap.body.data.allowed).toEqual(["preview-itembank", "save-to-itembank"]);
    const mint = await as(request(app).post("/v1/mint"), SA.l0176, { user: null }).send({
      sessionToken: snap.body.data.sessionToken,
      fn: "save-to-itembank",
      op: "learnosity.write-items",
      occurrenceId: "n1.0",
      argsDigest: "a".repeat(64)
    });
    expect(mint.status).toBe(200);
    expect(mint.body.data.operationId).toBe(`${intent.body.data.saveActionId}/n1.0`);
  });

  it("refuses a compiler claiming save mode without an intent", async () => {
    const res = await as(request(app).post("/v1/snapshot"), SA.l0176).send({ ...SNAPSHOT, mode: "save" });
    expect(res.status).toBe(403);
    expect(res.body.error.reason).toBe("privileged-mode-without-intent");
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
    expect(brokerSecrets.get(connectionId)).toEqual(CRED);

    const listed = await as(request(app).get("/v1/connections"), SA.console);
    expect(listed.body.data.map(c => c.connectionId)).toContain(connectionId);

    const snap = await as(request(app).post("/v1/snapshot"), SA.l0176).send({ ...SNAPSHOT, connectionId });
    expect(snap.body.data.allowed).toEqual(["preview-itembank"]);

    expect((await as(request(app).post(`/v1/connections/${connectionId}/disable`), SA.console).send()).status).toBe(200);
    const after = await as(request(app).post("/v1/snapshot"), SA.l0176).send({ ...SNAPSHOT, connectionId });
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
