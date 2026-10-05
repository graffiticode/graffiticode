// authorize-execution's own checks (W2 PR 3, spec API-02): broker-only, the
// execution token, a fresh switch read, the request's binding to the token,
// provenance whatever the token schema tolerates, and the registered step.
// Its live-state checks are mint's, compared row by row in live.spec.ts.
import { generateKeyPair, exportJWK, importJWK, SignJWT } from "jose";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import {
  createPolicy,
  PolicyDenied,
  PolicyMaintenance,
  createLocalSigner,
  issueToken,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryPublicationStore,
  createMemoryGrantStore,
  grantIdFor,
  createAudit,
  createPseudonymizer,
  createProtectedSwitch,
  ISSUER
} from "./index.js";

const OWNER = "0xowneruid";
const OTHER = "0xotheruid";
const CANARY = "0xcanaryuid";
const BROKER = { role: "broker" };
const L0176 = { role: "compiler", lang: "0176" };
const ARGD = "a".repeat(64);
const PREVIEW = "learnosity.sign-items-preview";
const WRITE = "learnosity.write-items";

let signer;
let privateJwk;
let policy;
let records;
let flag;
let flagReads;
let grants;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateJwk = await exportJWK(pair.privateKey);
  signer = await createLocalSigner({ privateJwk, kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  flag = { enabled: true };
  flagReads = 0;
  records = [];
  grants = createMemoryGrantStore([{
    grantId: grantIdFor({ connectionId: "conn-1", recipientUid: OTHER }),
    connectionId: "conn-1",
    ownerUid: OWNER,
    recipientUid: OTHER,
    permissions: [{ lang: "0176", fn: "init" }, { lang: "0176", fn: "save-to-itembank" }],
    expiresAt: null,
  }]);
  policy = createPolicy({
    // A long cache, so any read past it shows up as a fresh one.
    protectedSwitch: createProtectedSwitch({ cacheMs: 60_000, readFlag: async () => { flagReads++; return { ...flag }; } }),
    signer,
    jwks,
    connections: createMemoryConnectionStore([
      { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" },
      { connectionId: "conn-canary", ownerUid: CANARY, backend: "learnosity", status: "active" },
    ]),
    grants,
    publications: createMemoryPublicationStore(),
    invocations: createMemoryInvocationStore(),
    audit: createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) }),
  });
});

const EXEC = {
  sub: OWNER,
  own: OWNER,
  conn: "conn-1",
  backend: "learnosity",
  lang: "0176",
  fn: "init",
  op: PREVIEW,
  sid: "sid-1",
  opid: "inv-1/s0/n1.0",
  argd: ARGD,
  rv: REGISTRY_VERSION,
  prv: "user",
};
const WRITE_EXEC = { ...EXEC, fn: "save-to-itembank", op: WRITE };
const token = (over = {}) => issueToken(signer, "execution", { ...EXEC, ...over });
// The request Broker makes before signing a preview; `over` changes any field.
const ask = async (over: Record<string, unknown> = {}) => policy.authorizeExecution({
  caller: BROKER,
  executionToken: await token(),
  op: PREVIEW,
  argsDigest: ARGD,
  step: "sign",
  purpose: "sign",
  after: null,
  ...over,
});
const denied = async (promise, reason) => {
  await expect(promise).rejects.toBeInstanceOf(PolicyDenied);
  await expect(promise).rejects.toMatchObject({ reason });
};

describe("authorize-execution", () => {
  it("returns a fresh, audited decision for one step", async () => {
    const first = await ask();
    const second = await ask();
    expect(first.decisionId).toEqual(expect.any(String));
    expect(second.decisionId).not.toBe(first.decisionId);
    const record = records.at(-1);
    expect(record).toMatchObject({
      event: "authorize-execution",
      outcome: "allowed",
      decisionId: second.decisionId,
      op: PREVIEW,
      step: "sign",
      purpose: "sign",
      provenance: "user",
      opid: "inv-1/s0/n1.0",
      jti: expect.any(String),
    });
    expect(record).not.toHaveProperty("uid");
  });

  it("answers only Broker", async () => {
    await denied(ask({ caller: L0176 }), "caller-not-broker");
    await denied(ask({ caller: { role: "console" } }), "caller-not-broker");
    await denied(ask({ caller: undefined }), "caller-not-broker");
  });

  it("refuses a bad or expired token, and a token of another profile", async () => {
    await denied(ask({ executionToken: "not-a-token" }), "bad-token");
    const session = await issueToken(signer, "session", { sub: OWNER, own: OWNER, conn: "conn-1", backend: "learnosity", lang: "0176", inv: "inv-1", stg: "s0", rv: REGISTRY_VERSION, fns: ["init"] });
    await denied(ask({ executionToken: session }), "bad-token");
    // Signed by another key under the same kid.
    const forger = await createLocalSigner({ privateJwk: await exportJWK((await generateKeyPair("ES256", { extractable: true })).privateKey), kid: "k1" });
    await denied(ask({ executionToken: await issueToken(forger, "execution", EXEC) }), "bad-token");
    // The right key, issued an hour ago: its 60 s lifetime is long over.
    const anHourAgo = await createLocalSigner({ privateJwk, kid: "k1", now: () => Math.floor(Date.now() / 1000) - 3600 });
    await denied(ask({ executionToken: await issueToken(anHourAgo, "execution", EXEC) }), "token-expired");
  });

  it("reads the switch fresh on every call, past its cache", async () => {
    await ask();
    await ask();
    expect(flagReads).toBe(2);
    flag = { enabled: false };
    await expect(ask()).rejects.toBeInstanceOf(PolicyMaintenance);
    expect(records.at(-1)).toMatchObject({ event: "authorize-execution", outcome: "denied", reason: "maintenance" });
  });

  it("admits the canary while paused, with every other check intact", async () => {
    flag = { enabled: false, canary: { uid: CANARY, connectionId: "conn-canary" } };
    const executionToken = await token({ sub: CANARY, own: CANARY, conn: "conn-canary" });
    await expect(ask({ executionToken })).resolves.toEqual({ decisionId: expect.any(String) });
    expect(records.some(r => r.reason === "canary-during-maintenance")).toBe(true);
    await denied(ask({ executionToken, argsDigest: "b".repeat(64) }), "args-mismatch");
  });

  it("binds the request to the token: operation, arguments, registry and the function's operation", async () => {
    await denied(ask({ op: WRITE }), "operation-mismatch");
    await denied(ask({ argsDigest: "b".repeat(64) }), "args-mismatch");
    await denied(ask({ executionToken: await token({ rv: REGISTRY_VERSION - 1 }) }), "registry-version-changed");
    await denied(ask({ executionToken: await token({ op: WRITE }), op: WRITE, step: "questions", purpose: "dispatch" }), "operation-not-allowed");
  });

  it("refuses invalid provenance, and a token without any", async () => {
    await denied(ask({ executionToken: await token({ prv: "admin" }) }), "bad-provenance");
    await denied(ask({ executionToken: await token({ prv: "publication" }) }), "bad-provenance");
    await denied(ask({ executionToken: await token({ pub: "pub-1" }) }), "bad-provenance");
    // No `prv` at all: the execution profile requires it, so the token fails
    // verification before provenance is even read.
    const { prv, ...noProvenance } = EXEC;
    const now = Math.floor(Date.now() / 1000);
    const handmade = await new SignJWT({ ...noProvenance })
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "gc-exec+jwt" })
      .setIssuer(ISSUER).setAudience("urn:graffiticode:broker").setIssuedAt(now).setExpirationTime(now + 60).setJti("j")
      .sign(await importJWK(privateJwk, "ES256"));
    await denied(ask({ executionToken: handmade }), "bad-token");
  });

  describe("registered steps", () => {
    const write = async (step, purpose, after) => policy.authorizeExecution({
      caller: BROKER, executionToken: await token(WRITE_EXEC), op: WRITE, argsDigest: ARGD, step, purpose, after,
    });
    it("allows each registered step with its own purpose, dispatch steps in order", async () => {
      await expect(write("questions", "dispatch", null)).resolves.toHaveProperty("decisionId");
      await expect(write("items", "dispatch", "questions")).resolves.toHaveProperty("decisionId");
      await expect(write("receipt", "replay", null)).resolves.toHaveProperty("decisionId");
    });
    it("refuses an unregistered step, another purpose, a skipped or repeated dispatch", async () => {
      await denied(write("rollback", "dispatch", null), "step-not-registered");
      await denied(write("questions", "sign", null), "step-not-registered");
      await denied(write("items", "dispatch", null), "step-not-registered");
      await denied(write("questions", "dispatch", "questions"), "step-not-registered");
      await denied(write("items", "dispatch", "items"), "step-not-registered");
      await denied(ask({ step: "sign", purpose: "dispatch" }), "step-not-registered");
    });
  });

  it("re-reads live state: a grant revoked after mint stops the next step", async () => {
    const executionToken = await token({ ...WRITE_EXEC, sub: OTHER });
    const step = (s, after) => policy.authorizeExecution({ caller: BROKER, executionToken, op: WRITE, argsDigest: ARGD, step: s, purpose: "dispatch", after });
    await expect(step("questions", null)).resolves.toHaveProperty("decisionId");
    await grants.delete(grantIdFor({ connectionId: "conn-1", recipientUid: OTHER }));
    await denied(step("items", "questions"), "not-owner");
  });
});
