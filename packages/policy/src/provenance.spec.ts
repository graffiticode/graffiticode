import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
  SYSTEM_PREVIEW_SUBJECT,
  sessionProvenance,
  provenanceRefusal,
  createLocalSigner,
  issueToken,
  verifyToken,
  createAudit,
  createPseudonymizer,
  ISSUER
} from "./index.js";

const USER = "0xuseruid";

describe("sessionProvenance", () => {
  it.each([
    ["a user session", { sub: USER }, { provenance: "user" }],
    ["a publication session", { sub: USER, pub: "pub-1" }, { provenance: "publication" }],
    ["a system session", { sub: SYSTEM_PREVIEW_SUBJECT, sys: true }, { provenance: "system" }],
    ["system, another subject", { sub: USER, sys: true }, { refusal: "bad-session" }],
    ["system, also a publication", { sub: SYSTEM_PREVIEW_SUBJECT, sys: true, pub: "pub-1" }, { refusal: "bad-session" }],
    ["user, the system subject", { sub: SYSTEM_PREVIEW_SUBJECT }, { refusal: "bad-session" }],
    ["user, any `sys` claim", { sub: USER, sys: false }, { refusal: "bad-session" }],
  ])("%s", (_name, session, expected) => {
    expect(sessionProvenance(session)).toEqual(expected);
  });
});

describe("provenanceRefusal", () => {
  it.each([
    ["user", { prv: "user", sub: USER }, null],
    ["publication", { prv: "publication", pub: "pub-1", sub: USER }, null],
    ["system", { prv: "system", sub: SYSTEM_PREVIEW_SUBJECT }, null],
    ["no provenance", { sub: USER }, "bad-provenance"],
    ["an unknown provenance", { prv: "admin", sub: USER }, "bad-provenance"],
    ["a publication without its id", { prv: "publication", sub: USER }, "bad-provenance"],
    ["a publication with an empty id", { prv: "publication", pub: "", sub: USER }, "bad-provenance"],
    ["a user claiming a publication", { prv: "user", pub: "pub-1", sub: USER }, "bad-provenance"],
    ["a system token claiming a publication", { prv: "system", pub: "pub-1", sub: SYSTEM_PREVIEW_SUBJECT }, "bad-provenance"],
    ["a system token with a user subject", { prv: "system", sub: USER }, "bad-provenance"],
    ["a user with the system subject", { prv: "user", sub: SYSTEM_PREVIEW_SUBJECT }, "bad-provenance"],
    ["a publication with the system subject", { prv: "publication", pub: "pub-1", sub: SYSTEM_PREVIEW_SUBJECT }, "bad-provenance"],
  ])("%s", (_name, claims, expected) => {
    expect(provenanceRefusal(claims)).toBe(expected);
  });
});

describe("execution token provenance claims", () => {
  const EXEC = {
    sub: USER,
    own: USER,
    conn: "conn-1",
    backend: "learnosity",
    lang: "0176",
    fn: "init",
    op: "learnosity.sign-items-preview",
    sid: "sid-1",
    opid: "inv-1/s0/n1.0",
    argd: "a".repeat(64),
    rv: 6
  };
  let signer;
  let jwks;
  let privateKey;
  beforeEach(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    privateKey = pair.privateKey;
    signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
    jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  });

  it("carries prv and pub through issue and verify", async () => {
    const token = await issueToken(signer, "execution", { ...EXEC, prv: "publication", pub: "pub-1" });
    expect((await verifyToken(jwks, "execution", token)).claims).toMatchObject({ prv: "publication", pub: "pub-1" });
  });

  it("refuses a mistyped prv or pub", async () => {
    await expect(issueToken(signer, "execution", { ...EXEC, prv: 1 })).rejects.toThrow(/prv/);
    await expect(issueToken(signer, "execution", { ...EXEC, prv: "publication", pub: 7 })).rejects.toThrow(/pub/);
  });

  // Broker relies on provenance (W2 PR 5): a token without it is neither
  // issued nor verified.
  it("requires prv", async () => {
    await expect(issueToken(signer, "execution", EXEC)).rejects.toThrow(/prv/);
    const now = Math.floor(Date.now() / 1000);
    const handmade = await new SignJWT({ ...EXEC })
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "gc-exec+jwt" })
      .setIssuer(ISSUER).setAudience("urn:graffiticode:broker").setIssuedAt(now).setExpirationTime(now + 60).setJti("j")
      .sign(privateKey);
    await expect(verifyToken(jwks, "execution", handmade)).rejects.toThrow(/prv/);
  });
});

describe("audit fields for execution decisions", () => {
  it("records decisionId, jti, opid, step, purpose and provenance, and still drops everything else", async () => {
    const records = [];
    const audit = createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
    await audit({
      event: "authorize-execution",
      outcome: "allowed",
      uid: USER,
      decisionId: "d-1",
      jti: "j-1",
      opid: "inv-1/s0/n1.0",
      step: "questions",
      purpose: "dispatch",
      provenance: "user",
      token: "secret-token",
      payload: { questions: [] }
    });
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({ decisionId: "d-1", jti: "j-1", opid: "inv-1/s0/n1.0", step: "questions", purpose: "dispatch", provenance: "user" });
    expect(record.user).toEqual(expect.any(String));
    expect(record.user).not.toBe(USER);
    expect(record).not.toHaveProperty("uid");
    expect(record).not.toHaveProperty("token");
    expect(record).not.toHaveProperty("payload");
  });
});
