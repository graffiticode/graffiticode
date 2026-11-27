// Executable evidence for option (c) of docs/c4-continuation-race-review.md:
// the C0–C5 state machine, cancellation and tombstones, readiness
// acknowledgements, atomic authority/history/result writes, replay after
// transfer, multi-item recovery, the creation barrier, drains and floors,
// and the submission (S4) checks. Each `describe` names the §9 case or
// review finding it covers. Emulator only (src/stores.mjs).

import { afterAll, describe, expect, it } from "@jest/globals";
import { assertEmulator, closeStores, makeStores } from "./src/stores.mjs";
import {
  ProtocolError,
  activate,
  ackFinalized,
  allocate,
  bindPrepare,
  cancelApi,
  cancelConsole,
  closeBarrier,
  consoleWrite,
  createItem,
  deriveAuthority,
  drainCounts,
  finalize,
  floors,
  openBarrier,
  readAssignment,
  readBinding,
  readCop,
  readHistory,
  readItem,
  readOp,
  register,
  submit,
  unlock,
} from "./src/protocol.mjs";
import { Crash, STEPS, cancelChild, runChild, runClaim, settleRefusal, startClaim } from "./src/driver.mjs";

afterAll(closeStores);

// ---------------------------------------------------------------------------
// Fixtures

const user = uid => ({ kind: "user", uid, installation: "graffiticode" });
const freePlan = workspace => ({ kind: "freePlan", uid: "trial", workspace, installation: "graffiticode" });
const WS_A = freePlan("ws-a");
const WS_B = freePlan("ws-b");
const P = user("p");
const Q = user("q");

// A fresh pair of stores with the barrier open and one source item X, which
// is the session S (unbound, revision 0), owned by free-plan workspace A.
async function setup(label, { owner = WS_A, id = "x1" } = {}) {
  const stores = makeStores(label);
  await openBarrier(stores.api);
  await createItem(stores.console, { id, owner });
  return stores;
}
const claimRequest = (opId, over = {}) => ({
  opId,
  session: "x1",
  source: "x1",
  sourceVersion: 1,
  expectedRevision: 0,
  caller: WS_A,
  destPrincipal: P,
  ...over,
});
const refusedWith = async (promise, code) => {
  const err = await promise.then(
    () => null,
    e => e,
  );
  expect(err).toBeInstanceOf(ProtocolError);
  expect(err.code).toBe(code);
  return err;
};
// C0 to C3a, stopping just before activation.
async function prepareThroughAck(stores, request) {
  const reg = await register(stores.api, request);
  const cop = await allocate(stores.console, reg);
  const prepared = await bindPrepare(stores.api, request.opId);
  await finalize(stores.console, prepared);
  await ackFinalized(stores.api, { opId: request.opId, revision: cop.revision, T: reg.T, X: request.source });
  return reg;
}
const zeroCounts = {
  nonTerminalOperations: 0,
  preparedBindings: 0,
  nonTerminalConsoleOperations: 0,
  lockedItems: 0,
  missingTombstones: 0,
  outstandingAcks: 0,
  unsettledOperations: 0,
};

// ---------------------------------------------------------------------------

describe("the emulator guard", () => {
  it("refuses without an emulator host, or with a non-loopback one", () => {
    expect(() => assertEmulator({})).toThrow(/FIRESTORE_EMULATOR_HOST is not set/);
    expect(() => assertEmulator({ FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com:443" })).toThrow(/not a loopback/);
    expect(assertEmulator({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" })).toBe("127.0.0.1:8080");
  });
});

describe("C0–C5 happy path", () => {
  it("publishes authority at ready (C4), unlocks at C5, and leaves the protocol drained", async () => {
    const stores = await setup("happy");
    const out = await runChild(stores, claimRequest("op-1"));
    expect(out.revision).toBe(1);
    const binding = await readBinding(stores.api, "x1");
    expect(binding.active).toMatchObject({ principal: P, revision: 1, opId: "op-1", destination: out.T });
    expect(binding.prepared).toBeNull();
    expect(await readHistory(stores.api, "x1")).toEqual([
      { session: "x1", revision: 1, principal: P, opId: "op-1", destination: out.T, readyAt: expect.anything() },
    ]);
    expect((await readOp(stores.api, "op-1")).result).toEqual({ revision: 1, destination: out.T });
    expect((await readItem(stores.console, "x1")).state).toBe("read-only");
    expect(await readItem(stores.console, out.T)).toMatchObject({ state: "active", respondentSession: "x1", owner: P });
    expect(await drainCounts(stores)).toEqual(zeroCounts);
  });
});

describe("§9: authority, history and result are written atomically (I3)", () => {
  it("a replayed C4 returns the recorded result and adds no history", async () => {
    const stores = await setup("atomic");
    const out = await runChild(stores, claimRequest("op-1"));
    expect(await activate(stores.api, "op-1")).toEqual({ revision: 1, destination: out.T });
    await runChild(stores, claimRequest("op-1"));
    expect(await readHistory(stores.api, "x1")).toHaveLength(1);
  });
  it("a cancelled preparation publishes no authority and no history", async () => {
    const stores = await setup("atomic-cancel");
    await runChild(stores, claimRequest("op-1"), { crashAfter: "C2" }).catch(e => expect(e).toBeInstanceOf(Crash));
    await cancelChild(stores, "op-1");
    expect(await readHistory(stores.api, "x1")).toEqual([]);
    expect(await readBinding(stores.api, "x1")).toEqual({ active: null, prepared: null });
  });
});

describe("§9 (c): a crash at each step", () => {
  it.each(STEPS)("after %s, a replay rolls forward to completion with no duplicates", async step => {
    const stores = await setup(`crash-${step}`);
    await expect(runChild(stores, claimRequest("op-1"), { crashAfter: step })).rejects.toBeInstanceOf(Crash);
    const out = await runChild(stores, claimRequest("op-1"));
    expect(out.revision).toBe(1);
    expect(await readHistory(stores.api, "x1")).toHaveLength(1);
    expect((await readItem(stores.console, out.T)).state).toBe("active");
    expect(await drainCounts(stores)).toEqual(zeroCounts);
  });
  it.each(["C0", "C1", "C2", "C3", "C3a"])("after %s (before C4), cancellation reverts everything and leaves a tombstone", async step => {
    const stores = await setup(`crash-cancel-${step}`);
    await expect(runChild(stores, claimRequest("op-1"), { crashAfter: step })).rejects.toBeInstanceOf(Crash);
    await cancelChild(stores, "op-1");
    expect((await readItem(stores.console, "x1")).state).toBe("open");
    expect((await readCop(stores.console, "op-1")).state).toBe("cancelled");
    const T = (await readOp(stores.api, "op-1")).T;
    const t = await readItem(stores.console, T);
    if (t) expect(t.state).toBe("cancelled");
    const binding = await readBinding(stores.api, "x1");
    expect(binding?.active ?? null).toBeNull();
    expect(binding?.prepared ?? null).toBeNull();
    expect(await drainCounts(stores)).toEqual(zeroCounts);
  });
});

describe("§9 (c): cancel against finalize and activate", () => {
  it("cancel after C3 and before C4 reverts the console locks, and activate after cancel fails", async () => {
    const stores = await setup("cancel-after-c3");
    const reg = await prepareThroughAck(stores, claimRequest("op-1"));
    expect((await readItem(stores.console, "x1")).state).toBe("read-only");
    await cancelChild(stores, "op-1");
    expect((await readItem(stores.console, "x1")).state).toBe("open");
    expect((await readItem(stores.console, reg.T)).state).toBe("cancelled");
    await refusedWith(activate(stores.api, "op-1"), "operation-terminal");
    expect((await readBinding(stores.api, "x1")).active).toBeNull();
  });
  it("cancel after C4 is refused, and recovery rolls forward", async () => {
    const stores = await setup("cancel-after-c4");
    await expect(runChild(stores, claimRequest("op-1"), { crashAfter: "C4" })).rejects.toBeInstanceOf(Crash);
    await refusedWith(cancelApi(stores.api, "op-1"), "past-point-of-no-return");
    await unlock(stores.console, await readOp(stores.api, "op-1"));
    expect(await drainCounts(stores)).toEqual(zeroCounts);
  });
  it("a cancel followed by a delayed bind-prepare fails on the terminal record", async () => {
    const stores = await setup("cancel-then-c2");
    const reg = await register(stores.api, claimRequest("op-1"));
    await allocate(stores.console, reg);
    await cancelChild(stores, "op-1");
    await refusedWith(bindPrepare(stores.api, "op-1"), "operation-terminal");
    expect((await readBinding(stores.api, "x1"))?.prepared ?? null).toBeNull();
  });
});

describe("§9 (c): C0 → cancel → cleanup and drain complete → delayed C1", () => {
  it("is refused by the console tombstone, and nothing is locked", async () => {
    const stores = await setup("tombstone");
    const reg = await register(stores.api, claimRequest("op-1")); // pauses here, before C1
    await cancelApi(stores.api, "op-1");
    await cancelConsole(stores.console, await readOp(stores.api, "op-1")); // tombstone, though C1 never ran
    await closeBarrier(stores.api);
    expect(await drainCounts(stores)).toEqual(zeroCounts);
    await refusedWith(allocate(stores.console, reg), "cancelled");
    expect(await readItem(stores.console, "x1")).toMatchObject({ state: "open", lockOp: null });
    expect(await readItem(stores.console, reg.T)).toBeNull();
    expect(await drainCounts(stores)).toEqual(zeroCounts);
  });
  it("a C1 that committed before the tombstone is reverted by it", async () => {
    const stores = await setup("tombstone-before");
    const reg = await register(stores.api, claimRequest("op-1"));
    await allocate(stores.console, reg);
    await cancelChild(stores, "op-1");
    expect((await readItem(stores.console, "x1")).state).toBe("open");
    expect((await readItem(stores.console, reg.T)).state).toBe("cancelled");
  });
});

describe("§9 (c): readiness acknowledgements", () => {
  it("C2 → C4 without a successful C3 is refused, and authority doesn't move", async () => {
    const stores = await setup("no-c3");
    const reg = await register(stores.api, claimRequest("op-1"));
    await allocate(stores.console, reg);
    await bindPrepare(stores.api, "op-1");
    await refusedWith(activate(stores.api, "op-1"), "not-ready");
    expect((await readBinding(stores.api, "x1")).active).toBeNull();
  });
  it("a C3a acknowledgement with a mismatched opId, revision or T is refused", async () => {
    const stores = await setup("ack-mismatch");
    const reg = await register(stores.api, claimRequest("op-1"));
    const cop = await allocate(stores.console, reg);
    await finalize(stores.console, await bindPrepare(stores.api, "op-1"));
    const good = { opId: "op-1", revision: cop.revision, T: reg.T, X: "x1" };
    await refusedWith(ackFinalized(stores.api, { ...good, revision: 2 }), "ack-mismatch");
    await refusedWith(ackFinalized(stores.api, { ...good, T: "dest-other" }), "ack-mismatch");
    await refusedWith(ackFinalized(stores.api, { ...good, X: "x-other" }), "ack-mismatch");
    await refusedWith(ackFinalized(stores.api, { ...good, opId: "op-unknown" }), "unknown-operation");
    await ackFinalized(stores.api, good);
    await ackFinalized(stores.api, good); // identical replay is a no-op
  });
  it("finalize without the api's prepared evidence is refused", async () => {
    const stores = await setup("finalize-evidence");
    const reg = await register(stores.api, claimRequest("op-1"));
    await allocate(stores.console, reg);
    await refusedWith(finalize(stores.console, reg), "not-prepared");
  });
});

describe("§9 (c): late finalize or cleanup for an old opId never clears a newer lock", () => {
  it("leaves the newer operation's locks in place", async () => {
    const stores = await setup("late-cleanup");
    const regA = await register(stores.api, claimRequest("op-a"));
    await allocate(stores.console, regA);
    await cancelChild(stores, "op-a");
    const regB = await register(stores.api, claimRequest("op-b"));
    await allocate(stores.console, regB);
    await cancelConsole(stores.console, await readOp(stores.api, "op-a")); // late cleanup of A
    await refusedWith(finalize(stores.console, { ...(await readOp(stores.api, "op-a")), state: "prepared" }), "cancelled");
    expect(await readItem(stores.console, "x1")).toMatchObject({ state: "continuing", lockOp: "op-b" });
    expect(await readItem(stores.console, regB.T)).toMatchObject({ state: "pending", lockOp: "op-b" });
  });
});

describe("§9 (c): item locks", () => {
  it("the source is locked from allocate until finalize or cancel; T finalizing refuses answers, edits and deletion", async () => {
    const stores = await setup("locks");
    const reg = await register(stores.api, claimRequest("op-1"));
    await allocate(stores.console, reg);
    for (const kind of ["answer", "edit", "delete"]) {
      await refusedWith(consoleWrite(stores.console, "x1", kind), "item-locked");
      await refusedWith(consoleWrite(stores.console, reg.T, kind), "item-locked");
    }
    await finalize(stores.console, await bindPrepare(stores.api, "op-1"));
    for (const kind of ["answer", "edit", "delete"]) {
      await refusedWith(consoleWrite(stores.console, "x1", kind), "item-locked");
      await refusedWith(consoleWrite(stores.console, reg.T, kind), "item-locked");
    }
  });
  it("T is never answerable before activate; at ready the api accepts its principal while the console still refuses", async () => {
    const stores = await setup("ready");
    const reg = await register(stores.api, claimRequest("op-1"));
    await allocate(stores.console, reg);
    // Before C2: unbound, so authority is still the source's owner.
    const derived = { x1: await deriveAuthority(stores.console, "x1") };
    await refusedWith(submit(stores.api, { sessions: ["x1"], caller: P, submitter: "p", taskId: "t", derived }), "not-respondent");
    await finalize(stores.console, await bindPrepare(stores.api, "op-1"));
    await ackFinalized(stores.api, { opId: "op-1", revision: 1, T: reg.T, X: "x1" });
    await activate(stores.api, "op-1"); // ready: T still finalizing
    expect((await readItem(stores.console, reg.T)).state).toBe("finalizing");
    await refusedWith(consoleWrite(stores.console, reg.T, "answer"), "item-locked");
    await submit(stores.api, { sessions: ["x1"], caller: P, submitter: "p", taskId: "t" });
    expect((await readAssignment(stores.api, "x1")).frozen).toMatchObject({ principal: P, revision: 1 });
    await unlock(stores.console, await readOp(stores.api, "op-1"));
    await consoleWrite(stores.console, reg.T, "answer");
  });
});

describe("§9 (c): submissions while prepared", () => {
  it("are refused from both principals, including directly through the api", async () => {
    const stores = await setup("prepared-submit");
    const reg = await register(stores.api, claimRequest("op-1"));
    await allocate(stores.console, reg);
    await bindPrepare(stores.api, "op-1");
    const derived = { x1: { principal: WS_A } };
    for (const caller of [WS_A, P]) {
      const err = await refusedWith(submit(stores.api, { sessions: ["x1"], caller, submitter: "s", taskId: "t", derived }), "respondent-continuing");
      expect(err.temporary).toBe(true);
    }
    expect(await readAssignment(stores.api, "x1")).toBeNull();
  });
  it("one submission touching several sessions, one of them prepared, freezes nothing", async () => {
    const stores = await setup("multi-session");
    await createItem(stores.console, { id: "x2", owner: WS_A });
    await prepareThroughAck(stores, claimRequest("op-2", { session: "x2", source: "x2" }));
    await activate(stores.api, "op-2");
    // x2 is now active (P); prepare a continuation of x1 and submit over both.
    const reg = await register(stores.api, claimRequest("op-1"));
    await allocate(stores.console, reg);
    await bindPrepare(stores.api, "op-1");
    await refusedWith(
      submit(stores.api, { sessions: ["x2", "x1"], caller: P, submitter: "p", taskId: "t", derived: { x1: { principal: WS_A } } }),
      "respondent-continuing",
    );
    expect(await readAssignment(stores.api, "x2")).toBeNull();
    expect(await readAssignment(stores.api, "x1")).toBeNull();
  });
});

describe("§9: freeze and rebind attribution (I2)", () => {
  it("freeze before rebind keeps the earlier principal and revision", async () => {
    const stores = await setup("freeze-first");
    const derived = { x1: await deriveAuthority(stores.console, "x1") };
    await submit(stores.api, { sessions: ["x1"], caller: WS_A, submitter: "ws-a", taskId: "t1", derived });
    await runChild(stores, claimRequest("op-1"));
    expect((await readAssignment(stores.api, "x1")).frozen).toEqual({ principal: WS_A, revision: 0, submitter: "ws-a", taskId: "t1" });
  });
  it("rebind before freeze admits only the new principal", async () => {
    const stores = await setup("rebind-first");
    await runChild(stores, claimRequest("op-1"));
    const derived = { x1: { principal: WS_A } };
    await refusedWith(submit(stores.api, { sessions: ["x1"], caller: WS_A, submitter: "ws-a", taskId: "t", derived }), "not-respondent");
    await submit(stores.api, { sessions: ["x1"], caller: P, submitter: "p", taskId: "t" });
    expect((await readAssignment(stores.api, "x1")).frozen).toMatchObject({ principal: P, revision: 1 });
  });
  it("free-plan workspace A cannot submit for workspace B's session, though both share one uid", async () => {
    const stores = await setup("workspaces", { owner: WS_B, id: "xb" });
    const derived = { xb: await deriveAuthority(stores.console, "xb") };
    await refusedWith(submit(stores.api, { sessions: ["xb"], caller: WS_A, submitter: "a", taskId: "t", derived }), "not-respondent");
    await submit(stores.api, { sessions: ["xb"], caller: WS_B, submitter: "b", taskId: "t", derived });
  });
});

describe("§9: an unbound session racing its first binding", () => {
  // Under (c) the first binding document is created at C2 (bind-prepare), and
  // every submission reads it inside S4, so the two serialize.
  it("serializes with C2: the submission freezes at revision 0 before it, or is refused after it", async () => {
    for (let round = 0; round < 6; round++) {
      const stores = await setup(`race-${round}`);
      const reg = await register(stores.api, claimRequest("op-1"));
      await allocate(stores.console, reg);
      const derived = { x1: await deriveAuthority(stores.console, "x1") };
      const [s, b] = await Promise.allSettled([
        submit(stores.api, { sessions: ["x1"], caller: WS_A, submitter: "ws-a", taskId: "t", derived }),
        bindPrepare(stores.api, "op-1"),
      ]);
      expect(b.status).toBe("fulfilled");
      if (s.status === "fulfilled") {
        expect((await readAssignment(stores.api, "x1")).frozen).toMatchObject({ principal: WS_A, revision: 0 });
      } else {
        expect(s.reason).toBeInstanceOf(ProtocolError);
        expect(s.reason.code).toBe("respondent-continuing");
        expect(await readAssignment(stores.api, "x1")).toBeNull();
      }
      // Completing the continuation never rewrites an earlier freeze (I2).
      await runChild(stores, claimRequest("op-1"));
      if (s.status === "fulfilled") {
        expect((await readAssignment(stores.api, "x1")).frozen).toMatchObject({ principal: WS_A, revision: 0 });
      }
    }
  });
  it("after C2, a submission racing activation is refused either way, and freezes nothing for the old owner", async () => {
    const stores = await setup("race-c4");
    await prepareThroughAck(stores, claimRequest("op-1"));
    const derived = { x1: await deriveAuthority(stores.console, "x1") };
    const [s] = await Promise.allSettled([
      submit(stores.api, { sessions: ["x1"], caller: WS_A, submitter: "ws-a", taskId: "t", derived }),
      activate(stores.api, "op-1"),
    ]);
    expect(s.status).toBe("rejected");
    expect(["respondent-continuing", "not-respondent"]).toContain(s.reason.code);
    expect(await readAssignment(stores.api, "x1")).toBeNull();
  });
});

describe("§9 (c): concurrent continuations of one session", () => {
  it("exactly one allocates; the other is refused", async () => {
    const stores = await setup("concurrent");
    const regA = await register(stores.api, claimRequest("op-a"));
    const regB = await register(stores.api, claimRequest("op-b", { destPrincipal: Q }));
    const [a, b] = await Promise.allSettled([allocate(stores.console, regA), allocate(stores.console, regB)]);
    expect([a, b].filter(r => r.status === "fulfilled")).toHaveLength(1);
    const loser = [a, b].find(r => r.status === "rejected");
    expect(loser.reason.code).toBe("item-locked");
  });
});

describe("§9: multi-item claims", () => {
  it("a claim crashing after one child resumes the rest with no duplicates, from a fixed source set", async () => {
    const stores = await setup("multi");
    await createItem(stores.console, { id: "x2", owner: WS_A });
    const sources = [
      { session: "x1", source: "x1", sourceVersion: 1, expectedRevision: 0 },
      { session: "x2", source: "x2", sourceVersion: 1, expectedRevision: 0 },
    ];
    const claim = await startClaim(stores, { claimId: "c1", sources, caller: WS_A, destPrincipal: P });
    await expect(runClaim(stores, claim, { crash: { "c1:x2": "C2" } })).rejects.toBeInstanceOf(Crash);
    await createItem(stores.console, { id: "x3", owner: WS_A });
    const again = await startClaim(stores, {
      claimId: "c1",
      sources: [...sources, { session: "x3", source: "x3", sourceVersion: 1, expectedRevision: 0 }],
      caller: WS_A,
      destPrincipal: P,
    });
    expect(again.children.map(c => c.opId)).toEqual(["c1:x1", "c1:x2"]);
    const results = await runClaim(stores, again);
    expect(results.map(r => r.opId)).toEqual(["c1:x1", "c1:x2"]);
    expect(await readHistory(stores.api, "x1")).toHaveLength(1);
    expect(await readHistory(stores.api, "x2")).toHaveLength(1);
    expect((await readItem(stores.console, "x3")).state).toBe("open");
    expect(await drainCounts(stores)).toEqual(zeroCounts);
  });
});

describe("regression: claims bind their caller and destination, and record refused children", () => {
  it("a replay naming a different caller or destination is refused", async () => {
    const stores = await setup("claim-binding");
    const sources = [{ session: "x1", source: "x1", sourceVersion: 1, expectedRevision: 0 }];
    await startClaim(stores, { claimId: "c1", sources, caller: WS_A, destPrincipal: P });
    await refusedWith(startClaim(stores, { claimId: "c1", sources, caller: WS_B, destPrincipal: P }), "claim-mismatch");
    await refusedWith(startClaim(stores, { claimId: "c1", sources, caller: WS_A, destPrincipal: Q }), "claim-mismatch");
    await startClaim(stores, { claimId: "c1", sources, caller: WS_A, destPrincipal: P });
  });
  it("a child that can't prove authority is cancelled and recorded; the others proceed, and a replay doesn't retry it", async () => {
    const stores = await setup("claim-refused");
    await createItem(stores.console, { id: "x2", owner: WS_B }); // not the claimer's
    await createItem(stores.console, { id: "x3", owner: WS_A });
    const sources = ["x1", "x2", "x3"].map(x => ({ session: x, source: x, sourceVersion: 1, expectedRevision: 0 }));
    const claim = await startClaim(stores, { claimId: "c1", sources, caller: WS_A, destPrincipal: P });
    const results = await runClaim(stores, claim);
    expect(results.map(r => r.refused ?? "completed")).toEqual(["completed", "not-respondent", "completed"]);
    expect((await readBinding(stores.api, "x1")).active.principal).toEqual(P);
    expect((await readBinding(stores.api, "x3")).active.principal).toEqual(P);
    expect(await readBinding(stores.api, "x2")).toBeNull();
    expect((await readOp(stores.api, "c1:x2")).state).toBe("cancelled");
    expect((await readItem(stores.console, "x2")).state).toBe("open");
    const replay = await runClaim(stores, claim);
    expect(replay.map(r => r.refused ?? "completed")).toEqual(["completed", "not-respondent", "completed"]);
    expect(await readHistory(stores.api, "x1")).toHaveLength(1);
    expect(await drainCounts(stores)).toEqual(zeroCounts);
  });
});

describe("regression: a refused child's reason survives crashes and overlapping resumptions", () => {
  const sources = ["x1", "x2"].map(x => ({ session: x, source: x, sourceVersion: 1, expectedRevision: 0 }));
  async function claimWithForeignChild(label) {
    const stores = await setup(label);
    await createItem(stores.console, { id: "x2", owner: WS_B });
    const claim = await startClaim(stores, { claimId: "c1", sources, caller: WS_A, destPrincipal: P });
    return { stores, claim };
  }
  it("a crash after the console tombstone, before the parent records the outcome, replays as not-respondent", async () => {
    const { stores, claim } = await claimWithForeignChild("refusal-crash");
    await expect(runClaim(stores, claim, { crashAfterTombstone: { "c1:x2": true } })).rejects.toBeInstanceOf(Crash);
    expect((await readOp(stores.api, "c1:x2")).cancelReason).toBe("not-respondent");
    const replay = await runClaim(stores, claim);
    expect(replay.map(r => r.refused ?? "completed")).toEqual(["completed", "not-respondent"]);
    expect(await drainCounts(stores)).toEqual(zeroCounts);
  });
  it("an overlapping resumption reports the outcome actually recorded, not its own", async () => {
    const { stores, claim } = await claimWithForeignChild("refusal-overlap");
    const first = await runClaim(stores, claim); // records not-respondent
    expect(first[1].refused).toBe("not-respondent");
    // A second resumption that met the child only as "cancelled".
    const late = await settleRefusal(stores, claim, "c1:x2", "cancelled");
    expect(late.refused).toBe("not-respondent");
  });
  it("two concurrent resumptions return the same outcome for the child", async () => {
    const { stores, claim } = await claimWithForeignChild("refusal-concurrent");
    const [a, b] = await Promise.all([runClaim(stores, claim), runClaim(stores, claim)]);
    expect(a[1]).toEqual({ opId: "c1:x2", refused: "not-respondent" });
    expect(b[1]).toEqual(a[1]);
    expect(await readHistory(stores.api, "x1")).toHaveLength(1);
  });
});

describe("regression: the current respondent may submit an already-frozen assignment", () => {
  it("after a transfer the new respondent submits, and the original attribution is kept", async () => {
    const stores = await setup("frozen-transfer");
    const a = await runChild(stores, claimRequest("op-a"));
    await submit(stores.api, { sessions: ["x1"], caller: P, submitter: "p", taskId: "t1" });
    const frozen = (await readAssignment(stores.api, "x1")).frozen;
    expect(frozen).toEqual({ principal: P, revision: 1, submitter: "p", taskId: "t1" });
    await runChild(stores, { opId: "op-b", session: "x1", source: a.T, sourceVersion: 1, expectedRevision: 1, caller: P, destPrincipal: Q });
    await submit(stores.api, { sessions: ["x1"], caller: Q, submitter: "q", taskId: "t2" });
    expect((await readAssignment(stores.api, "x1")).frozen).toEqual(frozen);
    await refusedWith(submit(stores.api, { sessions: ["x1"], caller: P, submitter: "p", taskId: "t3" }), "not-respondent");
  });
});

describe("§9: claim A → transfer B → replay A (I6)", () => {
  it("returns A's recorded result and leaves B's authority unchanged", async () => {
    const stores = await setup("transfer");
    const a = await runChild(stores, claimRequest("op-a"));
    const b = await runChild(stores, {
      opId: "op-b",
      session: "x1",
      source: a.T,
      sourceVersion: 1,
      expectedRevision: 1,
      caller: P,
      destPrincipal: Q,
    });
    expect(b.revision).toBe(2);
    const opA = await readOp(stores.api, "op-a");
    const replay = await runChild(stores, claimRequest("op-a"));
    expect(replay).toMatchObject({ revision: 1, destination: a.T });
    expect(await readOp(stores.api, "op-a")).toEqual(opA);
    expect((await readBinding(stores.api, "x1")).active).toMatchObject({ principal: Q, revision: 2, opId: "op-b" });
    expect((await readHistory(stores.api, "x1")).map(h => h.opId)).toEqual(["op-a", "op-b"]);
  });
  it("a replay with a different request is refused as an operation mismatch", async () => {
    const stores = await setup("mismatch");
    await runChild(stores, claimRequest("op-a"));
    await refusedWith(register(stores.api, claimRequest("op-a", { destPrincipal: Q })), "operation-mismatch");
  });
});

describe("§9: authority proof at C0 and C1", () => {
  it("refuses a caller who isn't the source's owner, a changed source, and a stale expected revision", async () => {
    const stores = await setup("proof");
    await refusedWith(allocate(stores.console, await register(stores.api, claimRequest("op-1", { caller: WS_B }))), "not-respondent");
    await consoleWrite(stores.console, "x1", "edit"); // version 1 → 2
    await refusedWith(allocate(stores.console, await register(stores.api, claimRequest("op-2"))), "source-changed");
    await runChild(stores, claimRequest("op-3", { sourceVersion: 2 }));
    await refusedWith(register(stores.api, claimRequest("op-4", { sourceVersion: 2 })), "revision-changed");
  });
});

describe("§9 rollback: the barrier, drains and floors", () => {
  it("a request paused before creation is refused after the close; W floors lower only after a verified drain", async () => {
    const stores = await setup("drain");
    const reg = await register(stores.api, claimRequest("op-1")); // created before the close
    await allocate(stores.console, reg);
    await closeBarrier(stores.api);
    await refusedWith(register(stores.api, claimRequest("op-2")), "barrier-closed");
    let f = await floors(stores);
    expect(f.writersMayLower).toBe(false);
    expect(f.counts.nonTerminalOperations).toBe(1);
    expect(f.counts.lockedItems).toBe(2);
    await runChild(stores, claimRequest("op-1")); // drive the outstanding operation to terminal
    f = await floors(stores);
    expect(f.counts).toEqual(zeroCounts);
    expect(f.writersMayLower).toBe(true);
    // R-api and K-console stay: persistent authority and respondent state.
    expect(f.readerMayLower).toBe(false);
    expect(f.consoleCompatMayLower).toBe(false);
  });
  it("the drain counts a missing tombstone and an outstanding acknowledgement", async () => {
    const stores = await setup("drain-counts");
    const reg = await register(stores.api, claimRequest("op-1"));
    await allocate(stores.console, reg);
    await finalize(stores.console, await bindPrepare(stores.api, "op-1"));
    expect((await drainCounts(stores)).outstandingAcks).toBe(1);
    await cancelApi(stores.api, "op-1");
    expect((await drainCounts(stores)).missingTombstones).toBe(1);
    await cancelConsole(stores.console, await readOp(stores.api, "op-1"));
    expect(await drainCounts(stores)).toEqual(zeroCounts);
  });
  it("with the barrier open, a drained store still may not lower writer floors", async () => {
    const stores = await setup("drain-open");
    expect((await floors(stores)).writersMayLower).toBe(false);
  });
});
