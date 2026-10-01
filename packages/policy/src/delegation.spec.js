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
const SAVE = [{ lang: "0176", fn: "save-to-itembank" }];
const share = (over = {}) => manager.share({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", recipientUid: ALICE, permissions: SAVE, ...over });
const invoke = uid => policy.allocateInvocation({ caller: GATEWAY, user: { uid }, connectionId: "conn-1", taskId: "task-1", inputDigest: hash("in") });
const snap = async uid => policy.snapshot({
  caller: L0176, user: { uid }, lang: "0176", connectionId: "conn-1", fns: ALL_FNS, invocationToken: (await invoke(uid)).invocationToken, stage: "s0"
});
const mint = (sessionToken, fn, op) => policy.mint({ caller: L0176, sessionToken, fn, op, occurrenceId: "n1.0", argsDigest: hash("args") });

describe("delegation", () => {
  it("lets a recipient use the functions granted, with rendering, never Author", async () => {
    await denied(invoke(ALICE), "not-owner");
    await share();
    const { allowed, sessionToken } = await snap(ALICE);
    expect(allowed).toEqual(["preview-itembank", "save-to-itembank"]);
    await expect(mint(sessionToken, "save-to-itembank", "learnosity.write-items")).resolves.toBeTruthy();
    await denied(mint(sessionToken, "author-itembank", "learnosity.sign-author"), "fn-not-in-session");
  });

  it("never reaches Author even through a grant that names it", async () => {
    await share();
    const id = grantIdFor({ connectionId: "conn-1", recipientUid: ALICE });
    await grants.put({ ...(await grants.get(id)), permissions: ALL_FNS.map(fn => ({ lang: "0176", fn })) });
    expect((await snap(ALICE)).allowed).toEqual(["preview-itembank", "save-to-itembank"]);
  });

  it("stops the recipient's next call once revoked or expired", async () => {
    const { grantId } = await share();
    const { sessionToken } = await snap(ALICE);
    await manager.revoke({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", grantId });
    await denied(mint(sessionToken, "save-to-itembank", "learnosity.write-items"), "not-owner");
    await denied(invoke(ALICE), "not-owner");
    await grants.put({ grantId, connectionId: "conn-1", ownerUid: OWNER, recipientUid: ALICE, permissions: SAVE, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await denied(invoke(ALICE), "not-owner");
  });

  it("lets only the owner share, list and revoke, and a recipient cannot reshare", async () => {
    await share();
    await denied(manager.share({ caller: CONSOLE, user: { uid: ALICE }, connectionId: "conn-1", recipientUid: BOB, permissions: SAVE }), "not-owner");
    await denied(manager.grants({ caller: CONSOLE, user: { uid: ALICE }, connectionId: "conn-1" }), "not-owner");
    await denied(share({ recipientUid: OWNER }), "self-grant");
    await denied(share({ caller: L0176 }), "caller-not-entry-point");
    const list = await manager.grants({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1" });
    expect(list).toEqual([expect.objectContaining({ permissions: SAVE, pending: false })]);
  });

  it("holds a share to an email until that person claims it", async () => {
    await share({ recipientUid: null, recipientEmailHash: hash("alice@example.com"), recipientLabel: "alice@example.com" });
    expect((await manager.grants({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1" }))[0]).toMatchObject({ pending: true, recipientLabel: "alice@example.com" });
    await denied(invoke(ALICE), "not-owner");
    expect(await manager.claim({ caller: CONSOLE, user: { uid: ALICE }, emailHashes: [hash("alice@example.com")] })).toEqual({ claimed: 1 });
    expect((await snap(ALICE)).allowed).toEqual(["preview-itembank", "save-to-itembank"]);
    expect(await manager.claim({ caller: CONSOLE, user: { uid: BOB }, emailHashes: [hash("alice@example.com")] })).toEqual({ claimed: 0 });
  });

  it("lists shared connections for the recipient, and lets them leave", async () => {
    await share();
    expect(await manager.shared({ caller: CONSOLE, user: { uid: ALICE } })).toEqual([{
      connectionId: "conn-1",
      backend: "learnosity",
      status: "active",
      label: "Bank",
      ownerUid: OWNER,
      permissions: SAVE,
      expiresAt: null
    }]);
    await manager.leave({ caller: CONSOLE, user: { uid: ALICE }, connectionId: "conn-1" });
    expect(await manager.shared({ caller: CONSOLE, user: { uid: ALICE } })).toEqual([]);
  });

  it("never lets a recipient publish", async () => {
    await share();
    await denied(policy.createPublication({ caller: GATEWAY, user: { uid: ALICE }, connectionId: "conn-1", taskId: "task-1", lang: "0176", artifactInvocationId: "inv-a" }), "publish-not-granted");
  });

  it("deletes a connection's grants with it", async () => {
    await share();
    await manager.remove({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1" });
    expect(await grants.listByConnection("conn-1")).toEqual([]);
  });

  describe("permissions are (language, function) pairs", () => {
    it("lists the delegable functions, rendering included, never Author", async () => {
      const list = await manager.shareable({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1" });
      expect(list).toEqual([
        { lang: "0176", fn: "preview-itembank", kind: "sign" },
        { lang: "0176", fn: "save-to-itembank", kind: "write" },
      ]);
      await denied(manager.shareable({ caller: CONSOLE, user: { uid: ALICE }, connectionId: "conn-1" }), "not-owner");
    });

    it("normalizes the language", async () => {
      const g = await share({ permissions: [{ lang: "L0176", fn: "save-to-itembank" }] });
      expect(g.permissions).toEqual(SAVE);
    });

    it("refuses Author, an unknown function, another language or nothing", async () => {
      await denied(share({ permissions: [{ lang: "0176", fn: "author-itembank" }] }), "bad-permissions");
      await denied(share({ permissions: [{ lang: "0176", fn: "made-up" }] }), "bad-permissions");
      await denied(share({ permissions: [{ lang: "0158", fn: "save-to-itembank" }] }), "bad-permissions");
      await denied(share({ permissions: [] }), "bad-permissions");
    });

    it("can grant rendering alone: previews, never a save", async () => {
      await share({ permissions: [{ lang: "0176", fn: "preview-itembank" }] });
      const { allowed, sessionToken } = await snap(ALICE);
      expect(allowed).toEqual(["preview-itembank"]);
      await expect(mint(sessionToken, "preview-itembank", "learnosity.sign-items-preview")).resolves.toBeTruthy();
      await denied(mint(sessionToken, "save-to-itembank", "learnosity.write-items"), "fn-not-in-session");
    });

    it("never lets a pair for one language cover another's function of the same name", async () => {
      await share();
      const id = grantIdFor({ connectionId: "conn-1", recipientUid: ALICE });
      await grants.put({ ...(await grants.get(id)), permissions: [{ lang: "0158", fn: "save-to-itembank" }] });
      expect((await snap(ALICE)).allowed).toEqual([]);
    });

    it("gives a grant with no permissions nothing", async () => {
      await share();
      const id = grantIdFor({ connectionId: "conn-1", recipientUid: ALICE });
      const { permissions: _p, ...legacy } = await grants.get(id);
      await grants.put({ ...legacy, fns: ["save-to-itembank"] });
      expect((await snap(ALICE)).allowed).toEqual([]);
    });

    it("lets the owner edit a grant's end date; only the owner, only an existing grant", async () => {
      const { grantId } = await share();
      const until = new Date(Date.now() + 86400000).toISOString();
      expect(await manager.update({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", grantId, permissions: SAVE, expiresAt: until }))
        .toMatchObject({ grantId, permissions: SAVE, expiresAt: until });
      await denied(manager.update({ caller: CONSOLE, user: { uid: ALICE }, connectionId: "conn-1", grantId, permissions: SAVE }), "not-owner");
      await denied(manager.update({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", grantId: "nope", permissions: SAVE }), "grant-not-found");
      await denied(manager.update({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", grantId, permissions: [] }), "bad-permissions");
    });
  });
});

describe("the owner's own permissions", () => {
  const PREVIEW = [{ lang: "0176", fn: "preview-itembank" }];
  const setOwn = (permissions, over = {}) =>
    manager.setOwnerPermissions({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", permissions, ...over });

  it("default to everything, Author included", async () => {
    expect((await snap(OWNER)).allowed).toEqual(ALL_FNS);
    expect((await manager.list({ caller: CONSOLE, user: { uid: OWNER } }))[0].ownerPermissions).toBeNull();
  });

  it("lists every function on the backend for the owner's list, marking implicit and delegable", async () => {
    expect(await manager.functions({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1" })).toEqual([
      { lang: "0176", fn: "author-itembank", kind: "sign", implicit: false, delegable: false },
      { lang: "0176", fn: "preview-itembank", kind: "sign", implicit: true, delegable: true },
      { lang: "0176", fn: "save-to-itembank", kind: "write", implicit: false, delegable: true },
    ]);
    await denied(manager.functions({ caller: CONSOLE, user: { uid: ALICE }, connectionId: "conn-1" }), "not-owner");
  });

  it("narrowed to previews: previews sign, a save is refused, even mid-session", async () => {
    const { sessionToken } = await snap(OWNER);
    expect(await setOwn(PREVIEW)).toEqual({ connectionId: "conn-1", ownerPermissions: PREVIEW });
    await denied(mint(sessionToken, "save-to-itembank", "learnosity.write-items"), "not-granted");
    const narrowed = await snap(OWNER);
    expect(narrowed.allowed).toEqual(["preview-itembank"]);
    await expect(mint(narrowed.sessionToken, "preview-itembank", "learnosity.sign-items-preview")).resolves.toBeTruthy();
  });

  it("may keep Author, which no grant reaches, and rendering comes with it", async () => {
    await setOwn([{ lang: "0176", fn: "author-itembank" }]);
    expect((await snap(OWNER)).allowed).toEqual(["preview-itembank", "author-itembank"]);
  });

  it("an empty list leaves the owner nothing; null restores everything", async () => {
    await setOwn([]);
    expect((await snap(OWNER)).allowed).toEqual([]);
    await setOwn(null);
    expect((await snap(OWNER)).allowed).toEqual(ALL_FNS);
  });

  it("is independent of sharing: the owner can share what they don't use", async () => {
    await setOwn(PREVIEW);
    await share();
    expect((await snap(ALICE)).allowed).toEqual(["preview-itembank", "save-to-itembank"]);
    expect((await snap(OWNER)).allowed).toEqual(["preview-itembank"]);
  });

  it("only the owner sets them, only from the backend's functions", async () => {
    await denied(setOwn(PREVIEW, { user: { uid: ALICE } }), "not-owner");
    await denied(setOwn(PREVIEW, { caller: L0176 }), "caller-not-entry-point");
    await denied(setOwn([{ lang: "0176", fn: "made-up" }]), "bad-permissions");
    await denied(setOwn([{ lang: "0158", fn: "save-to-itembank" }]), "bad-permissions");
    await denied(setOwn("everything"), "bad-permissions");
    expect((await setOwn([{ lang: "L0176", fn: "preview-itembank" }])).ownerPermissions).toEqual(PREVIEW);
  });

  it("survive disabling and re-reading the connection", async () => {
    await setOwn(PREVIEW);
    await manager.disable({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1" });
    expect((await connections.get("conn-1")).ownerPermissions).toEqual(PREVIEW);
  });
});

describe("the configured system connection", () => {
  let sysPolicy;
  let sysManager;
  beforeEach(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
    const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
    const audit = createAudit({ sink: () => {}, pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
    const systemConnections = { learnosity: "conn-1" };
    sysPolicy = createPolicy({
      signer, jwks, connections, grants, audit, systemConnections, invocations: createMemoryInvocationStore(), publications: createMemoryPublicationStore()
    });
    sysManager = createConnectionManager({ connections, grants, audit, systemConnections, brokerAdmin: { createSecret: async () => {}, rotateSecret: async () => {}, deleteSecret: async () => {} } });
  });
  const sysInvoke = uid => sysPolicy.allocateInvocation({ caller: GATEWAY, user: { uid }, connectionId: "conn-1", taskId: "task-1", inputDigest: hash("in") });

  it("is not an ordinary connection, even for its owner: no invocation, so no write, Author or publication", async () => {
    await denied(sysInvoke(OWNER), "system-connection");
    await denied(sysPolicy.createPublication({
      caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: "task-1", lang: "0176", artifactInvocationId: "inv-1"
    }), "system-connection");
  });

  it("cannot be shared, and a grant made before it became the system connection reaches nothing", async () => {
    await denied(sysManager.share({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", recipientUid: ALICE, permissions: SAVE }), "system-connection");
    await grants.put({ grantId: grantIdFor({ connectionId: "conn-1", recipientUid: ALICE }), connectionId: "conn-1", ownerUid: OWNER, recipientUid: ALICE, permissions: SAVE });
    await denied(sysManager.update({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", grantId: grantIdFor({ connectionId: "conn-1", recipientUid: ALICE }), permissions: SAVE }), "system-connection");
    await denied(sysInvoke(ALICE), "system-connection");
  });

  it("cannot have owner permissions set", async () => {
    await denied(sysManager.setOwnerPermissions({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", permissions: null }), "system-connection");
  });

  it("still serves system preview sessions", async () => {
    const { allowed } = await sysPolicy.previewSession({ caller: L0176, lang: "0176" });
    expect(allowed).toEqual(["preview-itembank"]);
  });
});
