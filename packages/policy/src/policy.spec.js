import { generateKeyPair, exportJWK, SignJWT, UnsecuredJWT } from "jose";
import { createHash } from "node:crypto";
import {
  createPolicy,
  PolicyDenied,
  createLocalSigner,
  issueToken,
  verifyToken,
  createMemoryConnectionStore,
  createAudit,
  createPseudonymizer,
  ISSUER
} from "./index.js";

const OWNER = "0xowneruid";
const OTHER = "0xotheruid";
const L0176 = { lang: "0176" };
const digest = s => createHash("sha256").update(s).digest("hex");

let signer;
let jwks;
let privateKey;
let connections;
let records;
let policy;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKey = pair.privateKey;
  const privateJwk = await exportJWK(pair.privateKey);
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  signer = await createLocalSigner({ privateJwk, kid: "k1" });
  jwks = { keys: [publicJwk] };
  connections = createMemoryConnectionStore([
    { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active", label: "mine" },
    { connectionId: "conn-off", ownerUid: OWNER, backend: "learnosity", status: "disabled" },
    { connectionId: "conn-other", ownerUid: OTHER, backend: "learnosity", status: "active" },
    { connectionId: "conn-x", ownerUid: OWNER, backend: "other", status: "active" }
  ]);
  records = [];
  const audit = createAudit({
    sink: r => records.push(r),
    pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" })
  });
  policy = createPolicy({ signer, jwks, connections, audit });
});

const ALL_FNS = ["preview-itembank", "save-to-itembank", "author-itembank"];
const snap = (over = {}) => policy.snapshot({
  caller: L0176,
  user: { uid: OWNER },
  lang: "0176",
  connectionId: "conn-1",
  fns: ALL_FNS,
  mode: "read",
  invocationId: "inv-1",
  ...over
});
const denied = async (promise, reason) => {
  await expect(promise).rejects.toBeInstanceOf(PolicyDenied);
  await expect(promise).rejects.toMatchObject({ reason });
};

describe("token profiles", () => {
  it("verifies a session token only as a session token", async () => {
    const token = await issueToken(signer, "session", { sub: OWNER });
    await expect(verifyToken(jwks, "session", token)).resolves.toBeTruthy();
    await expect(verifyToken(jwks, "execution", token)).rejects.toThrow();
  });

  it("verifies an execution token only as an execution token", async () => {
    const token = await issueToken(signer, "execution", { sub: OWNER });
    await expect(verifyToken(jwks, "execution", token)).resolves.toBeTruthy();
    await expect(verifyToken(jwks, "session", token)).rejects.toThrow();
  });

  it("rejects an unsigned token", async () => {
    const token = new UnsecuredJWT({ sub: OWNER }).setIssuer(ISSUER).setAudience("urn:graffiticode:policy").encode();
    await expect(verifyToken(jwks, "session", token)).rejects.toThrow();
  });

  it("rejects a token with the right key but the wrong typ", async () => {
    const token = await new SignJWT({ sub: OWNER })
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "JWT" })
      .setIssuer(ISSUER).setAudience("urn:graffiticode:policy").setIssuedAt().setExpirationTime("1m").setJti("j")
      .sign(privateKey);
    await expect(verifyToken(jwks, "session", token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await new SignJWT({ sub: OWNER })
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "gc-session+jwt" })
      .setIssuer(ISSUER).setAudience("urn:graffiticode:policy")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600).setExpirationTime(Math.floor(Date.now() / 1000) - 60).setJti("j")
      .sign(privateKey);
    await expect(verifyToken(jwks, "session", token)).rejects.toThrow();
  });

  it("rejects a token signed by another key", async () => {
    const other = await generateKeyPair("ES256", { extractable: true });
    const otherSigner = await createLocalSigner({ privateJwk: await exportJWK(other.privateKey), kid: "k1" });
    const token = await issueToken(otherSigner, "session", { sub: OWNER });
    await expect(verifyToken(jwks, "session", token)).rejects.toThrow();
  });
});

describe("snapshot (owner-only)", () => {
  it("gives the owner the functions that run in the session's mode", async () => {
    expect((await snap({ mode: "read" })).allowed).toEqual(["preview-itembank"]);
    expect((await snap({ mode: "author" })).allowed).toEqual(["preview-itembank", "author-itembank"]);
  });

  it("gives writes only to a save session that carries a save-action id", async () => {
    expect((await snap({ mode: "save" })).allowed).toEqual(["preview-itembank"]);
    expect((await snap({ mode: "save", saveActionId: "sa-1" })).allowed).toEqual(["preview-itembank", "save-to-itembank"]);
  });

  it("ignores functions that are not registered for the language", async () => {
    expect((await snap({ fns: ["preview-itembank", "made-up", "toString"] })).allowed).toEqual(["preview-itembank"]);
  });

  it("allows nothing against a connection of another backend", async () => {
    expect((await snap({ connectionId: "conn-x" })).allowed).toEqual([]);
  });

  it.each([
    ["a non-owner", { user: { uid: OTHER } }, "not-owner"],
    ["a disabled connection", { connectionId: "conn-off" }, "connection-disabled"],
    ["a missing connection", { connectionId: "conn-none" }, "connection-not-found"],
    ["another owner's connection", { connectionId: "conn-other" }, "not-owner"],
    ["a caller asking for another language", { caller: { lang: "0000" } }, "caller-language-mismatch"],
    ["an unknown mode", { mode: "admin" }, "bad-mode"],
    ["a save-action id outside save mode", { mode: "read", saveActionId: "sa-1" }, "bad-save-action"],
    ["no user", { user: null }, "no-user"]
  ])("refuses %s", async (_, over, reason) => {
    await denied(snap(over), reason);
  });

  it("audits allowed and denied decisions with pseudonymous ids and no tokens", async () => {
    const { sessionToken } = await snap();
    await snap({ user: { uid: OTHER } }).catch(() => {});
    expect(records.map(r => r.outcome)).toEqual(["allowed", "denied"]);
    const text = JSON.stringify(records);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain(sessionToken);
    expect(records[1].reason).toBe("not-owner");
  });
});

describe("mint", () => {
  const mintWith = (sessionToken, over = {}) => policy.mint({
    caller: L0176,
    sessionToken,
    fn: "preview-itembank",
    op: "learnosity.sign-items-preview",
    occurrenceId: "n12.0",
    argsDigest: digest("args"),
    ...over
  });

  it("issues an execution token scoped to one operation", async () => {
    const { sessionToken } = await snap();
    const { executionToken, operationId } = await mintWith(sessionToken);
    const { claims } = await verifyToken(jwks, "execution", executionToken);
    expect(claims).toMatchObject({
      sub: OWNER,
      conn: "conn-1",
      lang: "0176",
      fn: "preview-itembank",
      op: "learnosity.sign-items-preview",
      mode: "read",
      argd: digest("args"),
      opid: operationId
    });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
  });

  it("never lets a preview session sign Author requests or write", async () => {
    const { sessionToken } = await snap();
    await denied(mintWith(sessionToken, { op: "learnosity.sign-author" }), "operation-not-allowed");
    await denied(mintWith(sessionToken, { op: "learnosity.write-items" }), "operation-not-allowed");
    await denied(mintWith(sessionToken, { fn: "save-to-itembank", op: "learnosity.write-items" }), "fn-not-in-session");
  });

  it("never mints a write for a read session, even for the owner", async () => {
    const { sessionToken } = await snap({ mode: "read" });
    await denied(mintWith(sessionToken, { fn: "save-to-itembank", op: "learnosity.write-items" }), "fn-not-in-session");
  });

  it("mints a write in a save session, keyed by the save action", async () => {
    const { sessionToken } = await snap({ mode: "save", saveActionId: "sa-1" });
    const { operationId } = await mintWith(sessionToken, { fn: "save-to-itembank", op: "learnosity.write-items" });
    expect(operationId).toBe("sa-1/n12.0");
  });

  it("gives a retried save (new invocation, same save action) the same operation id", async () => {
    const first = await snap({ mode: "save", saveActionId: "sa-1", invocationId: "inv-1" });
    const retry = await snap({ mode: "save", saveActionId: "sa-1", invocationId: "inv-2" });
    const w = { fn: "save-to-itembank", op: "learnosity.write-items" };
    const a = await mintWith(first.sessionToken, w);
    const b = await mintWith(retry.sessionToken, w);
    expect(a.operationId).toBe(b.operationId);
  });

  it("stops at the next mint once the connection is disabled or re-owned", async () => {
    const { sessionToken } = await snap();
    await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "disabled" });
    await denied(mintWith(sessionToken), "connection-disabled");
    await connections.put({ connectionId: "conn-1", ownerUid: OTHER, backend: "learnosity", status: "active" });
    await denied(mintWith(sessionToken), "owner-changed");
    await connections.delete("conn-1");
    await denied(mintWith(sessionToken), "connection-not-found");
  });

  it("refuses an execution token presented as a session", async () => {
    const { sessionToken } = await snap();
    const { executionToken } = await mintWith(sessionToken);
    await denied(mintWith(executionToken), "bad-session");
  });

  it("refuses a tampered session token", async () => {
    const { sessionToken } = await snap();
    const [h, p, s] = sessionToken.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.fns = ["save-to-itembank"];
    claims.mode = "save";
    const forged = [h, Buffer.from(JSON.stringify(claims)).toString("base64url"), s].join(".");
    await denied(mintWith(forged, { fn: "save-to-itembank", op: "learnosity.write-items" }), "bad-session");
  });

  it("refuses a caller from another language", async () => {
    const { sessionToken } = await snap();
    await denied(mintWith(sessionToken, { caller: { lang: "0000" } }), "caller-language-mismatch");
  });

  it("refuses a malformed digest or occurrence id", async () => {
    const { sessionToken } = await snap();
    await denied(mintWith(sessionToken, { argsDigest: "abc" }), "bad-request");
    await denied(mintWith(sessionToken, { occurrenceId: "" }), "bad-request");
  });
});
