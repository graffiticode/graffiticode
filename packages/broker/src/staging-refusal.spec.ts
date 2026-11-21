// C5d (docs/c5d-refusal-and-hold-plan.md decisions 1–3): a definite staging
// refusal against Policy's real decisions. Policy (registry 10) authorizes
// recording it for the command's current owner, so the receipt settles the
// occurrence `failed`; a stale owner's token is denied at commandOperation,
// so it records nothing and the next owner records it.
import { generateKeyPair, exportJWK } from "jose";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { encodeChainId } from "@graffiticode/common/chain";
import {
  createPolicy,
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
  argsDigest,
} from "./index.js";

const OWNER = "0xowner";
const ITEM = "privateItem00000001";
const GATEWAY = { role: "gateway" };
const L0013 = { role: "compiler", lang: "0013" };
const hex = c => c.repeat(64);
const IMAGE = `sha256:${hex("3")}`;
const SNAP = { id: "snap", fn: "snap", op: "gcs.put-thumbnail", occurrences: ["n0.0"], scope: { kind: "item", id: ITEM } };

let clock;
let policy;
let commandStore;
let staging;
let receipts;
let broker;
let uploads;
let commandId;
let invocationId;
let payload;
let bytes;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  clock = Date.now();
  const leases = new Map();
  const invocations = createMemoryInvocationStore({ leases });
  commandStore = createMemoryCommandStore({ invocationStore: invocations });
  staging = createMemoryStagingStore();
  const protectedSwitch = createProtectedSwitch({ readFlag: async () => ({ enabled: true }) });
  policy = createPolicy({
    signer,
    jwks,
    connections: createMemoryConnectionStore([]),
    invocations,
    commands: commandStore,
    commandRecords: createCommandRecords({ backend: createMemoryCommandBackend({ commandStore }), now: () => clock }),
    publications: createMemoryPublicationStore(),
    audit: async () => {},
    protectedSwitch,
    approvals: createMemoryApprovals(new Map([["0013/l0013r-r1", { lang: "0013", revision: "l0013r-r1", imageDigest: IMAGE, tag: "t", tagUrl: "https://t", status: "approved", contractVersions: [3] }]])),
    fence: createMemoryLeaseFence({ leases, now: () => clock }),
    itemAuthority: createMemoryItemAuthority({ [ITEM]: { ownerUid: OWNER, isPublic: false, taskId: "itemTask" } }),
    staging,
    // Settlement reads Broker's receipts (B5 §7), here in process.
    brokerReceipts: query => createReceiptReader({ receipts })(query),
    now: () => clock,
  });
  ({ commandId, invocationId } = (await policy.allocateCommand({ caller: GATEWAY, user: { uid: OWNER }, taskId: encodeChainId(["task-0"]), inputDigest: hex("9"), idempotencyKey: "job-1", lang: "0013", request: "{}", worker: "api-1", scopes: 1 })) as any);
  await policy.commandWrite({ caller: GATEWAY, commandId, generation: 1, fn: "installModel", args: { stage: "s0", text: JSON.stringify({ lang: "0013", kind: "plan", carried: {}, intents: [SNAP] }) } });
  await policy.admitCommand({ caller: GATEWAY, commandId, generation: 1, taskIds: ["task-0"], scopes: 1, stages: [{ stage: "s0", lang: "0013", sourceDigest: hex("b"), programDigest: hex("c"), optionsDigest: hex("d"), revision: "l0013r-r1", imageDigest: IMAGE, registryVersion: REGISTRY_VERSION, requiredFunctions: ["snap"] }] });
  bytes = new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("staged")]));
  uploads = 0;
  // Broker reads what Policy staged, from the same store.
  const storage = {
    read: async (_bucket, name) => staging.read(name),
    getMetadata: async () => null,
    prepareUpload: async () => ({ send: async () => { uploads++; return { generation: "1001" }; } }),
  };
  receipts = createMemoryReceiptStore();
  broker = createBroker({
    protectedSwitch,
    jwks,
    operations: buildThumbnailOperations({ storage, buckets: { thumbnails: "graffiticode-c5a-gate", staging: "graffiticode-command-staging" }, attempts: 4 }),
    once: createMemoryOnceStore(),
    receipts,
    activity: createMemoryActivityStore(),
    secrets: createMemorySecretStore({}),
    authorize: localAuthorizer(policy),
    audit: async () => {},
    now: () => clock,
  });
});

// Owner `generation`'s session: reserved, staged and bound, exactly as L0013
// does (decision 9), and a minter for the occurrence.
const occurrence = async generation => {
  const { sessionToken } = await policy.commandSession({ caller: GATEWAY, commandId, generation, stage: "s0" });
  const reserved = await policy.commandReserve({ caller: L0013, sessionToken, occurrenceId: "n0.0", intentId: "snap" });
  if (!reserved.staged) await policy.commandStage({ caller: L0013, sessionToken, occurrenceId: "n0.0", png: Buffer.from(bytes).toString("base64") });
  payload = { item: ITEM, captureSequence: reserved.captureSequence, sha256: sha256Hex(bytes) };
  const argd = argsDigest(payload);
  await policy.commandWrite({ caller: GATEWAY, commandId, generation, fn: "bindOccurrence", args: { stage: "s0", occurrenceId: "n0.0", intentId: "snap", args: JSON.stringify(payload), argd } });
  return async () => (await policy.mint({ caller: L0013, sessionToken, fn: "snap", op: "gcs.put-thumbnail", occurrenceId: "n0.0", argsDigest: argd })).executionToken;
};
const execute = async token => broker.execute({ caller: L0013, token, op: "gcs.put-thumbnail", payload }).catch(e => e);
const deleteStaged = () => staging.state.objects.clear();
const read = () => createReceiptReader({ receipts })({ invocationId });

it("records the refusal under Policy's authorization of refusal/record, and the command settles failed", async () => {
  const mint = await occurrence(1);
  deleteStaged();
  const out = await execute(await mint());
  expect(out).toBeInstanceOf(BrokerRefused);
  expect(out).toMatchObject({ reason: "staging-unavailable", status: 409 });
  expect(uploads).toBe(0);
  const { operations } = await read();
  expect(operations).toEqual([expect.objectContaining({ recorded: true, status: "failed", steps: [], reason: "staging-unavailable" })]);
  // Policy settles it from the receipt and finishes the command failed.
  await policy.commandWrite({ caller: GATEWAY, commandId, generation: 1, fn: "closeStage", args: { stage: "s0", occurrences: { snap: ["n0.0"] } } });
  expect(await policy.settleCommand({ caller: GATEWAY, commandId, generation: 1 })).toMatchObject({ recorded: 1, operations: [{ stage: "s0", occurrenceId: "n0.0", outcome: "failed", final: true }] });
  expect(await policy.commandWrite({ caller: GATEWAY, commandId, generation: 1, fn: "finish", args: {} })).toMatchObject({ status: "failed", publication: { state: "none" } });
});

it("records nothing for a stale owner's token, and the next owner records the refusal once", async () => {
  const mint = await occurrence(1);
  // Minted just before generation 1's lease lapses (here, cut short in the
  // record); spent just after a sweeper took the command over.
  const staleToken = await mint();
  deleteStaged();
  const c = commandStore.commands.get(commandId);
  commandStore.commands.set(commandId, { ...c, owner: { ...c.owner, leaseExpiresAt: clock - 1 } });
  await policy.leaseCommand({ caller: GATEWAY, commandId, worker: "api-2", generation: 1, takeOver: true, recording: 1, repairs: 1, scopes: 1 });
  const stale = await execute(staleToken);
  expect(stale).toBeInstanceOf(BrokerRefused);
  expect(stale).toMatchObject({ reason: "staging-unavailable", status: 409 });
  expect(await receipts.getClaim(`${invocationId}/s0/n0.0`)).toBeNull();
  expect((await read()).operations).toEqual([]);
  // The new owner, at generation 2, resumes from what was staged and records it.
  const next = await occurrence(2);
  expect(await execute(await next())).toMatchObject({ reason: "staging-unavailable", status: 409 });
  expect((await read()).operations).toEqual([expect.objectContaining({ recorded: true, status: "failed", reason: "staging-unavailable" })]);
  expect(uploads).toBe(0);
});
