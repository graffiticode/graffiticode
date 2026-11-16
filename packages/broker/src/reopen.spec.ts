// The owner's review of #403, end to end: an item-authority outage at
// dispatch reaches Broker through the production HTTP authorizer as a
// temporary 503, and must not become a recorded failure. Once the console
// answers again, a new token for the same occurrence completes the capture.
import { generateKeyPair, exportJWK } from "jose";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { encodeChainId } from "@graffiticode/common/chain";
import {
  createPolicy,
  PolicyDenied,
  PolicyUnavailable,
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
} from "@graffiticode/policy";
import {
  createBroker,
  BrokerRefused,
  buildThumbnailOperations,
  buildPolicyAuthorizer,
  createMemoryOnceStore,
  createMemoryReceiptStore,
  createMemoryActivityStore,
  createMemorySecretStore,
  createReceiptReader,
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

it("recovers the same capture after an item-authority outage at dispatch", async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const leases = new Map();
  const invocations = createMemoryInvocationStore({ leases });
  const commandStore = createMemoryCommandStore({ invocationStore: invocations });
  const items = createMemoryItemAuthority({ [ITEM]: { ownerUid: OWNER, isPublic: false } });
  const protectedSwitch = createProtectedSwitch({ readFlag: async () => ({ enabled: true }) });
  const policy = createPolicy({
    signer,
    jwks,
    connections: createMemoryConnectionStore([]),
    invocations,
    commands: commandStore,
    commandRecords: createCommandRecords({ backend: createMemoryCommandBackend({ commandStore }) }),
    publications: createMemoryPublicationStore(),
    audit: async () => {},
    protectedSwitch,
    approvals: createMemoryApprovals(new Map([["0013/l0013r-r1", { lang: "0013", revision: "l0013r-r1", imageDigest: IMAGE, tag: "t", tagUrl: "https://t", status: "approved", contractVersions: [3] }]])),
    fence: createMemoryLeaseFence({ leases }),
    itemAuthority: items,
  });

  // An admitted capture, its occurrence bound.
  const { commandId } = (await policy.allocateCommand({ caller: GATEWAY, user: { uid: OWNER }, taskId: encodeChainId(["task-0"]), inputDigest: hex("9"), idempotencyKey: "job-1", lang: "0013", request: "{}", worker: "api-1", scopes: 1 })) as any;
  await policy.commandWrite({ caller: GATEWAY, commandId, generation: 1, fn: "installModel", args: { stage: "s0", text: JSON.stringify({ lang: "0013", kind: "plan", carried: {}, intents: [SNAP] }) } });
  await policy.admitCommand({ caller: GATEWAY, commandId, generation: 1, taskIds: ["task-0"], scopes: 1, stages: [{ stage: "s0", lang: "0013", sourceDigest: hex("b"), programDigest: hex("c"), optionsDigest: hex("d"), revision: "l0013r-r1", imageDigest: IMAGE, registryVersion: REGISTRY_VERSION, requiredFunctions: ["snap"] }] });
  const bytes = new Uint8Array(Buffer.from("\x89PNG test"));
  const payload = { item: ITEM, captureSequence: 1, sha256: sha256Hex(bytes) };
  const argd = argsDigest(payload);
  await policy.commandWrite({ caller: GATEWAY, commandId, generation: 1, fn: "bindOccurrence", args: { stage: "s0", occurrenceId: "n0.0", intentId: "snap", args: JSON.stringify(payload), argd } });
  const { sessionToken } = await policy.commandSession({ caller: GATEWAY, commandId, generation: 1, stage: "s0" });
  const mint = async () => (await policy.mint({ caller: L0013, sessionToken, fn: "snap", op: "gcs.put-thumbnail", occurrenceId: "n0.0", argsDigest: argd })).executionToken;

  let uploads = 0;
  const storage = {
    read: async () => bytes,
    getMetadata: async () => null,
    prepareUpload: async () => ({ send: async () => { uploads++; return { generation: "1001" }; } }),
  };
  const receipts = createMemoryReceiptStore();
  // The production HTTP authorizer, over Policy's answers as its app gives them.
  const authorize = buildPolicyAuthorizer({
    policyUrl: "https://policy.example",
    idToken: async () => "token",
    fetch: (async (_url, init) => {
      try {
        const data = await policy.authorizeExecution({ caller: { role: "broker" }, ...JSON.parse(init.body) });
        return new Response(JSON.stringify({ status: "success", data }), { status: 200 });
      } catch (e) {
        if (!(e instanceof PolicyDenied)) throw e;
        const temporary = e instanceof PolicyUnavailable;
        return new Response(JSON.stringify({ status: "error", error: { reason: e.reason, ...(temporary ? { retryable: true } : {}) } }), { status: temporary ? 503 : 403 });
      }
    }) as any,
  });
  const broker = createBroker({
    protectedSwitch,
    jwks,
    operations: buildThumbnailOperations({ storage, buckets: { thumbnails: "graffiticode-c5a-gate", staging: "graffiticode-command-staging" }, attempts: 4 }),
    once: createMemoryOnceStore(),
    receipts,
    activity: createMemoryActivityStore(),
    secrets: createMemorySecretStore({}),
    authorize,
    audit: async () => {},
  });

  // The console's item route is down when Broker asks before dispatch.
  const firstToken = await mint();
  items.state.unavailable = true;
  const first = await broker.execute({ caller: L0013, token: firstToken, op: "gcs.put-thumbnail", payload }).catch(e => e);
  expect(first).toBeInstanceOf(BrokerRefused);
  expect(first).toMatchObject({ reason: "authorization-unavailable", status: 503 });
  expect(uploads).toBe(0);
  // Settlement finds nothing claimed for it, so records no outcome.
  const read = await createReceiptReader({ receipts })({ invocationId: commandStore.commands.get(commandId).invocationId });
  expect(read.operations).toEqual([]);

  // The route recovers: a new token for the same operation completes it.
  items.state.unavailable = false;
  const second = await broker.execute({ caller: L0013, token: await mint(), op: "gcs.put-thumbnail", payload });
  expect(second.status).toBe("succeeded");
  expect(uploads).toBe(1);
});
