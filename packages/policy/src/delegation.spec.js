// Delegation end to end within policy: the owner shares a connection through
// the manager, and policy's decisions (invocation, snapshot, mint, publication)
// honor the grant live.
import { generateKeyPair, exportJWK } from "jose";
import { createHash } from "node:crypto";
import {
  createPolicy,
  createConnectionManager,
  createLocalSigner,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryPublicationStore,
  createMemoryGrantStore,
  createAudit,
  createPseudonymizer,
  grantIdFor,
  PolicyDenied
} from "./index.js";

const OWNER = "0xowner";
const ALICE = "0xalice";
const BOB = "0xbob";
const CONSOLE = { role: "console" };
const GATEWAY = { role: "gateway" };
const L0176 = { role: "compiler", lang: "0176" };
const ALL_FNS = ["preview-itembank", "save-to-itembank", "author-itembank"];
const hash = s => createHash("sha256").update(s).digest("hex");

let policy;
let manager;
let grants;
let connections;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const audit = createAudit({ sink: () => {}, pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
  connections = createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active", label: "Bank" }]);
  grants = createMemoryGrantStore();
  policy = createPolicy({
    signer, jwks, connections, grants, audit, invocations: createMemoryInvocationStore(), publications: createMemoryPublicationStore()
  });
  manager = createConnectionManager({ connections, grants, audit, brokerAdmin: { createSecret: async () => {}, rotateSecret: async () => {}, deleteSecret: async () => {} } });
});

const denied = async (promise, reason) => {
  await expect(promise).rejects.toBeInstanceOf(PolicyDenied);
  await expect(promise).rejects.toMatchObject({ reason });
};
const share = (preset, over = {}) => manager.share({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", recipientUid: ALICE, preset, ...over });
const invoke = uid => policy.allocateInvocation({ caller: GATEWAY, user: { uid }, connectionId: "conn-1", taskId: "task-1", inputDigest: hash("in") });
const snap = async uid => policy.snapshot({
  caller: L0176, user: { uid }, lang: "0176", connectionId: "conn-1", fns: ALL_FNS, invocationToken: (await invoke(uid)).invocationToken, stage: "s0"
});
const mint = (sessionToken, fn, op) => policy.mint({ caller: L0176, sessionToken, fn, op, occurrenceId: "n1.0", argsDigest: hash("args") });

describe("delegation", () => {
  it("lets a recipient use exactly the preset's functions, never Author", async () => {
    await denied(invoke(ALICE), "not-owner");
    await share("save");
    const { allowed, sessionToken } = await snap(ALICE);
    expect(allowed).toEqual(["preview-itembank", "save-to-itembank"]);
    await expect(mint(sessionToken, "save-to-itembank", "learnosity.write-items")).resolves.toBeTruthy();
    await denied(mint(sessionToken, "author-itembank", "learnosity.sign-author"), "fn-not-in-session");
  });

  it("gives a preview grant no writes", async () => {
    await share("preview");
    const { allowed, sessionToken } = await snap(ALICE);
    expect(allowed).toEqual(["preview-itembank"]);
    await denied(mint(sessionToken, "save-to-itembank", "learnosity.write-items"), "fn-not-in-session");
  });

  it("never reaches Author even through a grant that names it", async () => {
    await share("save");
    const id = grantIdFor({ connectionId: "conn-1", recipientUid: ALICE });
    await grants.put({ ...(await grants.get(id)), fns: ALL_FNS });
    expect((await snap(ALICE)).allowed).toEqual(["preview-itembank", "save-to-itembank"]);
  });

  it("stops the recipient's next call once revoked, narrowed or expired", async () => {
    const { grantId } = await share("save");
    const { sessionToken } = await snap(ALICE);
    await share("preview");
    await denied(mint(sessionToken, "save-to-itembank", "learnosity.write-items"), "not-granted");
    await manager.revoke({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", grantId });
    await denied(mint(sessionToken, "preview-itembank", "learnosity.sign-items-preview"), "not-owner");
    await denied(invoke(ALICE), "not-owner");
    const id = grantIdFor({ connectionId: "conn-1", recipientUid: ALICE });
    await grants.put({ grantId: id, connectionId: "conn-1", ownerUid: OWNER, recipientUid: ALICE, fns: ["preview-itembank"], publish: false, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await denied(invoke(ALICE), "not-owner");
  });

  it("lets only the owner share, list and revoke, and a recipient cannot reshare", async () => {
    await share("save");
    await denied(manager.share({ caller: CONSOLE, user: { uid: ALICE }, connectionId: "conn-1", recipientUid: BOB, preset: "save" }), "not-owner");
    await denied(manager.grants({ caller: CONSOLE, user: { uid: ALICE }, connectionId: "conn-1" }), "not-owner");
    await denied(share("save", { recipientUid: OWNER }), "self-grant");
    await denied(share("author"), "bad-request");
    await denied(share("save", { caller: L0176 }), "caller-not-entry-point");
    const list = await manager.grants({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1" });
    expect(list).toEqual([expect.objectContaining({ preset: "save", pending: false })]);
  });

  it("holds a share to an email until that person claims it", async () => {
    await share("save", { recipientUid: null, recipientEmailHash: hash("alice@example.com"), recipientLabel: "alice@example.com" });
    expect((await manager.grants({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1" }))[0]).toMatchObject({ pending: true, recipientLabel: "alice@example.com" });
    await denied(invoke(ALICE), "not-owner");
    expect(await manager.claim({ caller: CONSOLE, user: { uid: ALICE }, emailHashes: [hash("alice@example.com")] })).toEqual({ claimed: 1 });
    expect((await snap(ALICE)).allowed).toEqual(["preview-itembank", "save-to-itembank"]);
    expect(await manager.claim({ caller: CONSOLE, user: { uid: BOB }, emailHashes: [hash("alice@example.com")] })).toEqual({ claimed: 0 });
  });

  it("lists shared connections for the recipient, and lets them leave", async () => {
    await share("preview");
    expect(await manager.shared({ caller: CONSOLE, user: { uid: ALICE } })).toEqual([
      { connectionId: "conn-1", backend: "learnosity", status: "active", label: "Bank", preset: "preview", expiresAt: null }
    ]);
    await manager.leave({ caller: CONSOLE, user: { uid: ALICE }, connectionId: "conn-1" });
    expect(await manager.shared({ caller: CONSOLE, user: { uid: ALICE } })).toEqual([]);
  });

  it("lets a recipient publish only with the publish preset, and re-checks it on every view", async () => {
    const publish = () => policy.createPublication({ caller: GATEWAY, user: { uid: ALICE }, connectionId: "conn-1", taskId: "task-1", lang: "0176", artifactInvocationId: "inv-a" });
    await share("save");
    await denied(publish(), "publish-not-granted");
    await share("publish");
    const { publicationId } = await publish();
    await expect(policy.authorizeView({ caller: GATEWAY, publicationId })).resolves.toMatchObject({ publisherUid: ALICE });
    await share("save");
    await denied(policy.authorizeView({ caller: GATEWAY, publicationId }), "publish-not-granted");
  });

  it("deletes a connection's grants with it", async () => {
    await share("save");
    await manager.remove({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1" });
    expect(await grants.listByConnection("conn-1")).toEqual([]);
  });
});
