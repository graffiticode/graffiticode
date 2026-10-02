import { generateKeyPair, exportJWK, SignJWT, UnsecuredJWT } from "jose";
import { createHash } from "node:crypto";
import {
  createPolicy,
  PolicyDenied,
  createLocalSigner,
  issueToken,
  verifyToken,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryPublicationStore,
  createAudit,
  createPseudonymizer,
  ISSUER
} from "./index.js";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";

const OWNER = "0xowneruid";
const OTHER = "0xotheruid";
const L0176 = { role: "compiler", lang: "0176" };
const CONSOLE = { role: "console" };
const GATEWAY = { role: "gateway" };
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
  policy = createPolicy({
    signer, jwks, connections, invocations: createMemoryInvocationStore(), publications: createMemoryPublicationStore(), audit
  });
});

const ALL_FNS = ["init", "save-to-itembank", "author"];
const invoke = (over = {}) => policy.allocateInvocation({
  caller: GATEWAY,
  user: { uid: OWNER },
  connectionId: "conn-1",
  taskId: "task-1",
  inputDigest: digest("input"),
  ...over
});
const snap = async (over = {}) => policy.snapshot({
  caller: L0176,
  user: { uid: OWNER },
  lang: "0176",
  connectionId: "conn-1",
  fns: ALL_FNS,
  // Signed directly, so snapshot tests can name any user or connection.
  invocationToken: await issueToken(signer, "invocation", {
    sub: (over.user ?? { uid: OWNER }).uid,
    conn: over.connectionId ?? "conn-1",
    inv: "inv-1",
    seq: 1
  }),
  stage: "s0",
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
  it("gives the owner every function the program calls, writes included, but not gated Author", async () => {
    const result = await snap();
    expect(result.allowed).toEqual(["init", "save-to-itembank"]);
    expect(result.mode).toBeUndefined();
    const { claims } = await verifyToken(jwks, "session", result.sessionToken);
    expect(claims.mode).toBeUndefined();
    expect(claims.sav).toBeUndefined();
  });

  it("ignores functions that are not registered for the language", async () => {
    expect((await snap({ fns: ["init", "made-up", "toString"] })).allowed).toEqual(["init"]);
  });

  it("allows nothing against a connection of another backend", async () => {
    expect((await snap({ connectionId: "conn-x" })).allowed).toEqual([]);
  });

  it.each([
    ["a non-owner", { user: { uid: OTHER } }, "not-owner"],
    ["a disabled connection", { connectionId: "conn-off" }, "connection-disabled"],
    ["a missing connection", { connectionId: "conn-none" }, "connection-not-found"],
    ["another owner's connection", { connectionId: "conn-other" }, "not-owner"],
    ["a caller asking for another language", { caller: { role: "compiler", lang: "0000" } }, "caller-language-mismatch"],
    ["a caller that is not a compiler", { caller: CONSOLE }, "caller-language-mismatch"],
    ["no user", { user: null }, "no-user"]
  ])("refuses %s", async (_, over, reason) => {
    await denied(snap(over), reason);
  });

  it("refuses a session token presented as an invocation", async () => {
    const { sessionToken } = await snap();
    await denied(snap({ invocationToken: sessionToken }), "bad-invocation");
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
    fn: "init",
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
      fn: "init",
      op: "learnosity.sign-items-preview",
      argd: digest("args"),
      opid: operationId
    });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
  });

  it("never lets a preview-only session sign Author requests or write", async () => {
    const { sessionToken } = await snap({ fns: ["init"] });
    await denied(mintWith(sessionToken, { op: "learnosity.sign-author" }), "operation-not-allowed");
    await denied(mintWith(sessionToken, { op: "learnosity.write-items" }), "operation-not-allowed");
    await denied(mintWith(sessionToken, { fn: "save-to-itembank", op: "learnosity.write-items" }), "fn-not-in-session");
  });

  it("mints a write for any session whose program calls it", async () => {
    const { sessionToken } = await snap();
    await expect(mintWith(sessionToken, { fn: "save-to-itembank", op: "learnosity.write-items" })).resolves.toBeTruthy();
    await denied(mintWith(sessionToken, { fn: "save-to-itembank", op: "learnosity.sign-author" }), "operation-not-allowed");
  });

  it("accepts the occurrence ids compilers send, and nothing outside [A-Za-z0-9_:.-]", async () => {
    const { sessionToken } = await snap();
    await expect(mintWith(sessionToken, { occurrenceId: "SAVE_TO_ITEMBANK:42.0" })).resolves.toBeTruthy();
    await expect(mintWith(sessionToken, { occurrenceId: "prog.0" })).resolves.toBeTruthy();
    await denied(mintWith(sessionToken, { occurrenceId: "SAVE_TO_ITEMBANK@42.0" }), "bad-request");
  });

  it("keys a write by invocation, stage and occurrence", async () => {
    const { invocationId, invocationToken } = await invoke();
    const { sessionToken } = await snap({ invocationToken, stage: "s1" });
    const { operationId } = await mintWith(sessionToken, { fn: "save-to-itembank", op: "learnosity.write-items" });
    expect(operationId).toBe(`${invocationId}/s1/n12.0`);
  });

  it("gives a retry (same idempotency key) the same operation id, and a rerun a new one", async () => {
    const w = { fn: "save-to-itembank", op: "learnosity.write-items" };
    const opid = async invocation => (await mintWith((await snap({ invocationToken: invocation.invocationToken })).sessionToken, w)).operationId;
    const first = await invoke({ idempotencyKey: "job-1" });
    const retry = await invoke({ idempotencyKey: "job-1" });
    const rerun = await invoke({ idempotencyKey: "job-2" });
    expect(retry).toMatchObject({ invocationId: first.invocationId, seq: first.seq, reused: true, ownerUid: OWNER });
    expect(await opid(retry)).toBe(await opid(first));
    expect(await opid(rerun)).not.toBe(await opid(first));
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
    claims.sub = OTHER;
    const forged = [h, Buffer.from(JSON.stringify(claims)).toString("base64url"), s].join(".");
    await denied(mintWith(forged, { fn: "save-to-itembank", op: "learnosity.write-items" }), "bad-session");
  });

  it("refuses a caller from another language", async () => {
    const { sessionToken } = await snap();
    await denied(mintWith(sessionToken, { caller: { role: "compiler", lang: "0000" } }), "caller-language-mismatch");
    await denied(mintWith(sessionToken, { caller: CONSOLE }), "caller-language-mismatch");
  });

  it("refuses a malformed digest or occurrence id", async () => {
    const { sessionToken } = await snap();
    await denied(mintWith(sessionToken, { argsDigest: "abc" }), "bad-request");
    await denied(mintWith(sessionToken, { occurrenceId: "" }), "bad-request");
  });
});

// AUTHOR-01: Author is disabled until verified. Policy refuses it unless its
// deployment explicitly enables it, and an owner's own permissions cannot
// bypass that.
describe("enablement-gated functions (Author)", () => {
  const withGates = enabledGated => createPolicy({
    signer,
    jwks,
    connections,
    invocations: createMemoryInvocationStore(),
    publications: createMemoryPublicationStore(),
    audit: createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) }),
    enabledGated
  });
  const authorSession = () => issueToken(signer, "session", {
    sub: OWNER,
    own: OWNER,
    conn: "conn-1",
    backend: "learnosity",
    lang: "0176",
    inv: "inv-1",
    stg: "s0",
    rv: REGISTRY_VERSION,
    fns: ALL_FNS
  });
  const mintAuthor = (p, sessionToken) => p.mint({
    caller: L0176, sessionToken, fn: "author", op: "learnosity.sign-author", occurrenceId: "n3.0", argsDigest: digest("args")
  });

  it("leaves Author out of an owner's session by default", async () => {
    const result = await snap();
    expect(result.allowed).not.toContain("author");
  });

  it("includes Author for the owner once the deployment enables it", async () => {
    policy = withGates(new Set(["0176:author"]));
    const result = await snap();
    expect(result.allowed).toEqual(ALL_FNS);
    await expect(mintAuthor(policy, result.sessionToken)).resolves.toBeTruthy();
  });

  it("refuses to mint Author even for a session that lists it", async () => {
    await denied(mintAuthor(policy, await authorSession()), "fn-not-enabled");
    expect(records.at(-1)).toMatchObject({ event: "mint", outcome: "denied", reason: "fn-not-enabled", fn: "author" });
  });

  it("is not reachable through an owner's own permission list", async () => {
    await connections.put({ ...(await connections.get("conn-1")), ownerPermissions: [{ lang: "0176", fn: "author" }] });
    // init still comes with any function named in its language (GRANT-01).
    expect((await snap()).allowed).toEqual(["init"]);
    await denied(mintAuthor(policy, await authorSession()), "fn-not-enabled");
  });
});

describe("invocations", () => {
  it("are allocated only by the gateway, for the connection's owner", async () => {
    await denied(invoke({ caller: CONSOLE }), "caller-not-entry-point");
    await denied(invoke({ caller: L0176 }), "caller-not-entry-point");
    await denied(invoke({ user: { uid: OTHER } }), "not-owner");
    await denied(invoke({ connectionId: "conn-off" }), "connection-disabled");
    await denied(invoke({ inputDigest: "nope" }), "bad-request");
  });

  it("refuse an idempotency key reused for different input", async () => {
    await invoke({ idempotencyKey: "k" });
    await denied(invoke({ idempotencyKey: "k", taskId: "task-2" }), "idempotency-key-reused");
    await denied(invoke({ idempotencyKey: "k", inputDigest: digest("other") }), "idempotency-key-reused");
    await expect(invoke({ idempotencyKey: "k", user: { uid: OTHER }, connectionId: "conn-other" })).resolves.toMatchObject({ reused: false });
  });

  it("carry a sequence that increases per user, task and connection", async () => {
    const seqs = [];
    for (let i = 0; i < 3; i++) seqs.push((await invoke()).seq);
    expect(seqs).toEqual([1, 2, 3]);
    expect((await invoke({ taskId: "task-2" })).seq).toBe(1);
  });

  it("must come from a policy invocation token for this user and connection", async () => {
    const { invocationToken } = await invoke();
    await denied(snap({ invocationToken: "not-a-token" }), "bad-invocation");
    await denied(snap({ invocationToken: await issueToken(signer, "session", { sub: OWNER, conn: "conn-1", inv: "inv-x" }) }), "bad-invocation");
    await denied(snap({ invocationToken, user: { uid: OTHER }, connectionId: "conn-other" }), "bad-invocation");
    await denied(snap({ invocationToken, stage: "" }), "bad-request");
  });
});

describe("publications", () => {
  const publish = (over = {}) => policy.createPublication({
    caller: GATEWAY,
    user: { uid: OWNER },
    connectionId: "conn-1",
    taskId: "task-1",
    lang: "0176",
    artifactInvocationId: "inv-run",
    ...over
  });
  const view = publicationId => policy.authorizeView({ caller: GATEWAY, publicationId });
  const mintWith = (sessionToken, over = {}) => policy.mint({
    caller: L0176,
    sessionToken,
    fn: "init",
    op: "learnosity.sign-items-preview",
    occurrenceId: "prog.0",
    argsDigest: digest("args"),
    ...over
  });
  // A compiler's snapshot for a published view: no user at all.
  const viewSnap = (invocationToken, over = {}) => policy.snapshot({
    caller: L0176, user: null, lang: "0176", connectionId: "conn-1", fns: ALL_FNS, invocationToken, stage: "view", ...over
  });

  it("are created by the gateway for the connection's owner only", async () => {
    await expect(publish()).resolves.toMatchObject({ publicationId: expect.stringMatching(/^pub-/) });
    await denied(publish({ caller: CONSOLE }), "caller-not-entry-point");
    await denied(publish({ user: { uid: OTHER } }), "not-owner");
    await denied(publish({ connectionId: "conn-off" }), "connection-disabled");
    await denied(publish({ lang: "L0176" }), "bad-request");
  });

  it("give a viewer with no user the publisher's preview signing, and nothing else", async () => {
    const { publicationId } = await publish();
    const v = await view(publicationId);
    expect(v).toMatchObject({ publisherUid: OWNER, connectionId: "conn-1", lang: "0176", taskId: "task-1", artifactInvocationId: "inv-run" });
    const snap = await viewSnap(v.invocationToken);
    expect(snap).toMatchObject({ allowed: ["init"] });
    const { claims } = await verifyToken(jwks, "session", snap.sessionToken);
    expect(claims).toMatchObject({ sub: OWNER, pub: publicationId, fns: ["init"] });
    await expect(mintWith(snap.sessionToken)).resolves.toBeTruthy();
    await denied(mintWith(snap.sessionToken, { fn: "save-to-itembank", op: "learnosity.write-items" }), "fn-not-in-session");
    await denied(mintWith(snap.sessionToken, { fn: "author", op: "learnosity.sign-author" }), "fn-not-in-session");
  });

  it("share one invocation across views", async () => {
    const { publicationId } = await publish();
    const a = await verifyToken(jwks, "invocation", (await view(publicationId)).invocationToken);
    const b = await verifyToken(jwks, "invocation", (await view(publicationId)).invocationToken);
    expect(a.claims.inv).toBe(b.claims.inv);
  });

  it("stop at the next view and the next mint once unpublished", async () => {
    const { publicationId } = await publish();
    const snap = await viewSnap((await view(publicationId)).invocationToken);
    await denied(policy.deletePublication({ caller: GATEWAY, user: { uid: OTHER }, publicationId }), "not-publisher");
    await policy.deletePublication({ caller: GATEWAY, user: { uid: OWNER }, publicationId });
    await denied(view(publicationId), "publication-not-found");
    await denied(mintWith(snap.sessionToken), "publication-not-found");
  });

  it("stop once the connection is disabled", async () => {
    const { publicationId } = await publish();
    const { invocationToken } = await view(publicationId);
    await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "disabled" });
    await denied(view(publicationId), "connection-disabled");
    await denied(viewSnap(invocationToken), "connection-disabled");
  });

  it("refuse a publication token presented for another connection or language", async () => {
    const { publicationId } = await publish();
    const { invocationToken } = await view(publicationId);
    await denied(viewSnap(invocationToken, { connectionId: "conn-x" }), "bad-invocation");
    await denied(viewSnap(invocationToken, { caller: { role: "compiler", lang: "0000" }, lang: "0000" }), "publication-mismatch");
  });

  it("still require a user for any other invocation", async () => {
    const { invocationToken } = await invoke();
    await denied(viewSnap(invocationToken), "no-user");
  });
});

describe("system preview sessions", () => {
  const SYSTEM = "0xgraffiticode";
  let sys;
  let sysRecords;
  const make = systemConnections => {
    sysRecords = [];
    return createPolicy({
      signer,
      jwks,
      connections,
      invocations: createMemoryInvocationStore(),
      publications: createMemoryPublicationStore(),
      systemConnections,
      audit: createAudit({ sink: r => sysRecords.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) })
    });
  };
  beforeEach(async () => {
    await connections.put({ connectionId: "conn-sys", ownerUid: SYSTEM, backend: "learnosity", status: "active" });
    sys = make({ learnosity: "conn-sys" });
  });
  const session = (over = {}) => sys.previewSession({ caller: L0176, lang: "0176", ...over });
  const mintWith = (sessionToken, over = {}) => sys.mint({
    caller: L0176,
    sessionToken,
    fn: "init",
    op: "learnosity.sign-items-preview",
    occurrenceId: "prog.0",
    argsDigest: digest("args"),
    ...over
  });
  const sessionClaims = async () => (await verifyToken(jwks, "session", (await session()).sessionToken)).claims;

  it("gives a compiler a session on the system connection carrying preview signing only", async () => {
    const result = await session();
    expect(result.allowed).toEqual(["init"]);
    const { claims } = await verifyToken(jwks, "session", result.sessionToken);
    expect(claims).toMatchObject({
      sub: "system-preview",
      sys: true,
      own: SYSTEM,
      conn: "conn-sys",
      backend: "learnosity",
      lang: "0176",
      stg: "preview",
      fns: ["init"]
    });
    expect(claims.inv).toMatch(/^sys-/);
    expect(claims.pub).toBeUndefined();
    expect(sysRecords).toEqual([expect.objectContaining({ event: "preview-session", outcome: "allowed", reason: "system-preview" })]);
  });

  it.each([
    ["a caller that is not a compiler", { caller: CONSOLE }, "caller-language-mismatch"],
    ["the gateway", { caller: GATEWAY }, "caller-language-mismatch"],
    ["a compiler asking for another language", { caller: { role: "compiler", lang: "0000" } }, "caller-language-mismatch"],
    ["a language that is not its own", { lang: "0000" }, "caller-language-mismatch"],
    ["a language with no system-preview functions", { caller: { role: "compiler", lang: "0002" }, lang: "0002" }, "no-system-preview-functions"],
    ["a malformed language", { caller: { role: "compiler", lang: "L0176" }, lang: "L0176" }, "bad-request"]
  ])("refuses %s, and audits it", async (_, over, reason) => {
    await denied(session(over), reason);
    expect(sysRecords.at(-1)).toMatchObject({ event: "preview-session", outcome: "denied", reason });
  });

  it("refuses when no system connection is configured", async () => {
    sys = make({});
    await denied(session(), "no-system-connection");
    expect(sysRecords.at(-1)).toMatchObject({ outcome: "denied", reason: "no-system-connection" });
    sys = make(undefined);
    await denied(session(), "no-system-connection");
  });

  it.each([
    ["missing", () => connections.delete("conn-sys"), "connection-not-found"],
    ["disabled", () => connections.put({ connectionId: "conn-sys", ownerUid: SYSTEM, backend: "learnosity", status: "disabled" }), "connection-disabled"],
    ["of another backend", () => connections.put({ connectionId: "conn-sys", ownerUid: SYSTEM, backend: "other", status: "active" }), "backend-changed"]
  ])("refuses when the system connection is %s", async (_, change, reason) => {
    await change();
    await denied(session(), reason);
    expect(sysRecords.at(-1)).toMatchObject({ outcome: "denied", reason });
  });

  it("mints preview signing for Items and Questions, with no user and no grant", async () => {
    const { sessionToken } = await session();
    const items = await mintWith(sessionToken);
    const { claims } = await verifyToken(jwks, "execution", items.executionToken);
    expect(claims).toMatchObject({
      sub: "system-preview",
      own: SYSTEM,
      conn: "conn-sys",
      backend: "learnosity",
      lang: "0176",
      fn: "init",
      op: "learnosity.sign-items-preview",
      argd: digest("args")
    });
    expect(items.operationId).toMatch(/^sys-[0-9a-f-]+\/preview\/prog\.0$/);
    await expect(mintWith(sessionToken, { op: "learnosity.sign-questions-preview" })).resolves.toBeTruthy();
    expect(sysRecords.filter(r => r.event === "mint").map(r => r.outcome)).toEqual(["allowed", "allowed"]);
  });

  it("never mints a write or Author signing", async () => {
    const { sessionToken } = await session();
    await denied(mintWith(sessionToken, { fn: "save-to-itembank", op: "learnosity.write-items" }), "fn-not-in-session");
    await denied(mintWith(sessionToken, { fn: "author", op: "learnosity.sign-author" }), "fn-not-in-session");
    await denied(mintWith(sessionToken, { op: "learnosity.write-items" }), "operation-not-allowed");
    await denied(mintWith(sessionToken, { op: "learnosity.sign-author" }), "operation-not-allowed");
  });

  it("never mints a write or Author signing even for a system session that names them", async () => {
    // Signed with policy's own key, as if a session had been issued with more.
    const { rv } = await sessionClaims();
    const wide = await issueToken(signer, "session", {
      sub: "system-preview",
      sys: true,
      own: SYSTEM,
      conn: "conn-sys",
      backend: "learnosity",
      lang: "0176",
      inv: "sys-x",
      stg: "preview",
      rv,
      fns: ["init", "save-to-itembank", "author"]
    });
    await denied(mintWith(wide, { fn: "save-to-itembank", op: "learnosity.write-items" }), "not-system-preview");
    await denied(mintWith(wide, { fn: "author", op: "learnosity.sign-author" }), "not-system-preview");
    await expect(mintWith(wide)).resolves.toBeTruthy();
  });

  it("stops at the next mint once the system connection is disabled, re-typed, re-owned or deleted", async () => {
    const { sessionToken } = await session();
    await connections.put({ connectionId: "conn-sys", ownerUid: SYSTEM, backend: "learnosity", status: "disabled" });
    await denied(mintWith(sessionToken), "connection-disabled");
    await connections.put({ connectionId: "conn-sys", ownerUid: SYSTEM, backend: "other", status: "active" });
    await denied(mintWith(sessionToken), "backend-changed");
    await connections.put({ connectionId: "conn-sys", ownerUid: OTHER, backend: "learnosity", status: "active" });
    await denied(mintWith(sessionToken), "owner-changed");
    await connections.delete("conn-sys");
    await denied(mintWith(sessionToken), "connection-not-found");
  });

  it("stops once the configured system connection changes or is removed", async () => {
    const { sessionToken } = await session();
    await connections.put({ connectionId: "conn-sys-2", ownerUid: SYSTEM, backend: "learnosity", status: "active" });
    sys = make({ learnosity: "conn-sys-2" });
    await denied(mintWith(sessionToken), "not-system-connection");
    sys = make({});
    await denied(mintWith(sessionToken), "not-system-connection");
  });

  it("refuses a system session spent by another language's compiler", async () => {
    const { sessionToken } = await session();
    await denied(mintWith(sessionToken, { caller: { role: "compiler", lang: "0000" } }), "caller-language-mismatch");
  });

  it("refuses the system subject without the system mark, and the mark without the subject", async () => {
    const { rv } = await sessionClaims();
    const base = { own: SYSTEM, conn: "conn-sys", backend: "learnosity", lang: "0176", inv: "i", stg: "s", rv, fns: ["init"] };
    await denied(mintWith(await issueToken(signer, "session", { ...base, sub: "system-preview" })), "bad-session");
    await denied(mintWith(await issueToken(signer, "session", { ...base, sub: OWNER, sys: true })), "bad-session");
  });

  it("leaves the system connection unusable as an ordinary connection", async () => {
    await denied(sys.snapshot({
      caller: L0176,
      user: { uid: OWNER },
      lang: "0176",
      connectionId: "conn-sys",
      fns: ["init"],
      invocationToken: await issueToken(signer, "invocation", { sub: OWNER, conn: "conn-sys", inv: "inv-1", seq: 1 }),
      stage: "s0"
    }), "system-connection");
  });
});
