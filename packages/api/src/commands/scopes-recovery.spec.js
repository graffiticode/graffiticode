// C5a slice 3a, the owner's review of #402: a command an older worker can't
// own never reaches it, and a temporary refusal never fails a command. The
// command worker runs against an in-process Policy, its refusals mapped as
// the HTTP client maps them (policy-commands.js).
import { generateKeyPair, exportJWK } from "jose";
import { encodeChainId } from "@graffiticode/common/chain";
import { canonicalDigest } from "@graffiticode/common/canonical";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import {
  createPolicy,
  PolicyDenied,
  PolicyUnavailable as PolicyCantDecide,
  createLocalSigner,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryLeaseFence,
  createMemoryApprovals,
  createMemoryPublicationStore,
  createMemoryCommandStore,
  createMemoryCommandBackend,
  createCommandRecords,
  createProtectedSwitch,
  createMemoryItemAuthority,
  COMMAND_LEASE_MS,
} from "@graffiticode/policy";
import { buildCommandWorker } from "./worker.js";
import { buildPolicyCommands, PolicyRefused, PolicyUnavailable } from "./policy-commands.js";

const OWNER = "0xowner";
const OTHER = "0xother";
const GATEWAY = { role: "gateway" };
const PRIVATE = "privateItem00000001";
const hex = c => c.repeat(64);
const IMAGES = { "0013": `sha256:${hex("3")}`, "0176": `sha256:${hex("1")}` };
const REVISION = { "0013": "l0013r-r1", "0176": "l0176r-r1" };
const FNS = { "0013": ["snap"], "0176": ["save-to-itembank", "init"] };
const SNAP = { id: "snap", fn: "snap", op: "gcs.put-thumbnail", occurrences: ["n0.0"], scope: { kind: "item", id: PRIVATE } };
const SAVE = { id: "save", fn: "save-to-itembank", op: "learnosity.write-items", occurrences: ["n1.0"] };
const INTENTS = { "0013": [SNAP], "0176": [SAVE] };
/** @type {(lang: string, versions: number[]) => [string, any]} */
const approved = (lang, versions) => [`${lang}/${REVISION[lang]}`, { lang, revision: REVISION[lang], imageDigest: IMAGES[lang], tag: `t-${lang}`, tagUrl: `https://t-${lang}`, status: "approved", contractVersions: versions }];

let policy;
let commandStore;
let items;
let clock;
let keys = 0;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  clock = Date.now();
  const leases = new Map();
  const invocationStore = createMemoryInvocationStore({ leases });
  commandStore = createMemoryCommandStore({ invocationStore });
  items = createMemoryItemAuthority({ [PRIVATE]: { ownerUid: OWNER, isPublic: false } });
  policy = createPolicy({
    signer,
    jwks,
    connections: createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]),
    invocations: invocationStore,
    commands: commandStore,
    commandRecords: createCommandRecords({ backend: createMemoryCommandBackend({ commandStore }), now: () => clock }),
    publications: createMemoryPublicationStore(),
    audit: async () => {},
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    approvals: createMemoryApprovals(new Map([approved("0013", [3]), approved("0176", [1, 2])])),
    fence: createMemoryLeaseFence({ leases, now: () => clock }),
    itemAuthority: items,
    now: () => clock,
  });
});

// A command over `langs` (s0 the head), allocated by a worker declaring
// `scopes`, its models not yet installed.
const allocate = async ({ langs, uid = OWNER, connectionId = "conn-1", scopes = 0 }) => {
  const taskIds = langs.map((_l, i) => `task-${i}`);
  const out = await policy.allocateCommand({
    caller: GATEWAY, user: { uid }, connectionId, taskId: encodeChainId(taskIds), inputDigest: hex("9"), idempotencyKey: `job-${++keys}`, lang: langs[0], request: "{}", worker: "api-1", scopes,
  });
  return { ...out, langs };
};

// The worker, as an api that declares `scopes` (or not), with Policy's
// refusals mapped as the HTTP client maps them.
const runWorker = (c, { generation, scopes, worker = "api" }) => {
  const asHttp = fn => async args => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof PolicyCantDecide) throw new PolicyUnavailable(e.reason);
      if (e instanceof PolicyDenied) throw new PolicyRefused(e.reason);
      throw e;
    }
  };
  const tasks = c.langs.map(lang => ({ lang, code: { root: lang } }));
  const write = fn => asHttp(({ commandId, generation: g, ...args }) => policy.commandWrite({ caller: GATEWAY, commandId, generation: g, fn, args }));
  return buildCommandWorker({
    policy: {
      read: asHttp(args => policy.commandRead({ caller: GATEWAY, ...args })),
      installModel: write("installModel"),
      admit: asHttp(args => policy.admitCommand({ caller: GATEWAY, ...args, scopes })),
      finish: write("finish"),
      lease: asHttp(args => policy.leaseCommand({ caller: GATEWAY, ...args, recording: 1, repairs: 1, scopes })),
    },
    taskStorer: { get: async () => tasks },
    language: {
      baseUrlFor: async lang => `https://${lang}.example`,
      model: async ({ lang }) => ({ model: { lang, kind: "plan", carried: {}, intents: INTENTS[lang] }, revision: REVISION[lang] }),
      preflight: async ({ stage, code }) => {
        const lang = code.root;
        return { manifest: { stage, lang, sourceDigest: canonicalDigest(code), programDigest: hex(stage.slice(1)), optionsDigest: hex("d"), revision: REVISION[lang], imageDigest: IMAGES[lang], registryVersion: REGISTRY_VERSION, requiredFunctions: FNS[lang] } };
      },
    },
    artifactStorer: {},
    worker,
    setInterval: () => null,
    clearInterval: () => {},
    log: () => {},
  })({ commandId: c.commandId, generation });
};
const due = async scopes => (await policy.dueCommands({ caller: GATEWAY, recording: 1, repairs: 1, scopes })).commands.map(d => d.commandId);

describe("a command an older worker can't own never reaches it", () => {
  it("leaves a mixed command pending, out of older sweepers' reach, when an older worker owned it from before its models", async () => {
    // An older worker holds a connection command from before its models.
    const c = await allocate({ langs: ["0013", "0176"] });
    await expect(runWorker(c, { generation: 1, scopes: 0, worker: "old-api" })).rejects.toBeInstanceOf(PolicyUnavailable);
    const state = commandStore.commands.get(c.commandId);
    expect(state).toMatchObject({ status: "pending", phase: "initializing", scopes: 1 });
    expect(state).not.toHaveProperty("admissionRefusal");
    clock += COMMAND_LEASE_MS + 1;
    expect(await due(0)).not.toContain(c.commandId);
    expect(await due(1)).toContain(c.commandId);
    // A worker that runs v3 commands takes it over.
    expect(await policy.leaseCommand({ caller: GATEWAY, commandId: c.commandId, worker: "new-api", generation: 1, takeOver: true, recording: 1, repairs: 1, scopes: 1 })).toMatchObject({ generation: 2, status: "pending" });
  });

  it("never lists a mixed command to an older sweeper once its models are installed", async () => {
    const c = await allocate({ langs: ["0013", "0176"], scopes: 1 });
    // The new worker installs the models, then dies before admission.
    for (const [i, lang] of c.langs.entries()) {
      await policy.commandWrite({ caller: GATEWAY, commandId: c.commandId, generation: 1, fn: "installModel", args: { stage: `s${i}`, text: JSON.stringify({ lang, kind: "plan", carried: {}, intents: INTENTS[lang] }) } });
    }
    clock += COMMAND_LEASE_MS + 1;
    expect(await due(0)).not.toContain(c.commandId);
    await expect(policy.leaseCommand({ caller: GATEWAY, commandId: c.commandId, worker: "old-api", generation: 1, takeOver: true, recording: 1, repairs: 1 })).rejects.toMatchObject({ reason: "worker-unsupported" });
  });

  it("still hands an ordinary connection command to an older sweeper", async () => {
    const c = await allocate({ langs: ["0176"] });
    clock += COMMAND_LEASE_MS + 1;
    expect(await due(0)).toContain(c.commandId);
  });
});

describe("a temporary refusal never fails a command", () => {
  it("leaves the command pending through an item-authority outage, with no refusal recorded", async () => {
    const c = await allocate({ langs: ["0013"], connectionId: null, scopes: 1 });
    items.state.unavailable = true;
    await expect(runWorker(c, { generation: 1, scopes: 1 })).rejects.toBeInstanceOf(PolicyUnavailable);
    const state = commandStore.commands.get(c.commandId);
    expect(state).toMatchObject({ status: "pending", phase: "initializing" });
    expect(state).not.toHaveProperty("admissionRefusal");
  });

  it("still fails a command on a definite refusal: a non-owner's private capture", async () => {
    const c = await allocate({ langs: ["0013"], uid: OTHER, connectionId: null, scopes: 1 });
    await runWorker(c, { generation: 1, scopes: 1 });
    expect(commandStore.commands.get(c.commandId)).toMatchObject({ status: "failed", admissionRefusal: { reason: "not-owner" } });
  });
});

describe("the Policy client's retryable refusals", () => {
  const client = (status, error) => buildPolicyCommands({
    policyUrl: "https://policy.example",
    idToken: async () => "token",
    fetch: /** @type {any} */ async () => new Response(JSON.stringify({ status: "error", error, data: null }), { status }),
  });

  it("throws PolicyUnavailable for a refusal Policy marks retryable, and PolicyRefused for any other", async () => {
    const retryable = await client(503, { code: 503, reason: "item-authority-unavailable", retryable: true }).admit({ commandId: "c:x", generation: 1, taskIds: [], stages: [] }).catch(e => e);
    expect(retryable).toBeInstanceOf(PolicyUnavailable);
    expect(retryable).not.toBeInstanceOf(PolicyRefused);
    expect(retryable.reason).toBe("item-authority-unavailable");
    // Unchanged: a maintenance 503 and a 403 are refusals, as before.
    expect(await client(503, { code: 503, reason: "maintenance" }).admit({ commandId: "c:x", generation: 1, taskIds: [], stages: [] }).catch(e => e)).toBeInstanceOf(PolicyRefused);
    expect(await client(403, { code: 403, reason: "not-owner" }).admit({ commandId: "c:x", generation: 1, taskIds: [], stages: [] }).catch(e => e)).toBeInstanceOf(PolicyRefused);
  });
});
