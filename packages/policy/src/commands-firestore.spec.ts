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
  createFirestoreHolds,
  HOLD_MARGIN_MS,
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

  // C5 slice 3c (decision 9): reservations take an item's sequence and its
  // public-capture limit in real transactions.
  const capturing = async key => {
    const { command } = await allocate({ idempotencyKey: `${key}-${uid}` });
    await db.collection("commands").doc(command.commandId).update({
      phase: "admitted",
      admission: { planDigest: digest("plan"), contractVersion: 3, stages: { s0: { modelDigest: digest("m"), intents: [{ id: "snap", fn: "snap", op: "gcs.put-thumbnail", occurrences: ["n0.0"], scope: { kind: "item" }, bounds: { maxOccurrences: 1 } }] } } },
    });
    return command;
  };
  const reserveIn = (command, item, publicCapture) => records.reserve({ commandId: command.commandId, generation: 1, stage: "s0", occurrenceId: "n0.0", intentId: "snap", item, publicCapture, limit: 3, windowMs: 3_600_000 });

  it("gives concurrent reservations of one item distinct sequences, and holds the public limit", async () => {
    const item = `item-${uid.slice(3, 15)}`;
    const commandsFor = await Promise.all([0, 1, 2, 3, 4].map(i => capturing(`cap-${i}`)));
    const results = await Promise.allSettled(commandsFor.map(c => reserveIn(c, item, true)));
    const reserved = results.filter(r => r.status === "fulfilled").map(r => (r as PromiseFulfilledResult<any>).value);
    expect(reserved).toHaveLength(3);
    expect(results.filter(r => r.status === "rejected").map(r => (r as PromiseRejectedResult).reason.reason)).toEqual(["rate-limited", "rate-limited"]);
    expect(reserved.map(r => r.captureSequence).sort()).toEqual([1, 2, 3]);
    // The owner's isn't limited; a repeat counts nothing.
    const owners = await capturing("cap-owner");
    expect((await reserveIn(owners, item, false)).captureSequence).toBe(4);
    expect(await reserveIn(owners, item, false)).toMatchObject({ captureSequence: 4, reused: true });
    expect(await records.getItemCaptures(item)).toMatchObject({ nextCaptureSequence: 5 });
    expect((await records.getItemCaptures(item)).publicCaptures).toHaveLength(3);
    // Staged once; the first staging stands.
    await records.markStaged({ commandId: owners.commandId, generation: 1, stage: "s0", occurrenceId: "n0.0", sha256: digest("a"), size: 10, object: "o" });
    expect(await records.markStaged({ commandId: owners.commandId, generation: 1, stage: "s0", occurrenceId: "n0.0", sha256: digest("b"), size: 10, object: "o" })).toMatchObject({ sha256: digest("a") });
  }, 30_000);

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

  // B6 slice 3: the ledger's claim under real transactions. An original
  // with one failed occurrence; repairs of it allocated, then admitted at
  // once: exactly one claims it. A failed repair's entry may be claimed
  // again; a completed one may not.
  describe("the repair ledger", () => {
    const occ = runtimeOccurrenceId("batch", "b1");
    const original = async () => {
      const { command } = await allocate({ idempotencyKey: `orig-${uid}` });
      const admission = { planDigest: digest("plan"), recording: 1, stages: { s0: { modelDigest: digest("m"), replay: 1, intents: [{ id: "batch", runtime: true, bounds: { maxOccurrences: 2 } }] } } };
      await db.collection("commands").doc(command.commandId).update({
        phase: "admitted",
        status: "failed",
        admission,
        stages: { s0: { state: "ran", expansion: "closed", pinnedInput: digest("in") } },
      });
      await db.collection("commands").doc(command.commandId).collection("outcomes").doc(`s0:${occ}`)
        .set({ stage: "s0", occurrenceId: occ, outcome: "failed", source: "receipt", final: true });
      return { ...command, admission };
    };
    const repair = async (orig, key) => (await allocate({ idempotencyKey: `${key}-${uid}`, repair: { repairOf: orig.commandId, selection: [{ stage: "s0", occurrenceId: occ }] } })).command;
    const claim = (r, orig) => records.claimRepair({ commandId: r.commandId, generation: 1, admission: { ...orig.admission, repairOf: orig.commandId } });
    const entry = async orig => (await db.collection("commands").doc(orig.commandId).collection("ledger").doc(`s0:${occ}`).get()).data();

    it("lets exactly one of concurrent repairs claim an occurrence", async () => {
      const orig = await original();
      const repairs = await Promise.all(["r-a", "r-b", "r-c", "r-d"].map(k => repair(orig, k)));
      const results = await Promise.allSettled(repairs.map(r => claim(r, orig)));
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const winner = repairs[results.findIndex(r => r.status === "fulfilled")];
      for (const r of results.filter(x => x.status === "rejected")) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({ reason: "occurrence-claimed", detail: { repairId: winner.commandId } });
      }
      expect(await entry(orig)).toMatchObject({ status: "pending", repairId: winner.commandId, prior: "failed" });
      // The losers were never admitted.
      for (const r of repairs.filter(x => x !== winner)) expect((await commands.get(r.commandId)).phase).toBe("allocated");
    }, 30_000);

    it("claims a failed repair's entry again, never a completed one", async () => {
      const orig = await original();
      const first = await repair(orig, "r-1");
      await claim(first, orig);
      const ref = db.collection("commands").doc(orig.commandId).collection("ledger").doc(`s0:${occ}`);
      await ref.update({ status: "failed", source: "receipt" });
      const second = await repair(orig, "r-2");
      await claim(second, orig);
      expect(await entry(orig)).toMatchObject({ status: "pending", repairId: second.commandId, attempts: [{ repairId: first.commandId, status: "failed", source: "receipt" }] });
      await ref.update({ status: "completed" });
      const third = await repair(orig, "r-3");
      await expect(claim(third, orig)).rejects.toMatchObject({ reason: "not-eligible" });
    }, 30_000);
  });

  // B6 slice 2: a worker that doesn't record outputs reads on past the
  // recording commands it can't own, a page at a time, to the ones it can.
  it("lists, to a worker that doesn't record, the commands it may own past a page of ones it can't", async () => {
    const paged = createFirestoreCommandStore(db, { duePage: 2 });
    const now = T0 + COMMAND_LEASE_MS + 1;
    // Every other due command in the emulator, from earlier tests, is set
    // recording too, so the one legacy command below is the only ownable one.
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await allocate({ idempotencyKey: `rec-${i}-${uid}` })).command.commandId);
    const legacy = (await allocate({ idempotencyKey: `legacy-${uid}` })).command.commandId;
    for (const d of (await db.collection("commands").where("status", "==", "pending").get()).docs) {
      if (d.id !== legacy) await d.ref.update({ "admission.recording": 1 });
    }
    for (const d of (await db.collection("commands").where("publication.state", "==", "due").get()).docs) {
      if (d.id !== legacy) await d.ref.update({ "admission.recording": 1 });
    }
    // The legacy command expires last, behind every recording one.
    await db.collection("commands").doc(legacy).update({ "owner.leaseExpiresAt": now - 1 });
    expect((await paged.listDue({ now, limit: 1 })).map(c => c.commandId)).toEqual([legacy]);
    const all = (await paged.listDue({ now, limit: 50, recording: 1 })).map(c => c.commandId);
    expect(all).toEqual(expect.arrayContaining([...ids, legacy]));
  }, 30_000);

  // C5 (§3): a command with no connection is marked v3, and only a worker
  // that runs v3 commands lists, renews or takes it over.
  it("allocates a command with no connection, and hands it only to a worker that declares scopes", async () => {
    const { command } = await allocate({ connectionId: null, idempotencyKey: `scoped-${uid}` });
    expect(command).toMatchObject({ connectionId: null, scopes: 1, binding: { connectionId: null } });
    expect((await invocations.get(command.invocationId)).connectionId).toBeNull();
    const again = await allocate({ connectionId: null, idempotencyKey: `scoped-${uid}` });
    expect(again).toMatchObject({ reused: true, command: { commandId: command.commandId } });
    await expect(commands.renewLease({ commandId: command.commandId, worker: "api-1", generation: 1, now: T0 + 1 })).rejects.toMatchObject({ reason: "worker-unsupported" });
    expect(await commands.renewLease({ commandId: command.commandId, worker: "api-1", generation: 1, now: T0 + 1, scopes: 1 })).toMatchObject({ scopes: 1 });
    const now = T0 + 10 * COMMAND_LEASE_MS;
    expect((await commands.listDue({ now, limit: 50 })).map(c => c.commandId)).not.toContain(command.commandId);
    expect((await commands.listDue({ now, limit: 50, recording: 1, repairs: 1, scopes: 1 })).map(c => c.commandId)).toContain(command.commandId);
    await expect(commands.takeOver({ commandId: command.commandId, worker: "api-2", expectedGeneration: 1, now })).rejects.toMatchObject({ reason: "worker-unsupported" });
    expect(await commands.takeOver({ commandId: command.commandId, worker: "api-2", expectedGeneration: 1, now, scopes: 1 })).toMatchObject({ owner: { generation: 2, scopes: 1 } });
  });

  // The owner's re-review of #402: a lease records whether its owner runs v3
  // commands, and an older owner's lease ends when its command becomes v3.
  it("records the owner's capability on the lease, and ends an older owner's lease when its command becomes v3", async () => {
    const { command: scoped } = await allocate({ idempotencyKey: `cap-1-${uid}`, scopes: 1 });
    expect(scoped.owner).toMatchObject({ generation: 1, scopes: 1 });
    const { command } = await allocate({ idempotencyKey: `cap-2-${uid}` });
    expect(command.owner).not.toHaveProperty("scopes");
    const text = JSON.stringify({ lang: "0013", intents: [{ id: "snap", fn: "snap", op: "gcs.put-thumbnail", occurrences: ["n0.0"], scope: { kind: "item", id: "item-1" } }] });
    await records.installModel({ commandId: command.commandId, generation: 1, stage: "s0", text });
    const marked = await commands.get(command.commandId);
    expect(marked).toMatchObject({ scopes: 1, status: "pending", owner: { generation: 1, leaseExpiresAt: T0 + 1000 } });
    await expect(records.installModel({ commandId: command.commandId, generation: 1, stage: "s1", text })).rejects.toMatchObject({ reason: "lease-expired" });
  });

  // C5d (docs/c5d-refusal-and-hold-plan.md decisions 6–8, 10, 11, §4 "Hold"):
  // the hold in real transactions, decided on the emulator's read time. A
  // command allocated at T0 expired long ago; one allocated at Date.now() has
  // a live lease.
  describe("the command hold", () => {
    let holds;
    beforeAll(() => {
      holds = createFirestoreHolds(db);
    });
    const APPLIED_BY = { email: "owner@example.com", verifiedVia: "tokeninfo", azp: "123.apps.googleusercontent.com" };
    const act = (commandId, over = {}) => ({
      commandId, actId: randomUUID(), reason: "definite-refusal-unsettled", note: "held until the owner decides", decision: "docs/c5d-refusal-and-hold-plan.md", decidedBy: "owner", appliedBy: APPLIED_BY, ...over,
    });
    const CAPS = [0, 1].flatMap(recording => [0, 1].flatMap(repairs => [0, 1].map(scopes => ({ recording, repairs, scopes }))));
    const ref = id => db.collection("commands").doc(id);
    const history = async id => (await ref(id).collection("holds").get()).docs.map(d => d.data()).sort((a, b) => a.n - b.n);
    const subcollections = async id => {
      const out = {};
      for (const c of await ref(id).listCollections()) {
        if (c.id !== "holds") out[c.id] = (await c.get()).docs.map(d => [d.id, d.data(), d.updateTime.toMillis()]);
      }
      return out;
    };
    const expiredCommand = async key => (await allocate({ idempotencyKey: `${key}-${uid}` })).command.commandId;
    const liveCommand = async key => (await allocate({ idempotencyKey: `${key}-${uid}`, now: Date.now() })).command.commandId;

    it("is refused over a live lease and within the margin, then applied past it, on the server's read time", async () => {
      const id = await liveCommand("live");
      const before = await ref(id).get();
      await expect(holds.applyHold(act(id))).rejects.toMatchObject({ reason: "lease-live" });
      // Ended 90 s ago by Firestore's clock: still within the 100 s margin.
      await ref(id).update({ "owner.leaseExpiresAt": Date.now() - 90_000 });
      await expect(holds.applyHold(act(id))).rejects.toMatchObject({ reason: "lease-live" });
      expect((await ref(id).get()).data().hold).toBeUndefined();
      expect(await history(id)).toEqual([]);
      const expires = Date.now() - HOLD_MARGIN_MS - 5_000;
      await ref(id).update({ "owner.leaseExpiresAt": expires });
      const applied = await holds.applyHold(act(id));
      expect(applied.record).toMatchObject({ n: 1, act: "apply", fencing: "lease-expired", generation: 1, leaseExpiresAt: expires, appliedBy: APPLIED_BY, lifts: null });
      expect(applied.record.readTime).toBeGreaterThanOrEqual(expires + HOLD_MARGIN_MS);
      expect(Math.abs(applied.record.readTime - Date.now())).toBeLessThan(30_000);
      expect(applied.record.at).toBe(new Date(applied.record.readTime).toISOString());
      expect(before.exists).toBe(true);
    }, 30_000);

    it("holds only a pending command", async () => {
      const id = await expiredCommand("done");
      await ref(id).update({ status: "completed", publication: { state: "due", resultDigest: digest("r") } });
      await expect(holds.applyHold(act(id))).rejects.toMatchObject({ reason: "not-pending" });
      expect(await history(id)).toEqual([]);
      await expect(holds.applyHold(act(commandIdFor(uid, "none")))).rejects.toMatchObject({ reason: "command-not-found" });
    });

    it("changes nothing but the hold, the history allocates 1, 2, 3, and a lift restores the record exactly", async () => {
      const id = await expiredCommand("shape");
      await ref(id).collection("outcomes").doc("s0:n0.0").set({ stage: "s0", occurrenceId: "n0.0", outcome: "failed" });
      const before = (await ref(id).get()).data();
      const subBefore = await subcollections(id);
      const first = await holds.applyHold(act(id));
      const held = (await ref(id).get()).data();
      const { hold, ...rest } = held;
      expect(rest).toEqual(before);
      expect(hold).toMatchObject({ n: 1, actId: first.record.actId, reason: "definite-refusal-unsettled", appliedBy: APPLIED_BY, generation: 1 });
      expect(await subcollections(id)).toEqual(subBefore);
      const lift = await holds.liftHold(act(id, { lifts: first.record.actId, reason: "owner-lifted" }));
      expect((await ref(id).get()).data()).toEqual(before);
      expect(await subcollections(id)).toEqual(subBefore);
      // Due again once lifted, at every capability.
      expect((await commands.listDue({ now: Date.now(), limit: 500, recording: 1, repairs: 1, scopes: 1 })).map(c => c.commandId)).toContain(id);
      const second = await holds.applyHold(act(id));
      expect([first, lift, second].map(r => [r.record.n, r.record.act])).toEqual([[1, "apply"], [2, "lift"], [3, "apply"]]);
      expect((await history(id)).map(h => [h.n, h.act, h.actId])).toEqual([[1, "apply", first.record.actId], [2, "lift", lift.record.actId], [3, "apply", second.record.actId]]);
      expect(lift.record).toMatchObject({ lifts: first.record.actId, fencing: null });
    }, 30_000);

    it("answers a retry of a committed act replayed, writing nothing, even after a later lift", async () => {
      const id = await expiredCommand("retry");
      const request = act(id);
      const first = await holds.applyHold(request);
      const updated = (await ref(id).get()).updateTime.toMillis();
      expect(await holds.applyHold(request)).toMatchObject({ replayed: true, record: first.record });
      expect((await ref(id).get()).updateTime.toMillis()).toBe(updated);
      const liftRequest = act(id, { lifts: first.record.actId });
      await holds.liftHold(liftRequest);
      const lifted = (await ref(id).get()).updateTime.toMillis();
      expect(await holds.applyHold(request)).toMatchObject({ replayed: true, record: { n: 1 } });
      expect(await holds.liftHold(liftRequest)).toMatchObject({ replayed: true, record: { n: 2 } });
      expect((await ref(id).get()).updateTime.toMillis()).toBe(lifted);
      expect(await history(id)).toHaveLength(2);
      expect((await ref(id).get()).data().hold).toBeUndefined();
    }, 30_000);

    it("gives concurrent applies one hold and refuses the others already-held; one act id racing itself, one entry", async () => {
      const id = await expiredCommand("race");
      const results = await Promise.allSettled([1, 2].map(() => holds.applyHold(act(id))));
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter(x => x.status === "rejected")) expect((r as PromiseRejectedResult).reason).toMatchObject({ reason: "already-held" });
      expect(await history(id)).toHaveLength(1);
      const other = await expiredCommand("race-same");
      const request = act(other);
      const same = await Promise.all([1, 2].map(() => holds.applyHold(request)));
      expect(same.filter(r => !r.replayed)).toHaveLength(1);
      expect(await history(other)).toHaveLength(1);
    }, 30_000);

    it("refuses a lift naming another act, changing nothing", async () => {
      const id = await expiredCommand("wrong-lift");
      await expect(holds.liftHold(act(id, { lifts: randomUUID() }))).rejects.toMatchObject({ reason: "not-held" });
      await holds.applyHold(act(id));
      const before = await ref(id).get();
      await expect(holds.liftHold(act(id, { lifts: randomUUID() }))).rejects.toMatchObject({ reason: "hold-mismatch" });
      expect((await ref(id).get()).updateTime.toMillis()).toBe(before.updateTime.toMillis());
      expect(await history(id)).toHaveLength(1);
    }, 30_000);

    it("is skipped by due selection at every capability, paging on past it to an ownable command", async () => {
      const paged = createFirestoreCommandStore(db, { duePage: 1 });
      const held = await expiredCommand("due-held");
      const free = await expiredCommand("due-free");
      // The held command expires first, so the scan meets it first.
      await ref(held).update({ "owner.leaseExpiresAt": 1 });
      await ref(free).update({ "owner.leaseExpiresAt": 2 });
      await holds.applyHold(act(held));
      for (const caps of CAPS) {
        expect((await commands.listDue({ now: Date.now(), limit: 1, ...caps })).map(c => c.commandId)).toEqual([free]);
        expect((await paged.listDue({ now: Date.now(), limit: 1, ...caps })).map(c => c.commandId)).toEqual([free]);
      }
      await ref(free).update({ "owner.leaseExpiresAt": T0 });
    }, 30_000);

    it("refuses takeover at every capability and renewal command-held", async () => {
      const id = await expiredCommand("fence");
      await holds.applyHold(act(id));
      const before = (await ref(id).get()).data();
      for (const caps of CAPS) {
        await expect(commands.takeOver({ commandId: id, worker: "api-2", expectedGeneration: 1, now: Date.now(), ...caps })).rejects.toMatchObject({ reason: "command-held" });
      }
      await expect(commands.renewLease({ commandId: id, worker: "api-1", generation: 1, now: Date.now() })).rejects.toMatchObject({ reason: "lease-expired" });
      expect((await ref(id).get()).data()).toEqual(before);
      // Defense in depth: a held command with a live lease.
      await ref(id).update({ "owner.leaseExpiresAt": Date.now() + COMMAND_LEASE_MS });
      await expect(commands.renewLease({ commandId: id, worker: "api-1", generation: 1, now: Date.now(), recording: 1, repairs: 1, scopes: 1 })).rejects.toMatchObject({ reason: "command-held" });
      await expect(records.installInput({ commandId: id, generation: 1, stage: "s0", text: "{}" })).rejects.toMatchObject({ reason: "command-held" });
    }, 30_000);

    // Races with a live worker: one transaction on commands/{id} decides.
    const raced = async (id, other) => {
      const [taken, held] = await Promise.allSettled([other(), holds.applyHold(act(id))]);
      const doc = (await ref(id).get()).data();
      if (taken.status === "fulfilled") {
        expect(held).toMatchObject({ status: "rejected", reason: { reason: "lease-live" } });
        expect(doc.hold).toBeUndefined();
        expect(doc.owner.generation).toBe(2);
      } else {
        expect(taken.reason).toMatchObject({ reason: "command-held" });
        expect(held.status).toBe("fulfilled");
        expect(doc.owner.generation).toBe(1);
      }
      expect(await history(id)).toHaveLength(held.status === "fulfilled" ? 1 : 0);
    };

    it("lets exactly one of a takeover and an apply win", async () => {
      for (let i = 0; i < 4; i++) {
        const id = await expiredCommand(`race-takeover-${i}`);
        await raced(id, () => commands.takeOver({ commandId: id, worker: "api-2", expectedGeneration: 1, now: Date.now() }));
      }
    }, 60_000);

    it("lets exactly one of an allocation-path takeover and an apply win", async () => {
      for (let i = 0; i < 4; i++) {
        const key = `race-alloc-${i}`;
        const id = await expiredCommand(key);
        await raced(id, async () => {
          const again = await allocate({ idempotencyKey: `${key}-${uid}`, worker: "api-2" });
          expect(again).toMatchObject({ protocol: "command", reused: true });
          return commands.takeOver({ commandId: id, worker: "api-2", expectedGeneration: 1, now: Date.now() });
        });
      }
    }, 60_000);

    it("refuses the hold while a renewing owner's lease is live", async () => {
      const id = await liveCommand("race-renew");
      const [renewed, held] = await Promise.allSettled([
        commands.renewLease({ commandId: id, worker: "api-1", generation: 1, now: Date.now() }),
        holds.applyHold(act(id)),
      ]);
      expect(renewed.status).toBe("fulfilled");
      expect(held).toMatchObject({ status: "rejected", reason: { reason: "lease-live" } });
      expect((await ref(id).get()).data().hold).toBeUndefined();
      expect(await history(id)).toEqual([]);
    }, 30_000);
  });
});
