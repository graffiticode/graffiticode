/* eslint-disable camelcase -- Google ID-token fields are snake_case */
// C5 (COMMAND_SCOPES; docs/c5-l0013-commands-plan.md): the api's real Policy
// client against Policy over HTTP. One capability setting decides every
// ownership call (allocation, admission, lease and takeover, and the due
// query), and with it off every request is exactly what it was before C5.
import http from "node:http";
import { generateKeyPair, exportJWK } from "jose";
import { encodeChainId } from "@graffiticode/common/chain";
import { canonicalDigest } from "@graffiticode/common/canonical";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import {
  createPolicy,
  createPolicyApp,
  createConnectionManager,
  createCallerIdentity,
  createLocalSigner,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryLeaseFence,
  createMemoryApprovals,
  createMemoryPublicationStore,
  createMemoryGrantStore,
  createMemoryCommandStore,
  createMemoryCommandBackend,
  createCommandRecords,
  createProtectedSwitch,
  createMemoryItemAuthority,
  COMMAND_LEASE_MS,
} from "@graffiticode/policy";
import { createMemoryReceiptStore, createReceiptReader } from "@graffiticode/broker";
import { buildCommandWorker } from "./worker.js";
import { buildPolicyCommands, PolicyRefused } from "./policy-commands.js";

const OWNER = "0xowner";
const OTHER = "0xother";
const GATEWAY = "api-run@graffiticode.iam.gserviceaccount.com";
const PRIVATE = "privateItem00000001";
const PUBLIC = "publicItem000000001";
const hex = c => c.repeat(64);
const IMAGES = { "0000": `sha256:${hex("0")}`, "0013": `sha256:${hex("3")}`, "0176": `sha256:${hex("1")}` };
const REVISION = { "0000": "l0000r-r1", "0013": "l0013r-r1", "0176": "l0176r-r1" };
const FNS = { "0000": [], "0013": ["snap"], "0176": ["save-to-itembank", "init"] };
const snap = item => ({ id: "snap", fn: "snap", op: "gcs.put-thumbnail", occurrences: ["n0.0"], scope: { kind: "item", id: item } });

const b64 = v => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const idTokenFor = account => async audience => (audience.startsWith("urn:") ? `idt|${account}|${audience}` : `${b64("{}")}.${b64({ email: account })}.`);
const verifyIdToken = async (token, audience) => {
  const [kind, email, aud] = token.split("|");
  if (kind !== "idt" || aud !== audience) throw new Error("bad token");
  return { iss: "https://accounts.google.com", email, email_verified: true, aud };
};
const verifyUser = async token => { if (!token.startsWith("user:")) throw new Error("bad user token"); return { uid: token.slice(5) }; };

const openServers = [];
const listen = handler => new Promise(resolve => {
  const server = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`));
  openServers.push(server);
});
afterEach(async () => {
  const servers = openServers.splice(0);
  await Promise.all(servers.map(s => new Promise(resolve => { s.closeAllConnections?.(); s.close(() => resolve()); })));
});

let policyUrl;
let commandStore;
let clock;
let keys = 0;
// Every request the api's client sent: [method, path, body].
let sent;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  clock = Date.now();
  sent = [];
  const leases = new Map();
  const invocations = createMemoryInvocationStore({ leases });
  commandStore = createMemoryCommandStore({ invocationStore: invocations });
  const connections = createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]);
  /** @type {(lang: string, versions: number[]) => [string, any]} */
  const approved = (lang, versions) => [`${lang}/${REVISION[lang]}`, { lang, revision: REVISION[lang], imageDigest: IMAGES[lang], tag: `t-${lang}`, tagUrl: `https://t-${lang}`, status: "approved", contractVersions: versions }];
  const policy = createPolicy({
    signer,
    jwks,
    connections,
    invocations,
    commands: commandStore,
    commandRecords: createCommandRecords({ backend: createMemoryCommandBackend({ commandStore }), now: () => clock }),
    brokerReceipts: createReceiptReader({ receipts: createMemoryReceiptStore() }),
    publications: createMemoryPublicationStore(),
    audit: async () => {},
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    approvals: createMemoryApprovals(new Map([approved("0000", [1, 2]), approved("0013", [3]), approved("0176", [1, 2])])),
    fence: createMemoryLeaseFence({ leases, now: () => clock }),
    itemAuthority: createMemoryItemAuthority({ [PRIVATE]: { ownerUid: OWNER, isPublic: false }, [PUBLIC]: { ownerUid: OWNER, isPublic: true } }),
    now: () => clock,
  });
  policyUrl = await listen(createPolicyApp({
    policy,
    verifyUser,
    publicJwks: jwks,
    audit: async () => {},
    manager: createConnectionManager({ connections, grants: createMemoryGrantStore(), audit: async () => {}, brokerAdmin: {} }),
    identifyCaller: createCallerIdentity({ verifyIdToken, audience: "urn:graffiticode:policy", callers: { [GATEWAY]: { role: "gateway" } } }),
    log: () => {},
  }));
});

// The api's own client, as app.js builds it, with a fetch that records what
// it sends.
const client = ({ scopes }) => buildPolicyCommands({
  policyUrl,
  idToken: idTokenFor(GATEWAY),
  scopes,
  fetch: /** @type {any} */ async (url, init) => {
    const u = new URL(url);
    sent.push([init.method, `${u.pathname}${u.search}`, init.body ? JSON.parse(init.body) : null, Boolean(init.headers?.Authorization)]);
    return fetch(url, init);
  },
});

// A chain of `langs` (s0 the head) capturing `item`, allocated by `as`.
const allocate = (c, { langs, item = PRIVATE, uid = OWNER, anonymous = false, connectionId = null }) => {
  const taskIds = langs.map((_l, i) => `task-${i}`);
  return c.allocate({
    authToken: anonymous ? null : `user:${uid}`,
    connectionId,
    taskId: encodeChainId(taskIds),
    inputDigest: hex("9"),
    idempotencyKey: `job-${++keys}`,
    lang: langs[0],
    request: JSON.stringify({ id: encodeChainId(taskIds), connectionId, options: {} }),
    worker: "api-1",
    anonymous,
  }).then(out => ({ ...out, langs, item }));
};

// The worker with the real client. Its L0013 stage stops for something
// temporary once its session is issued (as a capture waiting on its
// reservation would), so a test sees admission and ownership without a
// Broker.
const runWorker = (cmd, c, { generation, worker = "api-1" }) => {
  const tasks = cmd.langs.map(lang => ({ lang, code: { root: lang } }));
  return buildCommandWorker({
    policy: c,
    taskStorer: { get: async () => tasks },
    language: {
      baseUrlFor: async lang => `https://${lang}.example`,
      model: async ({ lang }) => ({ model: { lang, kind: "plan", carried: {}, intents: lang === "0013" ? [snap(cmd.item)] : [] }, revision: REVISION[lang] }),
      preflight: async ({ stage, code }) => {
        const lang = code.root;
        return { manifest: { stage, lang, sourceDigest: canonicalDigest(code), programDigest: hex(stage.slice(1)), optionsDigest: hex("d"), revision: REVISION[lang], imageDigest: IMAGES[lang], registryVersion: lang === "0000" ? 0 : REGISTRY_VERSION, requiredFunctions: FNS[lang] } };
      },
      start: async () => ({ resume: { reason: "reservation-pending" } }),
      interpret: async () => ({ data: {}, errors: [] }),
    },
    artifactStorer: {},
    worker,
    setInterval: () => null,
    clearInterval: () => {},
    log: () => {},
  })({ commandId: cmd.commandId, generation });
};
const record = id => commandStore.commands.get(id);

describe("COMMAND_SCOPES=on: the real client declares scopes on every ownership call", () => {
  it("allocates, admits and owns a connectionless L0013 capture by its owner", async () => {
    const scoped = client({ scopes: true });
    const cmd = await allocate(scoped, { langs: ["0013"] });
    expect(cmd).toMatchObject({ protocol: "command", owned: true, ownerUid: null });
    expect(await runWorker(cmd, scoped, { generation: 1 })).toMatchObject({ status: "pending", resume: true });
    expect(record(cmd.commandId)).toMatchObject({ connectionId: null, scopes: 1, phase: "admitted", owner: { scopes: 1 } });
    const calls = sent.filter(([, path]) => /\/v1\/commands(\/[^/]+\/(admit|lease))?$/.test(path.split("?")[0]));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [, path, body] of calls) expect([path, body?.scopes]).toEqual([path, 1]);
  });

  it("runs an L0000 head over an L0013 capture as one connectionless v3 command", async () => {
    const scoped = client({ scopes: true });
    const cmd = await allocate(scoped, { langs: ["0000", "0013"] });
    await runWorker(cmd, scoped, { generation: 1 });
    const admitted = record(cmd.commandId);
    expect(admitted).toMatchObject({ connectionId: null, scopes: 1, phase: "admitted" });
    expect(Object.keys(admitted.admission.stages).sort()).toEqual(["s0", "s1"]);
    expect(admitted.admission.stages.s1.intents).toEqual([expect.objectContaining({ fn: "snap", scope: { kind: "item", id: PRIVATE } })]);
  });

  it("fails a non-owner's private capture at admission", async () => {
    const scoped = client({ scopes: true });
    const cmd = await allocate(scoped, { langs: ["0013"], uid: OTHER });
    expect(await runWorker(cmd, scoped, { generation: 1 })).toMatchObject({ status: "failed" });
    expect(record(cmd.commandId)).toMatchObject({ admissionRefusal: { reason: "not-owner" } });
  });

  it("allocates an anonymous capture with no user token, admitted only for a public item", async () => {
    const scoped = client({ scopes: true });
    const pub = await allocate(scoped, { langs: ["0013"], item: PUBLIC, anonymous: true });
    expect(sent.at(-1)).toEqual(["POST", "/v1/commands", expect.objectContaining({ anonymous: true, connectionId: null, scopes: 1 }), false]);
    expect(record(pub.commandId).uid).toBe("anonymous");
    await runWorker(pub, scoped, { generation: 1 });
    expect(record(pub.commandId)).toMatchObject({ phase: "admitted" });
    const priv = await allocate(scoped, { langs: ["0013"], item: PRIVATE, anonymous: true });
    await runWorker(priv, scoped, { generation: 1 });
    expect(record(priv.commandId)).toMatchObject({ status: "failed", admissionRefusal: { reason: "not-owner" } });
  });

  it("lists and hands over a v3 command only to a client that declares scopes", async () => {
    const scoped = client({ scopes: true });
    const unscoped = client({ scopes: false });
    const cmd = await allocate(scoped, { langs: ["0013"] });
    await runWorker(cmd, scoped, { generation: 1 });
    clock += COMMAND_LEASE_MS + 1;
    expect((await unscoped.due()).commands.map(d => d.commandId)).not.toContain(cmd.commandId);
    expect((await scoped.due()).commands.map(d => d.commandId)).toContain(cmd.commandId);
    await expect(unscoped.lease({ commandId: cmd.commandId, worker: "old-api", generation: 1, takeOver: true })).rejects.toMatchObject({ reason: "worker-unsupported" });
    expect(await scoped.lease({ commandId: cmd.commandId, worker: "api-2", generation: 1, takeOver: true })).toMatchObject({ generation: 2 });
    expect(record(cmd.commandId).owner).toMatchObject({ worker: "api-2", generation: 2, scopes: 1 });
  });

  it("is refused a connectionless command by Policy when the client doesn't declare scopes", async () => {
    const err = await allocate(client({ scopes: false }), { langs: ["0013"] }).catch(e => e);
    expect(err).toBeInstanceOf(PolicyRefused);
    expect(err.reason).toBe("worker-unsupported");
  });
});

describe("COMMAND_SCOPES off: every request is what it was before C5", () => {
  it("sends allocation, lease, admission and the due query unchanged", async () => {
    const unscoped = client({ scopes: false });
    const cmd = await unscoped.allocate({ authToken: `user:${OWNER}`, connectionId: "conn-1", taskId: encodeChainId(["t0"]), inputDigest: hex("9"), idempotencyKey: "save:1", lang: "0176", request: "{\"id\":\"x\"}", worker: "api-1" });
    await unscoped.lease({ commandId: cmd.commandId, worker: "api-1", generation: 1 });
    await unscoped.admit({ commandId: cmd.commandId, generation: 1, taskIds: [], stages: [], recording: 1 }).catch(() => null);
    await unscoped.due();
    expect(sent.map(([method, path, body, user]) => [method, path.replace(cmd.commandId, "{id}").replace(encodeURIComponent(cmd.commandId), "{id}"), body, user])).toEqual([
      ["POST", "/v1/commands", { connectionId: "conn-1", taskId: encodeChainId(["t0"]), inputDigest: hex("9"), idempotencyKey: "save:1", lang: "0176", request: "{\"id\":\"x\"}", worker: "api-1", create: true }, true],
      ["POST", "/v1/commands/{id}/lease", { worker: "api-1", generation: 1, takeOver: false, recording: 1, repairs: 1 }, false],
      ["POST", "/v1/commands/{id}/admit", { generation: 1, taskIds: [], stages: [], recording: 1 }, false],
      ["GET", "/v1/commands-due?limit=20&recording=1&repairs=1", null, false],
    ]);
  });
});
