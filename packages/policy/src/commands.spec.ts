// Command records (B5 slice 1, docs/b5-commands-plan.md §3): allocation with
// the protocol recorded on the key (D2a), and the lease with its fencing
// generation, against memory stores.
import { generateKeyPair, exportJWK } from "jose";
import { createHash, randomUUID } from "node:crypto";
import {
  createMemoryHolds,
  createFirestoreHolds,
  createMemoryCommandBackend,
  createCommandRecords,
  ownableBy,
  HOLD_MARGIN_MS,
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

// C5d (docs/c5d-refusal-and-hold-plan.md decisions 6–8, 10, 11, §4 "Hold"):
// the durable hold, against the memory stores. `clock` is the server read
// time the act is decided on.
describe("the command hold", () => {
  const APPLIED_BY = { email: "owner@example.com", verifiedVia: "tokeninfo", azp: "123.apps.googleusercontent.com" };
  const act = (commandId, over = {}) => ({
    commandId, actId: randomUUID(), reason: "definite-refusal-unsettled", note: "held until the owner decides", decision: "docs/c5d-refusal-and-hold-plan.md", decidedBy: "owner", appliedBy: APPLIED_BY, ...over,
  });
  const CAPS = [0, 1].flatMap(recording => [0, 1].flatMap(repairs => [0, 1].map(scopes => ({ recording, repairs, scopes }))));
  let holds;
  let backend;
  beforeEach(() => {
    backend = createMemoryCommandBackend({ commandStore });
    holds = createMemoryHolds({ commandStore, backend, now: () => clock });
  });
  // A command whose lease ended past the margin, so it may be held.
  const expired = async (key = "key-h") => {
    const { commandId } = await allocate({ idempotencyKey: key });
    clock = commandStore.commands.get(commandId).owner.leaseExpiresAt + HOLD_MARGIN_MS;
    return commandId;
  };
  const holdDocs = commandId => [...backend.docs.keys()].filter(k => k.startsWith(`commands/${commandId}/holds/`));
  const withoutHold = ({ hold: _hold, ...rest }) => rest;
  const stateOf = commandId => JSON.stringify([commandStore.commands.get(commandId), [...backend.docs.entries()]]);

  it("is refused while the lease is live, and up to HOLD_MARGIN_MS past it, by the server read time", async () => {
    const { commandId } = await allocate();
    const before = JSON.stringify(commandStore.commands.get(commandId));
    const expires = commandStore.commands.get(commandId).owner.leaseExpiresAt;
    await expect(holds.applyHold(act(commandId))).rejects.toMatchObject({ reason: "lease-live" });
    clock = expires + 99_999;
    await expect(holds.applyHold(act(commandId))).rejects.toMatchObject({ reason: "lease-live" });
    expect(JSON.stringify(commandStore.commands.get(commandId))).toBe(before);
    expect(holdDocs(commandId)).toEqual([]);
    clock = expires + 100_000;
    const applied = await holds.applyHold(act(commandId));
    expect(applied).toMatchObject({ replayed: false, record: { n: 1, act: "apply", fencing: "lease-expired", generation: 1, leaseExpiresAt: expires, readTime: clock, appliedBy: APPLIED_BY } });
    expect(commandStore.commands.get(commandId).hold).toMatchObject({ n: 1, actId: applied.record.actId, generation: 1, leaseExpiresAt: expires, readTime: clock });
  });

  it("holds only a pending command", async () => {
    const commandId = await expired();
    const c = commandStore.commands.get(commandId);
    commandStore.commands.set(commandId, { ...c, status: "failed" });
    await expect(holds.applyHold(act(commandId))).rejects.toMatchObject({ reason: "not-pending" });
    // A finished command whose publication is due stays outside the hold.
    commandStore.commands.set(commandId, { ...c, status: "completed", publication: { state: "due", resultDigest: "d" } });
    await expect(holds.applyHold(act(commandId))).rejects.toMatchObject({ reason: "not-pending" });
    expect(holdDocs(commandId)).toEqual([]);
    await expect(holds.applyHold(act(commandIdFor(OWNER, "none")))).rejects.toMatchObject({ reason: "command-not-found" });
  });

  it("refuses a malformed act: its reason, note, act id, identity and lift target", async () => {
    const commandId = await expired();
    for (const over of [{ reason: "Not A Slug" }, { note: "x".repeat(501) }, { actId: "act-1" }, { appliedBy: { email: "owner@example.com" } }, { decision: "" }]) {
      await expect(holds.applyHold(act(commandId, over))).rejects.toMatchObject({ reason: "bad-request" });
    }
    await expect(holds.liftHold(act(commandId, { lifts: "not-an-act" }))).rejects.toMatchObject({ reason: "bad-request" });
    expect(commandStore.commands.get(commandId).hold).toBeUndefined();
  });

  it("changes nothing on the command but the hold, and a lift restores it exactly", async () => {
    const commandId = await expired();
    const records = createCommandRecords({ backend, now: () => clock });
    backend.docs.set(`commands/${commandId}/outcomes/s0:n0.0`, { stage: "s0", occurrenceId: "n0.0", outcome: "failed" });
    const before = structuredClone(commandStore.commands.get(commandId));
    const keysBefore = [...backend.docs.keys()];
    const applied = await holds.applyHold(act(commandId));
    const held = commandStore.commands.get(commandId);
    expect(JSON.stringify(withoutHold(held))).toBe(JSON.stringify(before));
    expect(held.updatedAt).toBe(before.updatedAt);
    // Only the history document was added beside the records.
    expect([...backend.docs.keys()].filter(k => !k.includes("/holds/"))).toEqual(keysBefore);
    expect(await records.listOutcomes(commandId)).toEqual([{ stage: "s0", occurrenceId: "n0.0", outcome: "failed" }]);
    const lifted = await holds.liftHold(act(commandId, { lifts: applied.record.actId, reason: "owner-lifted" }));
    expect(lifted).toMatchObject({ replayed: false, record: { n: 2, act: "lift", lifts: applied.record.actId, fencing: null } });
    expect(JSON.stringify(commandStore.commands.get(commandId))).toBe(JSON.stringify(before));
    expect((await policy.dueCommands({ caller: GATEWAY })).commands.map(d => d.commandId)).toContain(commandId);
  });

  it("is skipped by due selection at every capability, which returns the next ownable command within its limit", async () => {
    const a = await allocate({ idempotencyKey: "key-a" });
    clock += 1000;
    const b = await allocate({ idempotencyKey: "key-b" });
    clock += COMMAND_LEASE_MS + HOLD_MARGIN_MS;
    await holds.applyHold(act(a.commandId));
    for (const caps of CAPS) {
      expect(ownableBy(commandStore.commands.get(a.commandId), caps)).toBe(false);
      expect(ownableBy(commandStore.commands.get(b.commandId), caps)).toBe(true);
      expect((await policy.dueCommands({ caller: GATEWAY, limit: 1, ...caps })).commands.map(d => d.commandId)).toEqual([b.commandId]);
      expect((await commandStore.listDue({ now: clock, limit: 50, ...caps })).map(c => c.commandId)).toEqual([b.commandId]);
    }
  });

  it("refuses takeover command-held at every capability, and renewal, changing nothing", async () => {
    const commandId = await expired();
    await holds.applyHold(act(commandId));
    const before = JSON.stringify(commandStore.commands.get(commandId));
    for (const caps of CAPS) await denied(lease({ commandId, worker: "api-2", takeOver: true, ...caps }), "command-held");
    // Its old owner's renewal: the lease ended first, so the reason every
    // worker knows.
    await denied(lease({ commandId }), "lease-expired");
    expect(JSON.stringify(commandStore.commands.get(commandId))).toBe(before);
    // Defense in depth: a held command with a live lease refuses renewal by
    // its hold.
    const c = commandStore.commands.get(commandId);
    commandStore.commands.set(commandId, { ...c, owner: { ...c.owner, leaseExpiresAt: clock + COMMAND_LEASE_MS } });
    await denied(lease({ commandId }), "command-held");
    await expect(commandStore.renewLease({ commandId, worker: "api-1", generation: 1, now: clock, recording: 1, repairs: 1, scopes: 1 })).rejects.toMatchObject({ reason: "command-held" });
    expect(ownerRefusal(commandStore.commands.get(commandId), { generation: 1, now: clock })).toBe("command-held");
  });

  it("shows held on the command's summary", async () => {
    const commandId = await expired();
    await holds.applyHold(act(commandId));
    expect(await policy.getCommand({ caller: GATEWAY, commandId })).toMatchObject({ commandId, held: true, status: "pending" });
  });

  it("still answers an allocation with the same key, leasing nothing; the caller's takeover is refused", async () => {
    const commandId = await expired("key-1");
    await holds.applyHold(act(commandId));
    const again = await allocate({ worker: "api-2" });
    expect(again).toMatchObject({ commandId, reused: true, owned: false, held: true, generation: 1 });
    await denied(lease({ commandId, worker: "api-2", takeOver: true }), "command-held");
    expect(commandStore.commands.get(commandId).owner).toMatchObject({ worker: "api-1", generation: 1 });
  });

  it("allocates its history transactionally: apply, lift, apply gives n 1, 2, 3", async () => {
    const commandId = await expired();
    const first = await holds.applyHold(act(commandId));
    const lift = await holds.liftHold(act(commandId, { lifts: first.record.actId }));
    const second = await holds.applyHold(act(commandId));
    expect([first, lift, second].map(r => [r.record.n, r.record.act])).toEqual([[1, "apply"], [2, "lift"], [3, "apply"]]);
    expect(holdDocs(commandId)).toHaveLength(3);
    expect(commandStore.commands.get(commandId).hold).toMatchObject({ n: 3, actId: second.record.actId });
    expect((await holds.status(commandId)).history.map(h => h.n)).toEqual([1, 2, 3]);
  });

  it("answers a retry of a committed act replayed, writing nothing, even after a later lift", async () => {
    const commandId = await expired();
    const request = act(commandId);
    const first = await holds.applyHold(request);
    const before = stateOf(commandId);
    expect(await holds.applyHold(request)).toMatchObject({ commandId, replayed: true, record: first.record });
    expect(stateOf(commandId)).toBe(before);
    const liftRequest = act(commandId, { lifts: first.record.actId });
    await holds.liftHold(liftRequest);
    const lifted = stateOf(commandId);
    expect(await holds.applyHold(request)).toMatchObject({ replayed: true, record: { n: 1 } });
    expect(await holds.liftHold(liftRequest)).toMatchObject({ replayed: true, record: { n: 2 } });
    expect(stateOf(commandId)).toBe(lifted);
    // The same act id for a different act is refused.
    await expect(holds.applyHold({ ...request, note: "another note" })).rejects.toMatchObject({ reason: "act-id-reused" });
    expect(stateOf(commandId)).toBe(lifted);
  });

  it("gives two concurrent applies one hold, refusing the other already-held; one act id sent twice, one entry", async () => {
    const commandId = await expired();
    const results = await Promise.allSettled([holds.applyHold(act(commandId)), holds.applyHold(act(commandId))]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { reason: "already-held" } });
    expect(holdDocs(commandId)).toHaveLength(1);
    const other = await expired("key-h2");
    const request = act(other);
    const twice = await Promise.all([holds.applyHold(request), holds.applyHold(request)]);
    expect(twice.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(holdDocs(other)).toHaveLength(1);
  });

  it("refuses a lift naming another act, or of a command not held, changing nothing", async () => {
    const commandId = await expired();
    await expect(holds.liftHold(act(commandId, { lifts: randomUUID() }))).rejects.toMatchObject({ reason: "not-held" });
    const applied = await holds.applyHold(act(commandId));
    const before = stateOf(commandId);
    await expect(holds.liftHold(act(commandId, { lifts: randomUUID() }))).rejects.toMatchObject({ reason: "hold-mismatch" });
    expect(stateOf(commandId)).toBe(before);
    expect(commandStore.commands.get(commandId).hold.actId).toBe(applied.record.actId);
  });

  it("decides a takeover racing an apply by whichever commits first", async () => {
    // The takeover first: the hold then sees a live lease.
    const a = await expired("key-r1");
    const [taken, refused] = await Promise.allSettled([
      commandStore.takeOver({ commandId: a, worker: "api-2", expectedGeneration: 1, now: clock }),
      holds.applyHold(act(a)),
    ]);
    expect(taken.status).toBe("fulfilled");
    expect(refused).toMatchObject({ status: "rejected", reason: { reason: "lease-live" } });
    expect(commandStore.commands.get(a).hold).toBeUndefined();
    // The hold first: the takeover sees it.
    const b = await expired("key-r2");
    const [held, fenced] = await Promise.allSettled([
      holds.applyHold(act(b)),
      commandStore.takeOver({ commandId: b, worker: "api-2", expectedGeneration: 1, now: clock }),
    ]);
    expect(held.status).toBe("fulfilled");
    expect(fenced).toMatchObject({ status: "rejected", reason: { reason: "command-held" } });
    expect(commandStore.commands.get(b).owner.generation).toBe(1);
  });

  // The Firestore store, over a fake database: a transaction killed for
  // contention runs again (the act is idempotent); a refusal never does.
  it("runs a Firestore act again when its transaction was killed for contention, and never a refused one", async () => {
    const ref = { collection: () => ({ doc: () => ({}) }) };
    const db = { collection: () => ({ doc: () => ref }), runTransaction: null };
    const snap = data => ({ exists: data !== null, data: () => data, readTime: { toMillis: () => T0 + COMMAND_LEASE_MS + HOLD_MARGIN_MS } });
    const command = structuredClone(commandStore.commands.get((await allocate()).commandId));
    const writes = [];
    let runs = 0;
    db.runTransaction = async fn => {
      runs++;
      if (runs === 1) throw Object.assign(new Error("3 INVALID_ARGUMENT: Transaction is invalid or closed."), { code: 3, details: "Transaction is invalid or closed." });
      let reads = 0;
      return fn({
        get: async () => (++reads === 1 ? snap(command) : reads === 2 ? snap(null) : { docs: [] }),
        update: (_r, patch) => writes.push(["update", patch]),
        create: (_r, doc) => writes.push(["create", doc]),
      });
    };
    const firestoreHolds = createFirestoreHolds(db);
    expect(await firestoreHolds.applyHold(act(command.commandId))).toMatchObject({ replayed: false, record: { n: 1 } });
    expect(runs).toBe(2);
    expect(writes.map(([kind]) => kind)).toEqual(["update", "create"]);
    runs = 1;
    command.status = "failed";
    await expect(firestoreHolds.applyHold(act(command.commandId))).rejects.toMatchObject({ reason: "not-pending" });
    expect(runs).toBe(2);
    db.runTransaction = async () => {
      runs++;
      throw Object.assign(new Error("permission denied"), { code: 7 });
    };
    await expect(firestoreHolds.applyHold(act(command.commandId))).rejects.toMatchObject({ code: 7 });
    expect(runs).toBe(3);
  });

  it("is refused while a renewing owner's lease is live", async () => {
    const { commandId } = await allocate();
    clock += 20_000;
    const [renewed, refused] = await Promise.allSettled([
      commandStore.renewLease({ commandId, worker: "api-1", generation: 1, now: clock }),
      holds.applyHold(act(commandId)),
    ]);
    expect(renewed.status).toBe("fulfilled");
    expect(refused).toMatchObject({ status: "rejected", reason: { reason: "lease-live" } });
    expect(commandStore.commands.get(commandId).hold).toBeUndefined();
  });
});
