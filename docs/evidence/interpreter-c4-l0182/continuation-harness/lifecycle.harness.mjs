// Executable evidence for the runtime and lifecycle choices selected on
// 2026-11-27 (docs/c4-runtime-lifecycle.md §10): settlement records, the
// session pin and operation index (including replay after a lost response
// or a configuration change), the ordered recovery rows, and the retained
// per-revision descriptor through archive and expiry. Emulator only
// (src/stores.mjs). W0–W3 withdrawal was not selected and is not covered.

import { afterAll, describe, expect, it } from "@jest/globals";
import { closeStores, makeStores } from "./src/stores.mjs";
import {
  ProtocolError,
  ackFinalized,
  archiveItem,
  bindPrepare,
  cancelApi,
  closeBarrier,
  consoleWrite,
  createItem,
  deriveAuthority,
  drainCounts,
  finalize,
  openBarrier,
  readAssignment,
  readBinding,
  readCop,
  readHistory,
  readItem,
  readOp,
} from "./src/protocol.mjs";
import { Crash, STEPS } from "./src/driver.mjs";
import {
  INTERVAL_MS,
  THRESHOLD_MS,
  ackSettled,
  configCheck,
  namespaceOf,
  readIndex,
  readPin,
  readSettlement,
  recoveryPass,
  registerRouted,
  runRoutedChild,
  scopedStores,
  submitRouted,
  visibleItems,
} from "./src/lifecycle.mjs";

afterAll(closeStores);

// ---------------------------------------------------------------------------
// Fixtures

const user = uid => ({ kind: "user", uid, installation: "graffiticode" });
const freePlan = workspace => ({ kind: "freePlan", uid: "trial", workspace, installation: "graffiticode" });
const WS_A = freePlan("ws-a");
const WS_B = freePlan("ws-b");
const P = user("p");
const Q = user("q");
// Canary-owned fixtures (§9): the canary and verify accounts and two canary
// free-plan workspaces.
const CANARY = user("canary");
const VERIFY = user("verify");
const CWS_A = freePlan("canary-ws-a");
const CWS_B = freePlan("canary-ws-b");

const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;
const config = (over = {}) => ({
  canarySessions: ["c1"],
  canaryPrincipals: [CANARY, VERIFY, CWS_A, CWS_B],
  now: () => T0,
  ...over,
});

// Fresh stores with both namespaces' barriers open; an unbound production
// session x1 (WS_A's item) and an unbound canary session c1 (CWS_A's item).
async function setup(label) {
  const stores = makeStores(label);
  const prod = scopedStores(stores, "production");
  const canary = scopedStores(stores, "canary");
  await openBarrier(prod.api);
  await openBarrier(canary.api);
  await createItem(prod.console, { id: "x1", owner: WS_A });
  await createItem(canary.console, { id: "c1", owner: CWS_A });
  return { stores, prod, canary };
}
const request = (opId, over = {}) => ({
  opId,
  session: "x1",
  source: "x1",
  sourceVersion: 1,
  expectedRevision: 0,
  caller: WS_A,
  destPrincipal: P,
  ...over,
});
const canaryRequest = (opId, over = {}) =>
  request(opId, { session: "c1", source: "c1", caller: CWS_A, destPrincipal: VERIFY, ...over });
const refusedWith = async (promise, code) => {
  const err = await promise.then(
    () => null,
    e => e,
  );
  expect(err).toBeInstanceOf(ProtocolError);
  expect(err.code).toBe(code);
  return err;
};
const crashed = promise => expect(promise).rejects.toBeInstanceOf(Crash);
const opDoc = async (s, opId) => {
  const snap = await s.api.doc("respondent-operations", opId).get();
  return { data: snap.data(), updateTime: snap.updateTime.toMillis() };
};
const countOps = async s => (await s.api.col("respondent-operations").get()).size;
const zero = {
  nonTerminalOperations: 0,
  preparedBindings: 0,
  nonTerminalConsoleOperations: 0,
  lockedItems: 0,
  missingTombstones: 0,
  outstandingAcks: 0,
  unsettledOperations: 0,
};

// ---------------------------------------------------------------------------

describe("§7 settlement: a separate record, so terminal operations stay immutable (I6)", () => {
  it("C0 creates an unsettled record; the console's ack after C5 settles it without touching the operation", async () => {
    const { stores, prod } = await setup("settle-complete");
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "settle-pending" }));
    expect(await readSettlement(prod.api, "op-1")).toEqual({ opId: "op-1", settled: false, createdAt: T0 });
    expect((await drainCounts(prod)).unsettledOperations).toBe(1);
    const before = await opDoc(prod, "op-1");
    expect(before.data.state).toBe("completed");
    await ackSettled(prod.api, "op-1", await readCop(prod.console, "op-1"), { now: T0 + 1 });
    expect(await readSettlement(prod.api, "op-1")).toMatchObject({ settled: true, outcome: "completed", at: T0 + 1 });
    expect(await opDoc(prod, "op-1")).toEqual(before); // same data, same update time
    expect(await drainCounts(prod)).toEqual(zero);
  });
  it("the ack is refused before the operation is terminal, or with console evidence that doesn't match", async () => {
    const { stores, prod } = await setup("settle-guards");
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "C3" }));
    await refusedWith(ackSettled(prod.api, "op-1", await readCop(prod.console, "op-1")), "not-terminal");
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "C4" }));
    // The api is completed, but the console hasn't unlocked yet.
    await refusedWith(ackSettled(prod.api, "op-1", await readCop(prod.console, "op-1")), "console-not-settled");
    expect((await readSettlement(prod.api, "op-1")).settled).toBe(false);
  });
  it("a cancelled operation settles after cleanup, and its record is never written again", async () => {
    const { stores, prod } = await setup("settle-cancel");
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "C1" }));
    await recoveryPass(stores, { now: T0 + THRESHOLD_MS + MIN });
    const before = await opDoc(prod, "op-1");
    expect(before.data).toMatchObject({ state: "cancelled", cancelReason: "abandoned" });
    expect(await readSettlement(prod.api, "op-1")).toMatchObject({ settled: true, outcome: "cancelled" });
    await ackSettled(prod.api, "op-1", await readCop(prod.console, "op-1")); // a repeat: a no-op
    expect(await opDoc(prod, "op-1")).toEqual(before);
  });
});

describe("§9 namespaces: the session pin and the operation index", () => {
  it("the first C0 pins its session and indexes its operation; canary sessions write only canary collections", async () => {
    const { stores, prod, canary } = await setup("ns-first");
    const out = await runRoutedChild(stores, config(), canaryRequest("op-c"));
    expect(out.namespace).toBe("canary");
    expect(await readPin(stores, "c1")).toEqual({ namespace: "canary", at: T0 });
    expect(await readIndex(stores, "op-c")).toMatchObject({ namespace: "canary", session: "c1" });
    expect(await namespaceOf(stores, "op-c")).toBe("canary");
    // Every later step used the recorded namespace, in both stores.
    expect((await readBinding(canary.api, "c1")).active).toMatchObject({ principal: VERIFY, revision: 1 });
    expect((await readCop(canary.console, "op-c")).state).toBe("completed");
    expect((await readItem(canary.console, out.T)).state).toBe("active");
    expect(await countOps(prod)).toBe(0);
    expect(await readCop(prod.console, "op-c")).toBeNull();
    expect(await readItem(prod.console, out.T)).toBeNull();
    expect(await drainCounts(canary)).toEqual(zero);
  });
  it("a C0 retry after a lost response replays in its original namespace though the list now names the session", async () => {
    const { stores, prod, canary } = await setup("ns-lost-response");
    const first = await registerRouted(stores, config(), request("op-1")); // the response is lost
    expect(first.namespace).toBe("production");
    const moved = config({ canarySessions: ["c1", "x1"] });
    const retry = await registerRouted(stores, moved, request("op-1"));
    expect(retry).toMatchObject({ namespace: "production", via: "index", T: first.T });
    expect(await countOps(canary)).toBe(0);
    expect(await readIndex(stores, "op-1")).toMatchObject({ namespace: "production" });
    // The rest of the operation completes in production under the moved list.
    const out = await runRoutedChild(stores, moved, request("op-1"));
    expect(out).toMatchObject({ namespace: "production", T: first.T });
    expect(await readHistory(prod.api, "x1")).toHaveLength(1);
    expect(await readHistory(canary.api, "x1")).toHaveLength(0);
  });
  it("a retry with a different request under the same opId is operation-mismatch, whatever the list says", async () => {
    const { stores, canary } = await setup("ns-mismatch");
    await registerRouted(stores, config(), request("op-1"));
    const moved = config({ canarySessions: ["x1"], canaryPrincipals: [WS_A, Q, P] });
    await refusedWith(registerRouted(stores, moved, request("op-1", { destPrincipal: Q })), "operation-mismatch");
    expect(await countOps(canary)).toBe(0);
  });
  it("a pinned session keeps its namespace for new operations after the list changes", async () => {
    const { stores, prod, canary } = await setup("ns-pin");
    // A freeze is the first write for x1, so it creates the pin.
    const derived = { x1: await deriveAuthority(prod.console, "x1") };
    await submitRouted(stores, config(), { sessions: ["x1"], caller: WS_A, submitter: WS_A, taskId: "t1", derived });
    expect(await readPin(stores, "x1")).toMatchObject({ namespace: "production" });
    const moved = config({ canarySessions: ["c1", "x1"] });
    const out = await runRoutedChild(stores, moved, request("op-1"));
    expect(out.namespace).toBe("production");
    expect(await countOps(canary)).toBe(0);
    expect(await configCheck(stores, moved)).toEqual({ listedButProduction: ["x1"], unlistedButCanary: [] });
  });
  it("the configuration check reports an unlisted session pinned canary; the pin still wins", async () => {
    const { stores } = await setup("ns-check");
    await runRoutedChild(stores, config(), canaryRequest("op-c"));
    const dropped = config({ canarySessions: [] });
    expect(await configCheck(stores, dropped)).toEqual({ listedButProduction: [], unlistedButCanary: ["c1"] });
    expect(await namespaceOf(stores, "op-c")).toBe("canary");
  });
  it("a canary operation naming a non-canary principal is refused, and writes nothing", async () => {
    const { stores, canary } = await setup("ns-fixtures");
    await refusedWith(registerRouted(stores, config(), canaryRequest("op-c", { destPrincipal: P })), "canary-fixture-only");
    expect(await readPin(stores, "c1")).toBeNull();
    expect(await readIndex(stores, "op-c")).toBeNull();
    expect(await countOps(canary)).toBe(0);
  });
  it("the barriers are separate: production closed, canary open", async () => {
    const { stores, prod } = await setup("ns-barriers");
    await closeBarrier(prod.api);
    const err = await refusedWith(registerRouted(stores, config(), request("op-p")), "barrier-closed");
    expect(err.temporary).toBe(true);
    expect(await readPin(stores, "x1")).toBeNull(); // the refused transaction wrote nothing
    const out = await runRoutedChild(stores, config(), canaryRequest("op-c"));
    expect(out.namespace).toBe("canary");
  });
  it("a canary submission by a non-canary principal is refused, and leaves no pin and no freeze", async () => {
    const { stores, canary } = await setup("ns-submit-fixtures");
    const forged = { c1: { principal: P } }; // whatever authority evidence is supplied
    await refusedWith(
      submitRouted(stores, config(), { sessions: ["c1"], caller: P, submitter: P, taskId: "t1", derived: forged }),
      "canary-fixture-only",
    );
    expect(await readPin(stores, "c1")).toBeNull();
    expect(await readAssignment(canary.api, "c1")).toBeNull();
    // Once pinned canary, the same restriction holds.
    await runRoutedChild(stores, config(), canaryRequest("op-c"));
    await refusedWith(
      submitRouted(stores, config(), { sessions: ["c1"], caller: P, submitter: P, taskId: "t2", derived: forged }),
      "canary-fixture-only",
    );
    expect(await readAssignment(canary.api, "c1")).toBeNull();
    const out = await submitRouted(stores, config(), { sessions: ["c1"], caller: VERIFY, submitter: VERIFY, taskId: "t3" });
    expect(out).toMatchObject({ frozen: ["c1"], namespace: "canary" });
  });
  it("a submission whose sessions resolve to different namespaces is refused", async () => {
    const { stores } = await setup("ns-mixed");
    await refusedWith(
      submitRouted(stores, config(), { sessions: ["x1", "c1"], caller: WS_A, submitter: WS_A, taskId: "t1", derived: {} }),
      "namespace-mixed",
    );
  });
});

describe("§7 recovery: the runner's ordered, api-phase-guarded rows", () => {
  it("uses the selected healthy-service targets", () => {
    expect(THRESHOLD_MS).toBe(15 * MIN);
    expect(INTERVAL_MS).toBe(5 * MIN);
  });
  it("leaves an operation younger than the threshold alone", async () => {
    const { stores, prod } = await setup("rec-young");
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "C1" }));
    expect(await recoveryPass(stores, { now: T0 + 10 * MIN })).toEqual([]);
    expect((await readOp(prod.api, "op-1")).state).toBe("registered");
  });
  const expected = { C0: "cancelled", C1: "cancelled", C2: "cancelled", C3: "completed", C3a: "completed", C4: "completed", C5: "completed" };
  it.each(STEPS)("after a crash after %s, one pass settles the operation and drains the protocol", async step => {
    const { stores, prod } = await setup(`rec-${step}`);
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: step }));
    await recoveryPass(stores, { now: T0 + THRESHOLD_MS + MIN });
    const op = await readOp(prod.api, "op-1");
    expect(op.state).toBe(expected[step]);
    expect(await readSettlement(prod.api, "op-1")).toMatchObject({ settled: true, outcome: expected[step] });
    if (expected[step] === "cancelled") {
      expect(op.cancelReason).toBe("abandoned");
      expect((await readItem(prod.console, "x1")).state).toBe("open");
      expect(await readHistory(prod.api, "x1")).toEqual([]);
    } else {
      expect((await readItem(prod.console, op.T)).state).toBe("active");
      expect(await readHistory(prod.api, "x1")).toHaveLength(1);
    }
    expect(await drainCounts(prod)).toEqual(zero);
  });
  it("a finalized continuation is rolled forward: C3a resent while prepared, then C4, C5 and settlement", async () => {
    const { stores } = await setup("rec-roll-forward");
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "C3" }));
    const [entry] = await recoveryPass(stores, { now: T0 + THRESHOLD_MS + MIN });
    expect(entry.actions).toEqual(["C3a", "C4", "C5", "settle"]);
  });
  it("an api-cancelled operation whose console is still finalized is cleaned up first; no ack is resent", async () => {
    const { stores, prod } = await setup("rec-cancel-precedence");
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "C3" }));
    await cancelApi(prod.api, "op-1", { reason: "operator" }); // the console cleanup never ran
    expect((await readCop(prod.console, "op-1")).state).toBe("finalized");
    const [entry] = await recoveryPass(stores, { now: T0 + THRESHOLD_MS + MIN });
    expect(entry.actions).toEqual(["cleanup", "settle"]);
    const op = await readOp(prod.api, "op-1");
    expect(op.ack?.finalized).toBeUndefined();
    expect(op.cancelReason).toBe("operator");
    expect((await readItem(prod.console, "x1")).state).toBe("open");
    expect((await readItem(prod.console, op.T)).state).toBe("cancelled");
    expect(await drainCounts(prod)).toEqual(zero);
  });
  it("a completed operation awaiting only its settled ack is settled, with no other write", async () => {
    const { stores, prod } = await setup("rec-settle-only");
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "settle-pending" }));
    const before = await opDoc(prod, "op-1");
    const [entry] = await recoveryPass(stores, { now: T0 + THRESHOLD_MS + MIN });
    expect(entry.actions).toEqual(["settle"]);
    expect(await opDoc(prod, "op-1")).toEqual(before);
  });
  it("a runner pass racing a client resume converges on one completion", async () => {
    const { stores, prod } = await setup("rec-race");
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "C3" }));
    const [client] = await Promise.allSettled([
      runRoutedChild(stores, config(), request("op-1")),
      recoveryPass(stores, { now: T0 + THRESHOLD_MS + MIN }),
    ]);
    // The client may lose a step to the runner (a refusal); a resume settles.
    if (client.status === "rejected") await runRoutedChild(stores, config(), request("op-1"));
    await recoveryPass(stores, { now: T0 + THRESHOLD_MS + 2 * MIN });
    expect((await readOp(prod.api, "op-1")).state).toBe("completed");
    expect(await readHistory(prod.api, "x1")).toHaveLength(1);
    expect(await drainCounts(prod)).toEqual(zero);
  });
  it("a C3a committing between the runner's snapshot and its cancel refuses the cancel; recovery restarts and rolls forward", async () => {
    const { stores, prod } = await setup("rec-advance-ack");
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "C2" }));
    let raced = false;
    const before = async name => {
      if (name !== "cancel" || raced) return;
      raced = true; // the client finishes C3 and C3a after the runner's snapshot
      await finalize(prod.console, await readOp(prod.api, "op-1"));
      const op = await readOp(prod.api, "op-1");
      await ackFinalized(prod.api, { opId: "op-1", revision: 1, T: op.T, X: "x1" });
    };
    const [entry] = await recoveryPass(stores, { now: T0 + THRESHOLD_MS + MIN, hooks: { before } });
    expect(entry.actions).toEqual(["cancel:refused:phase-advanced", "C4", "C5", "settle"]);
    const op = await readOp(prod.api, "op-1");
    expect(op.state).toBe("completed");
    expect(op.cancelReason).toBeUndefined();
    expect(await readHistory(prod.api, "x1")).toHaveLength(1);
    expect(await drainCounts(prod)).toEqual(zero);
  });
  it("a C2 committing between the runner's snapshot and its cancel refuses that cancel; the restart re-reads the phase", async () => {
    const { stores, prod } = await setup("rec-advance-prepare");
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "C1" }));
    let raced = false;
    const before = async name => {
      if (name !== "cancel" || raced) return;
      raced = true;
      await bindPrepare(prod.api, "op-1");
    };
    const [entry] = await recoveryPass(stores, { now: T0 + THRESHOLD_MS + MIN, hooks: { before } });
    // The prepared operation still has no finalized console: row 9 again, now
    // with the prepared phase as its precondition.
    expect(entry.actions).toEqual(["cancel:refused:phase-advanced", "cancel", "cleanup", "settle"]);
    expect((await readOp(prod.api, "op-1")).state).toBe("cancelled");
    expect(await drainCounts(prod)).toEqual(zero);
  });
  it("a submission racing a prepared continuation is refused temporarily, not queued; it succeeds after recovery", async () => {
    const { stores, prod } = await setup("rec-submit");
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "C2" }));
    const derived = { x1: await deriveAuthority(prod.console, "x1") };
    const args = { sessions: ["x1"], caller: WS_A, submitter: WS_A, taskId: "t1", derived };
    const err = await refusedWith(submitRouted(stores, config(), args), "respondent-continuing");
    expect(err.temporary).toBe(true);
    expect(await readAssignment(prod.api, "x1")).toBeNull();
    await recoveryPass(stores, { now: T0 + THRESHOLD_MS + MIN });
    expect(await submitRouted(stores, config(), args)).toMatchObject({ frozen: ["x1"], namespace: "production" });
  });
});

describe("§6 the retained per-revision descriptor: archive and expiry never withdraw authority", () => {
  it("archiving the bound destination T leaves the descriptor and pointer, and its respondent can still submit", async () => {
    const { stores, prod } = await setup("desc-archive");
    const out = await runRoutedChild(stores, config(), request("op-1"));
    const [descriptor] = await readHistory(prod.api, "x1");
    expect(descriptor).toMatchObject({ revision: 1, principal: P, destination: out.T, opId: "op-1" });
    expect(descriptor.readyAt).toBeDefined();
    const pointer = await readBinding(prod.api, "x1");
    await archiveItem(prod.console, out.T);
    expect(await visibleItems(prod.console, P, { now: T0 })).toEqual([]);
    expect(await readBinding(prod.api, "x1")).toEqual(pointer);
    expect(await readHistory(prod.api, "x1")).toEqual([descriptor]);
    await refusedWith(submitRouted(stores, config(), { sessions: ["x1"], caller: Q, submitter: Q, taskId: "t1" }), "not-respondent");
    const out2 = await submitRouted(stores, config(), { sessions: ["x1"], caller: P, submitter: P, taskId: "t1" });
    expect(out2.frozen).toEqual(["x1"]);
    expect((await readAssignment(prod.api, "x1")).frozen).toMatchObject({ principal: P, revision: 1 });
  });
  it("a later continuation moves the mutable pointer; the earlier descriptor and freeze are unchanged", async () => {
    const { stores, prod } = await setup("desc-transfer");
    const first = await runRoutedChild(stores, config(), request("op-1"));
    await submitRouted(stores, config(), { sessions: ["x1"], caller: P, submitter: P, taskId: "t1" });
    const [d1] = await readHistory(prod.api, "x1");
    const transfer = request("op-2", { source: first.T, expectedRevision: 1, caller: P, destPrincipal: Q });
    const second = await runRoutedChild(stores, config(), transfer);
    const history = await readHistory(prod.api, "x1");
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(d1);
    expect(history[1]).toMatchObject({ revision: 2, principal: Q, destination: second.T, opId: "op-2" });
    expect((await readBinding(prod.api, "x1")).active).toMatchObject({ revision: 2, principal: Q, destination: second.T });
    expect((await readAssignment(prod.api, "x1")).frozen).toMatchObject({ principal: P, revision: 1 });
  });
  it("an unbound free-plan session keeps its derived authority after its item expires and is archived", async () => {
    const stores = makeStores("desc-expiry");
    const prod = scopedStores(stores, "production");
    await openBarrier(prod.api);
    await createItem(prod.console, { id: "x9", owner: WS_A, expiresAt: T0 - MIN });
    await archiveItem(prod.console, "x9");
    expect(await visibleItems(prod.console, WS_A, { now: T0 })).toEqual([]);
    const derived = { x9: await deriveAuthority(prod.console, "x9") };
    expect(derived.x9).toEqual({ principal: WS_A });
    await refusedWith(
      submitRouted(stores, config(), { sessions: ["x9"], caller: WS_B, submitter: WS_B, taskId: "t1", derived }),
      "not-respondent",
    );
    const out = await submitRouted(stores, config(), { sessions: ["x9"], caller: WS_A, submitter: WS_A, taskId: "t1", derived });
    expect(out.frozen).toEqual(["x9"]);
    expect((await readAssignment(prod.api, "x9")).frozen).toMatchObject({ principal: WS_A, revision: 0 });
  });
  it("a claimed source's expiry changes nothing: authority stays with the binding", async () => {
    const stores = makeStores("desc-source-expiry");
    const prod = scopedStores(stores, "production");
    await openBarrier(prod.api);
    await createItem(prod.console, { id: "x1", owner: WS_A, expiresAt: T0 + MIN });
    const out = await runRoutedChild(stores, config(), request("op-1"));
    expect(await visibleItems(prod.console, WS_A, { now: T0 + 2 * MIN })).toEqual([]);
    expect((await readItem(prod.console, "x1")).state).toBe("read-only");
    expect((await readBinding(prod.api, "x1")).active).toMatchObject({ principal: P, destination: out.T });
    expect((await submitRouted(stores, config(), { sessions: ["x1"], caller: P, submitter: P, taskId: "t1" })).frozen).toEqual(["x1"]);
  });
  it("a completed continuation's read-only source can be archived; it still refuses answers and edits", async () => {
    const { stores, prod } = await setup("desc-archive-source");
    await runRoutedChild(stores, config(), request("op-1"));
    await archiveItem(prod.console, "x1");
    expect(await readItem(prod.console, "x1")).toMatchObject({ state: "read-only", mark: 5, lockOp: "op-1" });
    await refusedWith(consoleWrite(prod.console, "x1", "answer"), "item-locked");
    await refusedWith(consoleWrite(prod.console, "x1", "edit"), "item-locked");
    expect((await readBinding(prod.api, "x1")).active).toMatchObject({ principal: P, revision: 1 });
  });
  it("archive is refused while an item is locked by a continuation", async () => {
    const { stores, prod } = await setup("desc-locked");
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "C3" }));
    const { T } = await readOp(prod.api, "op-1");
    await refusedWith(archiveItem(prod.console, "x1"), "item-locked");
    await refusedWith(archiveItem(prod.console, T), "item-locked");
    expect((await readItem(prod.console, T)).mark).toBe(1);
    // Past C4 but before C5, the source stays protected until the console completes.
    await crashed(runRoutedChild(stores, config(), request("op-1"), { crashAfter: "C4" }));
    await refusedWith(archiveItem(prod.console, "x1"), "item-locked");
    expect((await readItem(prod.console, "x1")).mark).toBe(1);
  });
});
