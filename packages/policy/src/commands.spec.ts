// Command records (B5 slice 1, docs/b5-commands-plan.md §3): allocation with
// the protocol recorded on the key (D2a), and the lease with its fencing
// generation, against memory stores.
import { generateKeyPair, exportJWK } from "jose";
import { createHash } from "node:crypto";
import {
  createPolicy,
  PolicyDenied,
  createLocalSigner,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryPublicationStore,
  createMemoryCommandStore,
  createAudit,
  createPseudonymizer,
  createProtectedSwitch,
  commandIdFor,
  ownerRefusal,
  MAX_PAYLOAD_BYTES,
  COMMAND_LEASE_MS,
} from "./index.js";

const OWNER = "0xowneruid";
const OTHER = "0xotheruid";
const GATEWAY = { role: "gateway" };
const digest = s => createHash("sha256").update(s).digest("hex");
const T0 = Date.parse("2026-11-08T12:00:00Z");

let policy;
let invocationStore;
let commandStore;
let clock;
let records;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const signer = await createLocalSigner({ privateJwk, kid: "k1" });
  records = [];
  clock = T0;
  invocationStore = createMemoryInvocationStore();
  commandStore = createMemoryCommandStore({ invocationStore });
  policy = createPolicy({
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    signer,
    jwks: { keys: [publicJwk] },
    connections: createMemoryConnectionStore([
      { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" },
      { connectionId: "conn-off", ownerUid: OWNER, backend: "learnosity", status: "disabled" },
    ]),
    invocations: invocationStore,
    commands: commandStore,
    publications: createMemoryPublicationStore(),
    audit: createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) }),
    now: () => clock,
  });
});

// Unsorted keys on purpose: the request is kept as this exact text.
const REQUEST = "{\"id\":\"task-1\",\"data\":{\"z\":1,\"a\":2},\"connectionId\":\"conn-1\"}";
const allocate = (over = {}) => policy.allocateCommand({
  caller: GATEWAY,
  user: { uid: OWNER },
  connectionId: "conn-1",
  taskId: "task-1",
  inputDigest: digest("input"),
  idempotencyKey: "key-1",
  lang: "0176",
  request: REQUEST,
  worker: "api-1",
  ...over,
});
const legacy = (over = {}) => policy.allocateInvocation({ caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: "task-1", inputDigest: digest("input"), ...over });
const lease = over => policy.leaseCommand({ caller: GATEWAY, worker: "api-1", generation: 1, ...over });
const denied = async (promise, reason) => {
  await expect(promise).rejects.toBeInstanceOf(PolicyDenied);
  await expect(promise).rejects.toMatchObject({ reason });
};

describe("allocating a command", () => {
  it("allocates the command, its key and its invocation at once, owned at generation 1", async () => {
    const out = await allocate();
    expect(out).toMatchObject({
      protocol: "command",
      commandId: commandIdFor(OWNER, "key-1"),
      phase: "allocated",
      status: "pending",
      generation: 1,
      leaseExpiresAt: T0 + COMMAND_LEASE_MS,
      reused: false,
      owned: true,
      ownerUid: OWNER,
      runRef: null,
    });
    expect(out.invocationId).toMatch(/^inv-/);
    expect(invocationStore.invocations.get(out.invocationId)).toMatchObject({ protocol: "command", commandId: out.commandId, contract: 2 });
  });

  it("keeps the request as its exact text, key order included", async () => {
    const { commandId } = await allocate();
    expect(await commandStore.getRequest(commandId)).toBe(REQUEST);
  });

  it("answers a second request with the same key with the same command, not owned", async () => {
    const first = await allocate();
    const second = await allocate({ worker: "api-2" });
    expect(second).toMatchObject({ commandId: first.commandId, invocationId: first.invocationId, reused: true, owned: false, generation: 1 });
  });

  it("refuses the same key for a different binding", async () => {
    await allocate();
    await denied(allocate({ taskId: "task-2" }), "idempotency-key-reused");
    await denied(allocate({ inputDigest: digest("other") }), "idempotency-key-reused");
  });

  it("requires a key, a language, a worker and a JSON object request within the cap", async () => {
    await denied(allocate({ idempotencyKey: undefined }), "bad-request");
    await denied(allocate({ lang: "L0176" }), "bad-request");
    await denied(allocate({ worker: "a b" }), "bad-request");
    await denied(allocate({ request: "[1]" }), "bad-request");
    await denied(allocate({ request: "{" }), "bad-request");
    await denied(allocate({ request: JSON.stringify({ pad: "x".repeat(MAX_PAYLOAD_BYTES) }) }), "input-too-large");
  });

  it("checks the user may use the connection now, and only for the gateway", async () => {
    await denied(allocate({ connectionId: "conn-off" }), "connection-disabled");
    await denied(allocate({ user: { uid: OTHER } }), "not-owner");
    await denied(allocate({ caller: { role: "compiler", lang: "0176" } }), "caller-not-entry-point");
    await denied(allocate({ user: null }), "no-user");
  });
});

// D2a: the first allocation of a key decides its protocol for good.
describe("protocols", () => {
  it("answers a legacy key with its protocol, and never makes it a command", async () => {
    const { invocationId } = await legacy({ idempotencyKey: "key-1" });
    expect(await allocate()).toEqual({ protocol: "legacy", invocationId, seq: 1 });
    expect(commandStore.commands.size).toBe(0);
  });

  it("refuses a command's key on the legacy path", async () => {
    await allocate();
    await denied(legacy({ idempotencyKey: "key-1" }), "command-protocol");
  });

  it("records legacy on a legacy allocation", async () => {
    const out = await legacy({ idempotencyKey: "key-2" });
    expect(out.protocol).toBe("legacy");
    expect(invocationStore.invocations.get(out.invocationId).protocol).toBe("legacy");
  });
});

describe("the lease", () => {
  it("is renewed by its owner at the current generation", async () => {
    const { commandId } = await allocate();
    clock += 20_000;
    expect(await lease({ commandId })).toMatchObject({ generation: 1, leaseExpiresAt: clock + COMMAND_LEASE_MS });
  });

  it("refuses a renewal by another worker, at another generation, or after expiry, and changes nothing", async () => {
    const { commandId } = await allocate();
    const before = JSON.stringify(commandStore.commands.get(commandId));
    await denied(lease({ commandId, worker: "api-2" }), "stale-generation");
    await denied(lease({ commandId, generation: 2 }), "stale-generation");
    await denied(lease({ commandId, generation: 0 }), "bad-request");
    clock += COMMAND_LEASE_MS;
    await denied(lease({ commandId }), "lease-expired");
    expect(JSON.stringify(commandStore.commands.get(commandId))).toBe(before);
  });

  it("is taken over only once expired, at the next generation, and the old owner is fenced out", async () => {
    const { commandId } = await allocate();
    await denied(lease({ commandId, worker: "api-2", takeOver: true }), "lease-live");
    clock += COMMAND_LEASE_MS + 1;
    const taken = await lease({ commandId, worker: "api-2", takeOver: true });
    expect(taken).toMatchObject({ generation: 2, leaseExpiresAt: clock + COMMAND_LEASE_MS });
    // The old owner, with its generation, can't renew.
    await denied(lease({ commandId }), "stale-generation");
    // A second takeover naming the old generation loses.
    await denied(lease({ commandId, worker: "api-3", takeOver: true }), "stale-generation");
    expect(records.some(r => r.event === "command-lease" && r.reason === "takeover")).toBe(true);
  });

  it("refuses an unknown command, and is only the gateway's", async () => {
    await denied(lease({ commandId: commandIdFor(OWNER, "nope") }), "command-not-found");
    await denied(lease({ commandId: "c:not-hex" }), "bad-request");
    const { commandId } = await allocate();
    await denied(lease({ commandId, caller: { role: "broker" } }), "caller-not-entry-point");
  });
});

describe("reading a command", () => {
  it("returns the summary to the gateway, and to its own user only", async () => {
    const { commandId } = await allocate();
    const read = await policy.getCommand({ caller: GATEWAY, commandId });
    expect(read).toMatchObject({ commandId, status: "pending", generation: 1 });
    expect(read).not.toHaveProperty("request");
    expect(await policy.getCommand({ caller: GATEWAY, user: { uid: OWNER }, commandId })).toMatchObject({ commandId });
    await denied(policy.getCommand({ caller: GATEWAY, user: { uid: OTHER }, commandId }), "command-not-found");
  });
});

describe("ownerRefusal", () => {
  const command = { owner: { worker: "w", generation: 3, leaseExpiresAt: 1000 } };
  it("needs exactly the current generation and a live lease", () => {
    expect(ownerRefusal(command, { generation: 3, now: 999 })).toBeNull();
    expect(ownerRefusal(command, { generation: 2, now: 999 })).toBe("stale-generation");
    expect(ownerRefusal(command, { generation: 4, now: 999 })).toBe("stale-generation");
    expect(ownerRefusal(command, { generation: 3, now: 1000 })).toBe("lease-expired");
    expect(ownerRefusal(null, { generation: 3, now: 0 })).toBe("command-not-found");
  });
});

describe("commands due for recovery", () => {
  it("lists pending commands and due publications whose lease expired, oldest first", async () => {
    const a = await allocate({ idempotencyKey: "key-a" });
    clock += 1000;
    const b = await allocate({ idempotencyKey: "key-b" });
    expect((await policy.dueCommands({ caller: GATEWAY })).commands).toEqual([]);
    clock += COMMAND_LEASE_MS + 1000;
    const due = (await policy.dueCommands({ caller: GATEWAY })).commands;
    expect(due.map(d => d.commandId)).toEqual([a.commandId, b.commandId]);
    expect(due[0]).toMatchObject({ generation: 1, status: "pending" });
    // A finished command with nothing to publish is never due.
    const c = commandStore.commands.get(a.commandId);
    commandStore.commands.set(a.commandId, { ...c, status: "completed", publication: { state: "none", resultDigest: null } });
    expect((await policy.dueCommands({ caller: GATEWAY })).commands.map(d => d.commandId)).toEqual([b.commandId]);
    commandStore.commands.set(a.commandId, { ...c, status: "completed", publication: { state: "due", resultDigest: "d" } });
    expect((await policy.dueCommands({ caller: GATEWAY, limit: 1 })).commands.map(d => d.commandId)).toEqual([a.commandId]);
  });

  // B6 slice 2: a command admitted as recording is listed only to a worker
  // that records outputs, and never counts toward another's limit.
  it("lists a recording command only to a recording worker, choosing before the limit", async () => {
    const a = await allocate({ idempotencyKey: "key-a" });
    clock += 1000;
    const b = await allocate({ idempotencyKey: "key-b" });
    const c = commandStore.commands.get(a.commandId);
    commandStore.commands.set(a.commandId, { ...c, admission: { ...(c.admission ?? {}), recording: 1 } });
    clock += COMMAND_LEASE_MS + 1000;
    expect((await policy.dueCommands({ caller: GATEWAY, limit: 1 })).commands.map(d => d.commandId)).toEqual([b.commandId]);
    expect((await policy.dueCommands({ caller: GATEWAY, limit: 1, recording: 1 })).commands.map(d => d.commandId)).toEqual([a.commandId]);
    expect((await policy.dueCommands({ caller: GATEWAY, recording: 1 })).commands.map(d => d.commandId)).toEqual([a.commandId, b.commandId]);
    await denied(policy.dueCommands({ caller: GATEWAY, recording: 2 }), "bad-request");
  });

  it("is the gateway's only, within its limit", async () => {
    await denied(policy.dueCommands({ caller: { role: "compiler", lang: "0176" } }), "caller-not-entry-point");
    await denied(policy.dueCommands({ caller: GATEWAY, limit: 500 }), "bad-request");
  });
});

describe("allocation without creating", () => {
  it("answers none for a key nothing holds, and the protocol of one that is held, creating nothing", async () => {
    expect(await allocate({ idempotencyKey: "fresh", create: false })).toEqual({ protocol: "none" });
    expect(commandStore.commands.size).toBe(0);
    const { invocationId } = await legacy({ idempotencyKey: "old" });
    expect(await allocate({ idempotencyKey: "old", create: false })).toEqual({ protocol: "legacy", invocationId, seq: 1 });
    const made = await allocate({ idempotencyKey: "cmd" });
    expect(await allocate({ idempotencyKey: "cmd", create: false })).toMatchObject({ protocol: "command", commandId: made.commandId, reused: true });
  });
});
