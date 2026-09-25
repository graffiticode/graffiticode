/* eslint-disable camelcase -- Google ID-token and Learnosity wire fields */
import request from "supertest";
import { generateKeyPair, exportJWK } from "jose";
import {
  createPolicy,
  createCallerIdentity,
  createLocalSigner,
  createMemoryConnectionStore,
  createAudit,
  createPseudonymizer
} from "@graffiticode/policy";
import {
  createBroker,
  createBrokerApp,
  buildOperations,
  createMemoryOnceStore,
  createMemoryReceiptStore,
  createMemorySecretStore,
  argsDigest
} from "./index.js";

const OWNER = "0xowneruid";
const AUD = "urn:graffiticode:broker";
const SA = { l0176: "l0176-run@x.iam.gserviceaccount.com", l0000: "l0000-run@x.iam.gserviceaccount.com" };
const PREVIEW = { id: "t", questions: [{ response_id: "q-0", type: "mcq" }] };

const verifyIdToken = async (token, audience) => {
  const [kind, email, aud] = token.split("|");
  if (kind !== "idt" || aud !== audience) throw new Error("bad token");
  return { email, email_verified: true };
};
const forwarded = email =>
  `Bearer e30.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.`;

let app;
let executionToken;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const audit = createAudit({ sink: () => {}, pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
  const policy = createPolicy({
    signer,
    jwks,
    audit,
    connections: createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }])
  });
  const caller = { role: "compiler", lang: "0176" };
  const { sessionToken } = await policy.snapshot({
    caller,
    user: { uid: OWNER },
    lang: "0176",
    connectionId: "conn-1",
    fns: ["preview-itembank"],
    mode: "render",
    invocationId: "inv-1"
  });
  ({ executionToken } = await policy.mint({
    caller,
    sessionToken,
    fn: "preview-itembank",
    op: "learnosity.sign-questions-preview",
    occurrenceId: "prog",
    argsDigest: argsDigest(PREVIEW)
  }));
  const broker = createBroker({
    jwks,
    audit,
    operations: buildOperations({ sdk: { init: (service) => ({ service }) }, domain: "d", dataApi: async () => ({}) }),
    secrets: createMemorySecretStore({ "conn-1": { key: "k", secret: "s" } }),
    once: createMemoryOnceStore(),
    receipts: createMemoryReceiptStore()
  });
  const identifyCaller = createCallerIdentity({
    verifyIdToken,
    audience: AUD,
    callers: { [SA.l0176]: { role: "compiler", lang: "0176" }, [SA.l0000]: { role: "compiler", lang: "0000" } }
  });
  app = createBrokerApp({ broker, identifyCaller, audit });
});

const exec = (email, { token = executionToken, identity = `idt|${email}|${AUD}` } = {}) =>
  request(app).post("/v1/execute")
    .set("X-Caller-Identity", identity)
    .set("X-Serverless-Authorization", forwarded(email))
    .set("Authorization", `Bearer ${token}`)
    .send({ op: "learnosity.sign-questions-preview", payload: PREVIEW });

describe("broker http", () => {
  it("executes for the compiler of the token's language", async () => {
    const res = await exec(SA.l0176);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "succeeded", result: { request: { service: "questions" } } });
  });

  it("refuses the token when spent by another language's compiler", async () => {
    const res = await exec(SA.l0000);
    expect(res.status).toBe(403);
    expect(res.body.error.reason).toBe("caller-language-mismatch");
    expect(JSON.stringify(res.body)).not.toContain(executionToken);
  });

  it("refuses a caller identity minted for policy rather than the broker", async () => {
    const res = await exec(SA.l0176, { identity: `idt|${SA.l0176}|urn:graffiticode:policy` });
    expect(res.status).toBe(401);
  });

  it("refuses a request with no execution token", async () => {
    const res = await request(app).post("/v1/execute")
      .set("X-Caller-Identity", `idt|${SA.l0176}|${AUD}`)
      .set("X-Serverless-Authorization", forwarded(SA.l0176))
      .send({ op: "learnosity.sign-questions-preview", payload: PREVIEW });
    expect(res.status).toBe(401);
  });

  it("refuses a replay over http", async () => {
    await exec(SA.l0176);
    const res = await exec(SA.l0176);
    expect(res.status).toBe(409);
    expect(res.body.error.reason).toBe("token-replayed");
  });
});
