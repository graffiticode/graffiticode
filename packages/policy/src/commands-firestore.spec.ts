// Command records in Firestore (B5 slice 1), against the emulator only
// (FIRESTORE_EMULATOR_HOST set), e.g.
//   firebase emulators:exec --only firestore "npx jest src/commands-firestore.spec.ts"
// Allocation races need real transactions: concurrent first requests with one
// key get one command, and a key's first protocol wins (D2a).
import { randomUUID, createHash } from "node:crypto";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import {
  createFirestoreCommandStore,
  createFirestoreCommandBackend,
  createCommandRecords,
  runtimeOccurrenceId,
  createFirestoreInvocationStore,
  CommandRefused,
  ProtocolMismatch,
  commandIdFor,
  COMMAND_LEASE_MS,
} from "./index.js";

const run = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
const digest = s => createHash("sha256").update(s).digest("hex");
const T0 = Date.parse("2026-11-08T12:00:00Z");
const REQUEST = "{\"z\":1,\"a\":{\"y\":2,\"b\":3}}";

run("command records in Firestore", () => {
  let commands;
  let invocations;
  let records;
  let db;
  let uid;
  beforeAll(() => {
    const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: "demo-graffiticode" });
    db = getFirestore(app, "policy");
    commands = createFirestoreCommandStore(db);
    invocations = createFirestoreInvocationStore(db);
    // The records' clock: inside the first lease.
    records = createCommandRecords({ backend: createFirestoreCommandBackend(db), now: () => T0 + 1000 });
  });
  // Each test its own user, so tests never see each other's keys.
  beforeEach(() => {
    uid = `0xu${randomUUID().replace(/-/g, "")}`;
  });
  const allocate = (over = {}) => commands.allocate({
    uid,
    connectionId: "conn-1",
    taskId: "task-1",
    inputDigest: digest("input"),
    idempotencyKey: "key-1",
    lang: "0176",
    request: REQUEST,
    worker: "api-1",
    now: T0,
    ...over,
  });

  it("allocates one command for concurrent first requests with one key", async () => {
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => allocate({ worker: `api-${i}` })));
    const created = results.filter(r => !r.reused);
    expect(created).toHaveLength(1);
    expect(new Set(results.map(r => r.command.commandId))).toEqual(new Set([commandIdFor(uid, "key-1")]));
    expect(new Set(results.map(r => r.command.invocationId)).size).toBe(1);
    expect((await commands.get(commandIdFor(uid, "key-1"))).owner).toEqual({ worker: created[0].command.owner.worker, generation: 1, leaseExpiresAt: T0 + COMMAND_LEASE_MS });
  }, 30_000);

  it("stores the request as its exact text", async () => {
    const { command } = await allocate();
    expect(await commands.getRequest(command.commandId)).toBe(REQUEST);
  });

  it("lets the first protocol win a key, either way round", async () => {
    const legacyFirst = await invocations.allocate({ uid, connectionId: "conn-1", taskId: "task-1", inputDigest: digest("input"), idempotencyKey: "key-l" });
    expect(await allocate({ idempotencyKey: "key-l" })).toEqual({ protocol: "legacy", invocationId: legacyFirst.invocationId, seq: legacyFirst.seq });
    const { command } = await allocate({ idempotencyKey: "key-c" });
    await expect(invocations.allocate({ uid, connectionId: "conn-1", taskId: "task-1", inputDigest: digest("input"), idempotencyKey: "key-c" }))
      .rejects.toMatchObject({ protocol: "command", commandId: command.commandId });
    await expect(invocations.allocate({ uid, connectionId: "conn-1", taskId: "task-1", inputDigest: digest("input"), idempotencyKey: "key-c" }))
      .rejects.toBeInstanceOf(ProtocolMismatch);
  });

  it("races a legacy and a command first allocation of one key to one winner", async () => {
    const [asLegacy, asCommand] = await Promise.allSettled([
      invocations.allocate({ uid, connectionId: "conn-1", taskId: "task-1", inputDigest: digest("input"), idempotencyKey: "key-r" }),
      allocate({ idempotencyKey: "key-r" }),
    ]);
    if (asLegacy.status === "fulfilled") {
      // Legacy won: the command request was answered with the legacy protocol.
      expect(asCommand).toMatchObject({ status: "fulfilled", value: { protocol: "legacy", invocationId: asLegacy.value.invocationId } });
    } else {
      // The command won: the legacy request was refused.
      expect(asLegacy.reason).toBeInstanceOf(ProtocolMismatch);
      expect(asCommand).toMatchObject({ status: "fulfilled", value: { protocol: "command", reused: false } });
    }
  }, 30_000);

  it("takes a lease over once, at the next generation, and refuses the stale owner", async () => {
    const { command } = await allocate();
    const id = command.commandId;
    await expect(commands.takeOver({ commandId: id, worker: "api-2", expectedGeneration: 1, now: T0 + 1 })).rejects.toMatchObject({ reason: "lease-live" });
    const later = T0 + COMMAND_LEASE_MS + 1;
    const takeovers = await Promise.allSettled([
      commands.takeOver({ commandId: id, worker: "api-2", expectedGeneration: 1, now: later }),
      commands.takeOver({ commandId: id, worker: "api-3", expectedGeneration: 1, now: later }),
    ]);
    expect(takeovers.filter(t => t.status === "fulfilled")).toHaveLength(1);
    expect(takeovers.find(t => t.status === "rejected")).toMatchObject({ reason: { reason: "stale-generation" } });
    expect((await commands.get(id)).owner.generation).toBe(2);
    await expect(commands.renewLease({ commandId: id, worker: "api-1", generation: 1, now: later })).rejects.toBeInstanceOf(CommandRefused);
  }, 30_000);

  it("refuses an unknown command", async () => {
    await expect(commands.renewLease({ commandId: commandIdFor(uid, "none"), worker: "api-1", generation: 1, now: T0 })).rejects.toMatchObject({ reason: "command-not-found" });
  });

  // Slice 2: the records' transactions read before they write, and bounds
  // hold under real concurrency.
  const admitted = async () => {
    const { command } = await allocate();
    await db.collection("commands").doc(command.commandId).update({
      phase: "admitted",
      admission: { planDigest: digest("plan"), stages: { s0: { modelDigest: digest("m"), intents: [{ id: "batch", runtime: true, bounds: { maxOccurrences: 2 } }] } } },
    });
    return command;
  };
  const bind = (command, n) => records.bindOccurrence({ commandId: command.commandId, generation: 1, stage: "s0", occurrenceId: runtimeOccurrenceId("batch", `b${n}`), intentId: "batch", expansionKey: `b${n}`, args: `{"n":${n}}` });

  it("binds no more than the bound under concurrent binds", async () => {
    const command = await admitted();
    const results = await Promise.all([1, 2, 3, 4].map(n => bind(command, n)));
    // Past the bound a bind is refused, and the refusal recorded (C6 slice 0).
    expect(results.filter(r => r.bound)).toHaveLength(2);
    expect(results.filter(r => r.refused === "bounds-exceeded")).toHaveLength(2);
    expect(await records.listRefusals(command.commandId)).toHaveLength(2);
    expect((await records.listOccurrences(command.commandId))).toHaveLength(2);
  }, 30_000);

  it("settles, records a lost response, closes and finishes in transactions", async () => {
    const command = await admitted();
    await bind(command, 1);
    await bind(command, 2);
    const ids = [1, 2].map(n => runtimeOccurrenceId("batch", `b${n}`));
    const { recorded } = await records.recordFromReceipts({ commandId: command.commandId, generation: 1, operations: [{ operationId: `${command.invocationId}/s0/${ids[0]}`, status: "succeeded", recorded: true }] });
    expect(recorded).toHaveLength(1);
    expect((await records.recordLost({ commandId: command.commandId, generation: 1, stage: "s0" })).recorded).toHaveLength(1);
    await records.closeStage({ commandId: command.commandId, generation: 1, stage: "s0", occurrences: { batch: ids } });
    const done = await records.finish({ commandId: command.commandId, generation: 1, result: "{\"b\":1,\"a\":2}" });
    expect(done).toMatchObject({ status: "uncertain", result: { state: "available" }, publication: { state: "none" } });
    expect((await records.getResult(command.commandId)).text).toBe("{\"b\":1,\"a\":2}");
  });

  it("refuses a stale generation without writing", async () => {
    const command = await admitted();
    await expect(records.installInput({ commandId: command.commandId, generation: 2, stage: "s0", text: "{}" })).rejects.toMatchObject({ reason: "stale-generation" });
    expect(await records.getInput(command.commandId, "s0")).toBeNull();
  });

  // Slice 6: recovery's two queries (pending, publication due), each with an
  // expired lease. The emulator needs no index; production does
  // (configs/firestore-policy-indexes.json).
  it("lists the commands due for recovery", async () => {
    const { command: pending } = await allocate({ idempotencyKey: `due-${uid}` });
    const { command: published } = await allocate({ idempotencyKey: `pub-${uid}` });
    await db.collection("commands").doc(published.commandId).update({ status: "completed", publication: { state: "due", resultDigest: digest("r") } });
    const { command: done } = await allocate({ idempotencyKey: `done-${uid}` });
    await db.collection("commands").doc(done.commandId).update({ status: "completed" });
    const after = T0 + COMMAND_LEASE_MS + 1;
    const ids = (await commands.listDue({ now: after, limit: 50 })).map(c => c.commandId);
    expect(ids).toEqual(expect.arrayContaining([pending.commandId, published.commandId]));
    expect(ids).not.toContain(done.commandId);
    expect((await commands.listDue({ now: T0, limit: 50 })).map(c => c.commandId)).not.toContain(pending.commandId);
  });
});
