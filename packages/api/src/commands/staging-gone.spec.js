// C5d's `staging-gone` phase, end to end (docs/c5d-refusal-and-hold-plan.md
// §4, docs/c5d-staging-gone-finding.md): the command worker and sweeper, an
// in-process Policy (registry 10) and Broker over memory stores, Policy's
// staging store read by Broker, and an L0013 stub doing what the Rust
// capture does under a command (reserve, stage unless staged, then bind, mint
// and execute; `exit-after-stage` at generation 1).
//
// Generation 1 stages and exits; the staged object is deleted; a sweep takes
// the command over. Broker refuses the capture definitely and records the
// refusal as the operation's outcome, so the command finishes `failed`, with
// nothing published, and is never due again. Before C5d it stayed pending,
// retried every sweep. A staging outage instead stays temporary: the command
// stays pending, and completes once staging reads again.
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
  createMemoryStagingStore,
  COMMAND_LEASE_MS
} from "@graffiticode/policy";
import {
  createBroker,
  BrokerRefused,
  buildThumbnailOperations,
  createMemoryOnceStore,
  createMemoryReceiptStore,
  createMemoryActivityStore,
  createMemorySecretStore,
  createReceiptReader,
  localAuthorizer,
  sha256Hex,
  argsDigest
} from "@graffiticode/broker";
import { buildCommandWorker } from "./worker.js";
import { buildSweep } from "./sweep.js";
import { PolicyRefused, PolicyUnavailable } from "./policy-commands.js";
import { buildMemoryArtifactStorer } from "../storage/artifacts.js";

const OWNER = "0xowner";
const GATEWAY = { role: "gateway" };
const L0013 = { role: "compiler", lang: "0013" };
const ITEM = "privateItem00000001";
const hex = c => c.repeat(64);
const IMAGE = `sha256:${hex("3")}`;
const REVISION = "l0013r-r1";
const SNAP = { id: "snap", fn: "snap", op: "gcs.put-thumbnail", occurrences: ["n0.0"], scope: { kind: "item", id: ITEM } };
const PNG = new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("capture")]));

let clock;
let policy;
let staging;
let receipts;
let uploads;
let exitAt;
let lines;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  clock = Date.now();
  uploads = 0;
  lines = [];
  // The drive's fault: exit-after-stage, at generation 1 only.
  exitAt = 1;
  const leases = new Map();
  const invocations = createMemoryInvocationStore({ leases });
  const commandStore = createMemoryCommandStore({ invocationStore: invocations });
  staging = createMemoryStagingStore();
  receipts = createMemoryReceiptStore();
  const protectedSwitch = createProtectedSwitch({ readFlag: async () => ({ enabled: true }) });
  policy = createPolicy({
    signer,
    jwks,
    connections: createMemoryConnectionStore([]),
    invocations,
    commands: commandStore,
    commandRecords: createCommandRecords({ backend: createMemoryCommandBackend({ commandStore }), now: () => clock }),
    brokerReceipts: createReceiptReader({ receipts }),
    publications: createMemoryPublicationStore(),
    audit: async () => {},
    protectedSwitch,
    approvals: createMemoryApprovals(new Map([[`0013/${REVISION}`, { lang: "0013", revision: REVISION, imageDigest: IMAGE, tag: "t", tagUrl: "https://t-0013", status: "approved", contractVersions: [3] }]])),
    fence: createMemoryLeaseFence({ leases, now: () => clock }),
    itemAuthority: createMemoryItemAuthority({ [ITEM]: { ownerUid: OWNER, isPublic: false, taskId: "itemTask" } }),
    staging,
    now: () => clock
  });
  broker = createBroker({
    protectedSwitch,
    jwks,
    // Broker reads the object Policy staged, from the same store.
    operations: buildThumbnailOperations({
      storage: {
        read: async (_bucket, name) => staging.read(name),
        getMetadata: async () => null,
        prepareUpload: async () => ({ send: async () => { uploads++; return { generation: "1001" }; } })
      },
      buckets: { thumbnails: "graffiticode-c5a-gate", staging: "graffiticode-command-staging" },
      attempts: 4
    }),
    once: createMemoryOnceStore(),
    receipts,
    activity: createMemoryActivityStore(),
    secrets: createMemorySecretStore({}),
    authorize: localAuthorizer(policy),
    audit: async () => {}
  });
});
let broker;

// The api's Policy client, in process, with refusals mapped as over HTTP.
const client = () => {
  const as = fn => async args => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof PolicyCantDecide) throw new PolicyUnavailable(e.reason);
      if (e instanceof PolicyDenied) throw new PolicyRefused(e.reason);
      throw e;
    }
  };
  const write = fn => as(({ commandId, generation, ...args }) => policy.commandWrite({ caller: GATEWAY, commandId, generation, fn, args }));
  const caps = { recording: 1, repairs: 1, scopes: 1 };
  return {
    read: as(({ commandId, what, stage = null }) => policy.commandRead({ caller: GATEWAY, commandId, what, stage })),
    due: as(({ limit = 20 } = {}) => policy.dueCommands({ caller: GATEWAY, limit, ...caps })),
    lease: as(({ commandId, worker, generation, takeOver = false }) => policy.leaseCommand({ caller: GATEWAY, commandId, worker, generation, takeOver, ...caps })),
    installModel: write("installModel"),
    admit: as(({ commandId, generation, taskIds, stages, recording }) => policy.admitCommand({ caller: GATEWAY, commandId, generation, taskIds, stages, recording, scopes: 1 })),
    session: as(({ commandId, generation, stage }) => policy.commandSession({ caller: GATEWAY, commandId, generation, stage })),
    installInput: write("installInput"),
    installOutput: write("installOutput"),
    closeStage: write("closeStage"),
    notReached: write("markNotReached"),
    settle: as(({ commandId, generation }) => policy.settleCommand({ caller: GATEWAY, commandId, generation })),
    lost: write("recordLost"),
    finish: write("finish"),
    published: write("published")
  };
};

// The L0013 service, as its Rust capture runs a command's snap.
const language = {
  baseUrlFor: async () => "https://svc-0013",
  model: async () => ({ model: { lang: "0013", kind: "plan", carried: {}, intents: [SNAP] }, revision: REVISION }),
  preflight: async ({ stage, code }) => ({
    manifest: { stage, lang: "0013", sourceDigest: canonicalDigest(code), programDigest: hex("c"), optionsDigest: hex("d"), revision: REVISION, imageDigest: IMAGE, registryVersion: REGISTRY_VERSION, requiredFunctions: ["snap"] }
  }),
  start: async ({ commandSession, generation }) => {
    const reserved = await policy.commandReserve({ caller: L0013, sessionToken: commandSession, occurrenceId: "n0.0", intentId: "snap" });
    if (!reserved.staged) await policy.commandStage({ caller: L0013, sessionToken: commandSession, occurrenceId: "n0.0", png: Buffer.from(PNG).toString("base64") });
    // exit-after-stage: whether this run staged or found it staged.
    if (generation === exitAt) throw new Error("capture fault exit-after-stage exited");
    const payload = { item: ITEM, captureSequence: reserved.captureSequence, sha256: sha256Hex(PNG) };
    const argd = argsDigest(payload);
    await policy.commandBind({ caller: L0013, sessionToken: commandSession, occurrenceId: "n0.0", intentId: "snap", args: JSON.stringify(payload), argd });
    const { executionToken } = await policy.mint({ caller: L0013, sessionToken: commandSession, fn: "snap", op: "gcs.put-thumbnail", occurrenceId: "n0.0", argsDigest: argd });
    const occurrences = { snap: ["n0.0"] };
    try {
      const out = await broker.execute({ caller: L0013, token: executionToken, op: "gcs.put-thumbnail", payload });
      if (out.status !== "succeeded") return { data: null, errors: [{ message: `snap failed: the capture wasn't published (${out.reason})` }], occurrences };
      return { data: { url: out.result.url, item: out.result.item }, errors: [], occurrences };
    } catch (e) {
      if (!(e instanceof BrokerRefused)) throw e;
      // The kernel: a temporary refusal of an item-scoped capture resumes
      // later; any other is the snap's error.
      if (e.status === 503) return { data: null, errors: [{ message: `snap failed: ${e.reason}` }], resume: { reason: e.reason } };
      return { data: null, errors: [{ message: `snap failed: ${e.reason}` }], occurrences };
    }
  }
};

const runner = () => {
  const artifactStorer = buildMemoryArtifactStorer();
  return ({ commandId, generation }) => {
    // The stub learns the generation it runs under, as the kernel does from its session.
    const lang = { ...language, start: args => language.start({ ...args, generation }) };
    return buildCommandWorker({ policy: client(), taskStorer: { get: async () => [{ lang: "0013", code: { root: "snap" } }] }, language: lang, artifactStorer, worker: `api-${generation}`, setInterval: () => null, clearInterval: () => {}, log: line => lines.push(line) })({ commandId, generation });
  };
};
const allocate = async () => /** @type {any} */ (await policy.allocateCommand({ caller: GATEWAY, user: { uid: OWNER }, connectionId: null, taskId: encodeChainId(["task-0"]), inputDigest: hex("9"), idempotencyKey: "drive-staging-gone", lang: "0013", request: "{}", worker: "api-1", scopes: 1 }));
const state = async commandId => policy.commandRead({ caller: GATEWAY, commandId, what: "state" });
const sweep = run => buildSweep({ policy: client(), run, worker: "sweeper", log: line => lines.push(line) })();
const due = async () => (await policy.dueCommands({ caller: GATEWAY, recording: 1, repairs: 1, scopes: 1 })).commands.map(c => c.commandId);

describe("C5d staging-gone, end to end", () => {
  it("exit-after-stage, the object deleted, a takeover: the command finishes failed, with nothing published, and is never due again", async () => {
    const run = runner();
    const { commandId, invocationId } = await allocate();
    await expect(run({ commandId, generation: 1 })).rejects.toThrow(/exit-after-stage/);
    expect([...staging.state.objects.keys()]).toEqual([expect.stringContaining(commandId)]);
    // The operator deletes the staged object.
    staging.state.objects.clear();
    clock += COMMAND_LEASE_MS + 1;
    expect(await due()).toEqual([commandId]);
    expect(await sweep(run)).toEqual({ due: 1, taken: 1, skipped: 0, failed: 0 });
    expect(await state(commandId)).toMatchObject({ status: "failed", generation: 2, publication: { state: "none" } });
    expect((await policy.commandRead({ caller: GATEWAY, commandId, what: "outcomes" })).outcomes).toEqual([
      expect.objectContaining({ stage: "s0", occurrenceId: "n0.0", outcome: "failed", final: true, source: "receipt", reason: "staging-unavailable" })
    ]);
    // Broker's receipt is the recorded refusal; nothing was published.
    const operationId = `${invocationId}/s0/n0.0`;
    expect(await receipts.getClaim(operationId)).toMatchObject({ evidence: { refused: "staging-unavailable" } });
    expect(await receipts.getOutcome(operationId)).toMatchObject({ status: "failed", steps: [], reason: "staging-unavailable" });
    expect(uploads).toBe(0);
    // Not due, and the next sweep lists nothing.
    clock += COMMAND_LEASE_MS + 1;
    expect(await due()).toEqual([]);
    expect(await sweep(run)).toEqual({ due: 0, taken: 0, skipped: 0, failed: 0 });
  });

  it("a staging outage instead stays pending, and the command completes once staging reads again", async () => {
    const run = runner();
    const { commandId, invocationId } = await allocate();
    await expect(run({ commandId, generation: 1 })).rejects.toThrow(/exit-after-stage/);
    staging.state.fail = true;
    clock += COMMAND_LEASE_MS + 1;
    expect(await sweep(run)).toMatchObject({ taken: 1, failed: 0 });
    expect(await state(commandId)).toMatchObject({ status: "pending", generation: 2 });
    expect(await receipts.getClaim(`${invocationId}/s0/n0.0`)).toBeNull();
    expect(uploads).toBe(0);
    // Staging reads again: the next sweep publishes it, once.
    staging.state.fail = false;
    clock += COMMAND_LEASE_MS + 1;
    expect(await due()).toEqual([commandId]);
    expect(await sweep(run)).toMatchObject({ taken: 1, failed: 0 });
    expect(await state(commandId)).toMatchObject({ status: "completed", generation: 3 });
    expect(uploads).toBe(1);
    clock += COMMAND_LEASE_MS + 1;
    expect(await due()).toEqual([]);
  });
});
