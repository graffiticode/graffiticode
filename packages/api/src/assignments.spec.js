// The C4 assignment store against the Firestore emulator (assignments.js). Every test writes
// under its own random collection prefix and nothing is ever cleared or deleted, so the store's
// own no-delete retention holds in the tests too.

import { createHash, randomUUID } from "node:crypto";
import { admin } from "./storage/firebase.js";
import { AssignmentError, buildAssignmentStore, identityKey } from "./assignments.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  // Fail, never skip: this suite writes, and must only ever write to the emulator.
  throw new Error("assignments.spec.js: FIRESTORE_EMULATOR_HOST is not set; run it under the Firestore emulator");
}

const db = admin.firestore();
const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

/** @type {(uid: string) => any} */
const user = uid => ({ kind: "user", uid, installation: "graffiticode" });
/** @type {(workspace: string) => any} */
const freePlan = workspace => ({ kind: "freePlan", uid: "trial", workspace, installation: "graffiticode" });
const P = user("p");
const Q = user("q");
const WS_A = freePlan("ws-a");
const WS_B = freePlan("ws-b");
const CANARY = user("canary");
const VERIFY = user("verify");

// Survey versions as L0182 sends them: exact bytes and their digest.
const version = (instance, body = instance) => {
  const content = JSON.stringify({ style: "ranked-choice", options: [body] });
  return { instance, digest: sha256(content), content };
};
const CIVIC = [1, 2, 3].map(n => version(`civic-priorities-${n}`));
const request = (survey, session, candidates, ordinal = 0) =>
  ({ identity: { survey, session }, key: identityKey(survey, session), ordinal, candidates });
const used = (survey, session, entry) => ({
  key: identityKey(survey, session),
  survey,
  session,
  instance: entry.instance,
  digest: entry.digest,
  content: entry.content,
});

let clock = 1_800_000_000_000;
/** @param {any} [options] */
const setup = async ({ cutover = "done", ...options } = {}) => {
  const prefix = `t-${randomUUID().slice(0, 8)}-`;
  const store = buildAssignmentStore({
    db,
    prefix,
    canarySessions: ["c1"],
    canaryPrincipals: [CANARY, VERIFY],
    now: () => ++clock,
    pick: () => 0,
    ...options,
  });
  if (cutover !== "backfill") await store.setCutover({ from: "backfill", to: "reconciling" });
  if (cutover === "done") await store.setCutover({ from: "reconciling", to: "done" });
  return { store, prefix };
};
const recordOf = async (store, survey, session, namespace = "production") =>
  (await store.refs(namespace).record(identityKey(survey, session)).get()).data();
const countDocs = async (prefix, name) => (await db.collection(`${prefix}${name}`).get()).size;
const readOf = (session, reason, survey = "civic-priorities") =>
  ({ status: "read", namespace: "production", frozen: [], already: [], read: [{ key: identityKey(survey, session), reason }] });
const refused = async (promise, code) => {
  const err = await promise.then(() => null, e => e);
  expect(err).toBeInstanceOf(AssignmentError);
  expect(err.code).toBe(code);
  return err;
};
// Freezes WS_A's response for (civic-priorities, session) after resolving it.
/** @param {any} store @param {string} session @param {{ caller?: any, derived?: any }} [options] */
const resolveAndFreeze = async (store, session, { caller = WS_A, derived = undefined } = {}) => {
  const { table } = await store.resolve({ requests: [request("civic-priorities", session, CIVIC)], taskId: "t1" });
  const entry = { ...table[identityKey("civic-priorities", session)] };
  entry.content = CIVIC.find(c => c.instance === entry.instance).content;
  const out = await store.submit({
    taskId: "t1",
    caller,
    used: [used("civic-priorities", session, entry)],
    derived: derived ?? { [session]: { principal: WS_A } },
  });
  return { entry, out };
};

describe("C4 assignments: get-or-create and the durable draw", () => {
  it("creates one record per identity, draws without replacement, and pins the session", async () => {
    const { store, prefix } = await setup();
    const instances = [];
    for (const session of ["a", "b", "c", "d"]) {
      const { table, created, namespace } =
        await store.resolve({ requests: [request("civic-priorities", session, CIVIC)], taskId: "t1" });
      expect(namespace).toBe("production");
      expect(created).toEqual([identityKey("civic-priorities", session)]);
      instances.push(table[identityKey("civic-priorities", session)].instance);
    }
    // Every version once before any twice, then the next cycle.
    expect(instances).toEqual(["civic-priorities-1", "civic-priorities-2", "civic-priorities-3", "civic-priorities-1"]);
    expect((await store.refs("production").cycle("civic-priorities").get()).data())
      .toMatchObject({ cycle: 1, taken: ["civic-priorities-1"] });
    expect(await recordOf(store, "civic-priorities", "d")).toMatchObject({ state: "assigned", cycle: 1, taskId: "t1" });
    expect((await store.pinRef("a").get()).data()).toMatchObject({ namespace: "production" });
    expect(await countDocs(prefix, "l0182-assignments")).toBe(4);
  });

  it("concurrent first reads of one identity create one record and agree on its version", async () => {
    const { store, prefix } = await setup({ pick: n => n - 1 });
    const results = await Promise.all([1, 2, 3, 4].map(() =>
      store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t1" })));
    const instances = new Set(results.map(r => r.table[identityKey("civic-priorities", "s")].instance));
    expect(instances.size).toBe(1);
    expect(results.filter(r => r.created.length === 1)).toHaveLength(1);
    expect(await countDocs(prefix, "l0182-assignments")).toBe(1);
    expect((await store.refs("production").cycle("civic-priorities").get()).data().taken).toHaveLength(1);
  }, 30000);

  it("is durable across a restart: a fresh store returns the same record and draws nothing", async () => {
    const { store, prefix } = await setup();
    const first = await store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t1" });
    const restarted = buildAssignmentStore({ db, prefix, pick: n => n - 1 });
    const again = await restarted.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t2" });
    expect(again.table).toEqual(first.table);
    expect(again.created).toEqual([]);
    expect((await store.refs("production").cycle("civic-priorities").get()).data().taken).toHaveLength(1);
  });

  it("a named version is its own assignment and touches no draw cycle", async () => {
    const { store } = await setup();
    const named = [version("civic-priorities-3")];
    const { table } = await store.resolve({ requests: [request("civic-priorities-3", "s", named)], taskId: "t1" });
    expect(table[identityKey("civic-priorities-3", "s")]).toEqual({ instance: "civic-priorities-3", digest: named[0].digest });
    expect((await store.refs("production").cycle("civic-priorities-3").get()).exists).toBe(false);
  });

  it("several identities in one call share records where they match", async () => {
    const { store } = await setup();
    const workplace = [version("workplace-pulse-1"), version("workplace-pulse-2")];
    const requests = [
      request("civic-priorities", "a", CIVIC, 0),
      request("workplace-pulse", "a", workplace, 1),
      request("civic-priorities", "a", CIVIC, 2),
    ];
    const { table, created } = await store.resolve({ requests, taskId: "t1" });
    expect(created).toHaveLength(2);
    expect(Object.keys(table)).toHaveLength(2);
  });

  it("refuses a request whose candidates aren't what they claim", async () => {
    const { store } = await setup();
    const forged = [{ ...CIVIC[0], digest: "00" }];
    await refused(store.resolve({ requests: [request("civic-priorities", "s", forged)], taskId: "t1" }), "assignment-request-invalid");
    const bare = [version("civic-priorities")];
    await refused(store.resolve({ requests: [request("civic-priorities", "s", [...CIVIC, ...bare])], taskId: "t1" }), "assignment-request-invalid");
    await refused(store.resolve({ requests: [request("civic-priorities", "", CIVIC)], taskId: "t1" }), "assignment-request-invalid");
  });
});

describe("C4 assignments: content changes, removals and retained models", () => {
  it("an unfrozen record keeps its instance and moves to new content, recording the change", async () => {
    const { store } = await setup();
    await store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t1" });
    const changed = [version("civic-priorities-1", "new wording"), ...CIVIC.slice(1)];
    const { table } = await store.resolve({ requests: [request("civic-priorities", "s", changed)], taskId: "t2" });
    expect(table[identityKey("civic-priorities", "s")]).toEqual({ instance: "civic-priorities-1", digest: changed[0].digest });
    const record = await recordOf(store, "civic-priorities", "s");
    expect(record.digestHistory).toEqual([{ from: CIVIC[0].digest, to: changed[0].digest, at: expect.any(Number) }]);
  });

  it("an unfrozen record whose version is removed is reassigned; with nothing left it is absent", async () => {
    const { store } = await setup();
    await store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t1" });
    const { table } = await store.resolve({ requests: [request("civic-priorities", "s", CIVIC.slice(1))], taskId: "t2" });
    expect(table[identityKey("civic-priorities", "s")].instance).toBe("civic-priorities-2");
    expect((await recordOf(store, "civic-priorities", "s")).reassigned).toEqual([
      { from: "civic-priorities-1", digest: CIVIC[0].digest, at: expect.any(Number) },
    ]);
    const none = await store.resolve({ requests: [request("civic-priorities", "s", [])], taskId: "t3" });
    expect(none.table[identityKey("civic-priorities", "s")]).toEqual({ absent: true });
    // An identity never assigned, with nothing to draw from, is absent and creates nothing.
    const fresh = await store.resolve({ requests: [request("no-such-survey", "s", [])], taskId: "t4" });
    expect(fresh).toMatchObject({ table: { [identityKey("no-such-survey", "s")]: { absent: true } }, created: [] });
  });

  it("a frozen record never changes: changed or removed content is served from the retained model", async () => {
    const { store } = await setup();
    const { entry } = await resolveAndFreeze(store, "s");
    const frozen = await recordOf(store, "civic-priorities", "s");
    expect(await store.retained(entry.digest)).toBe(entry.content);
    const changed = [version("civic-priorities-1", "new wording"), ...CIVIC.slice(1)];
    for (const candidates of [changed, CIVIC.slice(1), []]) {
      const { table } = await store.resolve({ requests: [request("civic-priorities", "s", candidates)], taskId: "t2" });
      expect(table[identityKey("civic-priorities", "s")]).toEqual({ instance: entry.instance, digest: entry.digest, content: entry.content });
    }
    // While the candidates still carry its digest, no content travels.
    const { table } = await store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t3" });
    expect(table[identityKey("civic-priorities", "s")]).toEqual({ instance: entry.instance, digest: entry.digest });
    expect(await recordOf(store, "civic-priorities", "s")).toEqual(frozen);
  });

  it("a retained model that exists with different bytes fails the freeze, and nothing is frozen", async () => {
    const { store } = await setup();
    const { table } = await store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t1" });
    const entry = { ...table[identityKey("civic-priorities", "s")], content: CIVIC[0].content };
    await store.refs("production").model(entry.digest).set({ digest: entry.digest, content: "corrupt" });
    await refused(store.submit({ taskId: "t1", caller: WS_A, used: [used("civic-priorities", "s", entry)], derived: { s: { principal: WS_A } } }), "survey-model-conflict");
    expect((await recordOf(store, "civic-priorities", "s")).frozen).toBeUndefined();
  });
});

describe("C4 assignments: the cutover barrier, unresolved records and task quarantine", () => {
  it("before `done`, creation and submission are refused temporarily and existing records are read", async () => {
    const { store } = await setup();
    await store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t1" });
    await store.setCutover({ from: "done", to: "reconciling" });
    const read = await store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t2" });
    expect(read.table[identityKey("civic-priorities", "s")].instance).toBe("civic-priorities-1");
    const err = await refused(store.resolve({ requests: [request("civic-priorities", "new", CIVIC)], taskId: "t2" }), "assignment-reconciling");
    expect(err.temporary).toBe(true);
    const entry = { ...read.table[identityKey("civic-priorities", "s")], content: CIVIC[0].content };
    await refused(store.submit({ taskId: "t2", caller: WS_A, used: [used("civic-priorities", "s", entry)], derived: { s: { principal: WS_A } } }), "assignment-reconciling");
    // A reassignment is a write too.
    await refused(store.resolve({ requests: [request("civic-priorities", "s", CIVIC.slice(1))], taskId: "t3" }), "assignment-reconciling");
  });

  it("a missing production state is `backfill`, and every write is refused; the canary's starts `done`", async () => {
    const { store } = await setup({ cutover: "backfill" });
    await refused(store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t1" }), "assignment-reconciling");
    const canary = await store.resolve({ requests: [request("civic-priorities", "c1", CIVIC)], taskId: "t1" });
    expect(canary.namespace).toBe("canary");
    await refused(store.setCutover({ from: "reconciling", to: "done" }), "cutover-changed");
  });

  it("an unresolved record never falls through to a draw", async () => {
    const { store } = await setup();
    const key = identityKey("civic-priorities", "s");
    await store.refs("production").record(key).set({ key, state: "unresolved", reason: "conflicting-instances" });
    await refused(store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t1" }), "assignment-under-review");
    expect((await store.refs("production").cycle("civic-priorities").get()).exists).toBe(false);
  });

  it("a quarantined task creates nothing, though the key it computes has no record", async () => {
    const { store, prefix } = await setup();
    await store.refs("production").quarantine("t-q").set({ taskId: "t-q", reasons: ["computed-session"] });
    await refused(store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t-q" }), "assignment-under-review");
    expect(await countDocs(prefix, "l0182-assignments")).toBe(0);
    expect((await store.pinRef("s").get()).exists).toBe(false);
    // Another task for the same identity isn't affected.
    const other = await store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t-other" });
    expect(other.created).toHaveLength(1);
  });
});

describe("C4 assignments: namespace pins and canary isolation", () => {
  it("a listed session reads and writes only canary collections, and is pinned there", async () => {
    const { store, prefix } = await setup();
    const out = await store.resolve({ requests: [request("civic-priorities", "c1", CIVIC)], taskId: "t1" });
    expect(out.namespace).toBe("canary");
    expect(await countDocs(prefix, "canary-l0182-assignments")).toBe(1);
    expect(await countDocs(prefix, "l0182-assignments")).toBe(0);
    expect((await store.pinRef("c1").get()).data()).toMatchObject({ namespace: "canary" });
  });

  it("a pin outlives a configuration change; a never-seen session follows the new list", async () => {
    const { store, prefix } = await setup();
    await store.resolve({ requests: [request("civic-priorities", "x", CIVIC)], taskId: "t1" });
    const moved = buildAssignmentStore({ db, prefix, canarySessions: ["x", "y"], canaryPrincipals: [CANARY], pick: () => 0 });
    expect((await moved.resolve({ requests: [request("civic-priorities", "x", CIVIC)], taskId: "t2" })).namespace).toBe("production");
    expect((await moved.resolve({ requests: [request("civic-priorities", "y", CIVIC)], taskId: "t2" })).namespace).toBe("canary");
  });

  it("a program reaching both namespaces is refused", async () => {
    const { store } = await setup();
    const requests = [request("civic-priorities", "x", CIVIC), request("civic-priorities", "c1", CIVIC)];
    await refused(store.resolve({ requests, taskId: "t1" }), "namespace-mixed");
  });

  it("a canary freeze needs canary-owned principals, and a refusal leaves no pin and no freeze", async () => {
    const { store } = await setup();
    const entry = { ...CIVIC[0] };
    await refused(store.submit({ taskId: "t1", caller: P, used: [used("civic-priorities", "c1", entry)], derived: { c1: { principal: P } } }),
      "canary-fixture-only");
    expect((await store.pinRef("c1").get()).exists).toBe(false);
    const { table } = await store.resolve({ requests: [request("civic-priorities", "c1", CIVIC)], taskId: "t1" });
    const canaryEntry = { ...table[identityKey("civic-priorities", "c1")], content: CIVIC[0].content };
    const out = await store.submit({ taskId: "t1", caller: VERIFY, used: [used("civic-priorities", "c1", canaryEntry)], derived: { c1: { principal: VERIFY } } });
    expect(out).toMatchObject({ status: "frozen", namespace: "canary" });
    expect((await recordOf(store, "civic-priorities", "c1", "canary")).frozen.principal).toEqual(VERIFY);
  });
});

describe("C4 assignments: atomic submission freezes", () => {
  it("the respondent's response freezes with its authority evidence and retained model; a retry rewrites nothing", async () => {
    const { store } = await setup();
    const { entry, out } = await resolveAndFreeze(store, "s");
    expect(out).toEqual({ status: "frozen", namespace: "production", frozen: [identityKey("civic-priorities", "s")], already: [], read: [] });
    const record = await recordOf(store, "civic-priorities", "s");
    expect(record).toMatchObject({ state: "frozen", frozen: { principal: WS_A, revision: 0, basis: "derived", submitter: WS_A, taskId: "t1" } });
    const retry = await store.submit({ taskId: "t2", caller: WS_A, used: [used("civic-priorities", "s", entry)], derived: { s: { principal: WS_A } } });
    expect(retry.already).toEqual([identityKey("civic-priorities", "s")]);
    expect(await recordOf(store, "civic-priorities", "s")).toEqual(record);
  });

  it("anyone else's response is a read, and so are unknown and ambiguous authority", async () => {
    const { store } = await setup();
    /** @type {any[][]} */
    const cases = [
      [WS_B, { s: { principal: WS_A } }, "not-respondent"], // one shared trial uid, another workspace
      [P, { s: { principal: WS_A } }, "not-respondent"],
      [WS_A, { s: { unknown: true } }, "respondent-unknown"],
      [WS_A, { s: { ambiguous: true } }, "respondent-ambiguous"],
    ];
    for (const [caller, derived, reason] of cases) {
      const { out } = await resolveAndFreeze(store, "s", { caller, derived });
      expect(out).toEqual(readOf("s", reason));
    }
    expect((await recordOf(store, "civic-priorities", "s")).frozen).toBeUndefined();
  });

  it("an unattested free-plan caller or an unavailable authority answer is a temporary refusal", async () => {
    const { store } = await setup();
    const unattested = { kind: "freePlan", uid: "trial", installation: "graffiticode" };
    const err = await refused(resolveAndFreeze(store, "s", { caller: unattested }), "respondent-unattested");
    expect(err.temporary).toBe(true);
    const missing = await refused(resolveAndFreeze(store, "s2", { derived: {} }), "respondent-authority-unavailable");
    expect(missing.temporary).toBe(true);
  });

  it("several identities freeze in one transaction, or none does", async () => {
    const { store, prefix } = await setup();
    const requests = [request("civic-priorities", "a", CIVIC), request("civic-priorities", "b", CIVIC)];
    const { table } = await store.resolve({ requests, taskId: "t1" });
    const entries = ["a", "b"].map(s => {
      const e = table[identityKey("civic-priorities", s)];
      return used("civic-priorities", s, { ...e, content: CIVIC.find(c => c.instance === e.instance).content });
    });
    const derived = { a: { principal: WS_A }, b: { principal: WS_A } };
    // b's record moves under the interpret's feet: nothing is frozen.
    await store.resolve({ requests: [request("civic-priorities", "b", CIVIC.filter(c => c.instance !== entries[1].instance))], taskId: "t2" });
    const err = await refused(store.submit({ taskId: "t1", caller: WS_A, used: entries, derived }), "assignment-changed");
    expect(err.temporary).toBe(true);
    expect((await recordOf(store, "civic-priorities", "a")).frozen).toBeUndefined();
    expect(await countDocs(prefix, "l0182-survey-models")).toBe(0);
    // With what the records now hold, both freeze together.
    const fresh = await store.resolve({ requests, taskId: "t3" });
    const now = ["a", "b"].map(s => {
      const e = fresh.table[identityKey("civic-priorities", s)];
      return used("civic-priorities", s, { ...e, content: CIVIC.find(c => c.instance === e.instance).content });
    });
    expect((await store.submit({ taskId: "t3", caller: WS_A, used: now, derived })).frozen).toHaveLength(2);
  });

  it("a bound session is answered by its binding: the new principal freezes, the old one reads, a prepared one waits", async () => {
    const { store } = await setup();
    const binding = store.refs("production").binding("s");
    await binding.set({ active: { principal: P, revision: 1, opId: "op-1", destination: "dest-1" }, prepared: null });
    const old = await resolveAndFreeze(store, "s", { caller: WS_A, derived: { s: { principal: WS_A } } });
    expect(old.out).toEqual(readOf("s", "not-respondent"));
    await binding.set({ active: { principal: P, revision: 1, opId: "op-1", destination: "dest-1" }, prepared: { opId: "op-2", revision: 2 } });
    const waiting = await refused(resolveAndFreeze(store, "s", { caller: P }), "respondent-continuing");
    expect(waiting.temporary).toBe(true);
    await binding.set({ active: { principal: P, revision: 1, opId: "op-1", destination: "dest-1" }, prepared: null });
    const fresh = await resolveAndFreeze(store, "s", { caller: P });
    expect(fresh.out.status).toBe("frozen");
    expect((await recordOf(store, "civic-priorities", "s")).frozen).toMatchObject({ principal: P, revision: 1, basis: "binding" });
  });

  it("a transfer moves authority forward and never rewrites an earlier freeze (retention)", async () => {
    const { store, prefix } = await setup();
    const binding = store.refs("production").binding("s");
    await binding.set({ active: { principal: P, revision: 1, opId: "op-1", destination: "dest-1" }, prepared: null });
    const { entry } = await resolveAndFreeze(store, "s", { caller: P });
    const frozen = await recordOf(store, "civic-priorities", "s");
    await binding.set({ active: { principal: Q, revision: 2, opId: "op-2", destination: "dest-2" }, prepared: null });
    // P may no longer submit; Q may, against the record P froze, which stays P's.
    const before = await store.submit({ taskId: "t2", caller: P, used: [used("civic-priorities", "s", entry)] });
    expect(before).toEqual(readOf("s", "not-respondent"));
    const after = await store.submit({ taskId: "t3", caller: Q, used: [used("civic-priorities", "s", entry)] });
    expect(after).toMatchObject({ status: "frozen", frozen: [], already: [identityKey("civic-priorities", "s")] });
    expect(await recordOf(store, "civic-priorities", "s")).toEqual(frozen);
    expect(frozen.frozen).toMatchObject({ principal: P, revision: 1 });
    expect(await countDocs(prefix, "l0182-assignments")).toBe(1);
    expect(await countDocs(prefix, "l0182-survey-models")).toBe(1);
  });

  it("a freeze racing a binding's activation is ordered by the binding: never frozen under a superseded authority", async () => {
    for (let round = 0; round < 6; round++) {
      const { store } = await setup();
      const { table } = await store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t1" });
      const entry = { ...table[identityKey("civic-priorities", "s")], content: CIVIC[0].content };
      const binding = store.refs("production").binding("s");
      // C4 activate, as the harness writes it: the binding pointer in one api transaction.
      const activate = db.runTransaction(async tx => {
        await tx.get(binding);
        tx.set(binding, { active: { principal: P, revision: 1, opId: "op-1", destination: "dest-1" }, prepared: null });
      });
      const freeze = store.submit({ taskId: "t1", caller: WS_A, used: [used("civic-priorities", "s", entry)], derived: { s: { principal: WS_A } } });
      const [, out] = await Promise.all([activate, freeze]);
      const record = await recordOf(store, "civic-priorities", "s");
      if (out.status === "frozen") {
        // The freeze committed first: it records the unbound authority that admitted it.
        expect(record.frozen).toMatchObject({ principal: WS_A, revision: 0, basis: "derived" });
      } else {
        expect(out).toEqual(readOf("s", "not-respondent"));
        expect(record.frozen).toBeUndefined();
      }
    }
  });
});

describe("C4 assignments: review regressions", () => {
  it("a mixed-ownership submission freezes the caller's authorized identities and reads the rest", async () => {
    const { store } = await setup();
    const requests = [request("civic-priorities", "mine", CIVIC), request("civic-priorities", "theirs", CIVIC)];
    const { table } = await store.resolve({ requests, taskId: "t1" });
    const entries = ["mine", "theirs"].map(s => {
      const e = table[identityKey("civic-priorities", s)];
      return used("civic-priorities", s, { ...e, content: CIVIC.find(c => c.instance === e.instance).content });
    });
    const out = await store.submit({
      taskId: "t1",
      caller: WS_A,
      used: entries,
      derived: { mine: { principal: WS_A }, theirs: { principal: WS_B } },
    });
    expect(out).toEqual({
      status: "frozen",
      namespace: "production",
      frozen: [identityKey("civic-priorities", "mine")],
      already: [],
      read: [{ key: identityKey("civic-priorities", "theirs"), reason: "not-respondent" }],
    });
    expect((await recordOf(store, "civic-priorities", "mine")).frozen.principal).toEqual(WS_A);
    expect((await recordOf(store, "civic-priorities", "theirs")).frozen).toBeUndefined();
  });

  it("a non-owner's read is answered while reconciling: it writes nothing, so nothing fences it", async () => {
    const { store } = await setup();
    const { table } = await store.resolve({ requests: [request("civic-priorities", "s", CIVIC)], taskId: "t1" });
    await store.setCutover({ from: "done", to: "reconciling" });
    const entry = { ...table[identityKey("civic-priorities", "s")], content: CIVIC[0].content };
    const out = await store.submit({ taskId: "t1", caller: WS_B, used: [used("civic-priorities", "s", entry)], derived: { s: { principal: WS_A } } });
    expect(out).toEqual(readOf("s", "not-respondent"));
    // The owner's freeze is still fenced.
    await refused(store.submit({ taskId: "t1", caller: WS_A, used: [used("civic-priorities", "s", entry)], derived: { s: { principal: WS_A } } }),
      "assignment-reconciling");
  });

  it("a session with a slash works end to end; its pin and binding are keyed by digest and keep the session", async () => {
    const { store } = await setup();
    const session = "items/abc/def";
    const binding = store.refs("production").binding(session);
    const { out } = await resolveAndFreeze(store, session, { derived: { [session]: { principal: WS_A } } });
    expect(out.status).toBe("frozen");
    expect((await store.pinRef(session).get()).data()).toMatchObject({ session, namespace: "production" });
    await binding.set({ session, active: { principal: P, revision: 1, opId: "op-1", destination: "d" }, prepared: null });
    expect(binding.id).toBe(createHash("sha256").update(session).digest("hex"));
    const entry = { ...CIVIC[0] };
    const again = await store.submit({ taskId: "t2", caller: P, used: [used("civic-priorities", session, entry)] });
    expect(again.already).toEqual([identityKey("civic-priorities", session)]);
  });

  it("an invalid namespace never falls back to production: a corrupt pin, and setCutover", async () => {
    const { store, prefix } = await setup();
    await store.pinRef("bad").set({ session: "bad", namespace: "canry", at: 1 });
    await refused(store.resolve({ requests: [request("civic-priorities", "bad", CIVIC)], taskId: "t1" }), "namespace-invalid");
    await refused(store.submit({ taskId: "t1", caller: WS_A, used: [used("civic-priorities", "bad", CIVIC[0])], derived: { bad: { principal: WS_A } } }),
      "namespace-invalid");
    expect(await countDocs(prefix, "l0182-assignments")).toBe(0);
    const before = (await store.refs("production").cutover().get()).data();
    await refused(store.setCutover({ namespace: "canry", from: "done", to: "reconciling" }), "namespace-invalid");
    expect((await store.refs("production").cutover().get()).data()).toEqual(before);
    expect(() => store.refs("canry")).not.toThrow(); // building the map is harmless; every reference refuses
    expect(() => store.refs("canry").record("k")).toThrow(AssignmentError);
  });

  it("an already-frozen record without its retained model is restored from verified bytes before success", async () => {
    const { store, prefix } = await setup();
    // A frozen record whose model was never written (as a partial import might leave one).
    const key = identityKey("civic-priorities", "s");
    await store.refs("production").record(key).set({
      key,
      survey: "civic-priorities",
      session: "s",
      state: "frozen",
      instance: CIVIC[1].instance,
      digest: CIVIC[1].digest,
      frozen: { principal: WS_A, revision: 0, basis: "derived", submitter: WS_A, taskId: "t0", submittedAt: 1 },
    });
    // Resolving it, once its version is gone, refuses rather than serving nothing.
    await refused(store.resolve({ requests: [request("civic-priorities", "s", [CIVIC[0]])], taskId: "t1" }), "assignment-model-missing");
    const out = await store.submit({ taskId: "t1", caller: WS_A, used: [used("civic-priorities", "s", CIVIC[1])], derived: { s: { principal: WS_A } } });
    expect(out).toMatchObject({ status: "frozen", frozen: [], already: [key] });
    expect(await store.retained(CIVIC[1].digest)).toBe(CIVIC[1].content);
    expect(await countDocs(prefix, "l0182-survey-models")).toBe(1);
    const { table } = await store.resolve({ requests: [request("civic-priorities", "s", [CIVIC[0]])], taskId: "t2" });
    expect(table[key]).toEqual({ instance: CIVIC[1].instance, digest: CIVIC[1].digest, content: CIVIC[1].content });
  });
});

describe("C4 assignments: sessions named like Object.prototype properties", () => {
  const SESSIONS = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];
  // An own property for any session, "__proto__" included (a computed key, never the setter).
  const answers = (session, answer) => Object.defineProperty({}, session, { value: answer, enumerable: true });

  it.each(SESSIONS)("%s: resolving creates its record and table entry", async session => {
    const { store } = await setup();
    const { table, created } = await store.resolve({ requests: [request("civic-priorities", session, CIVIC)], taskId: "t1" });
    expect(created).toEqual([identityKey("civic-priorities", session)]);
    expect(Object.keys(table)).toEqual([identityKey("civic-priorities", session)]);
    expect((await store.pinRef(session).get()).data()).toMatchObject({ session });
  });

  it.each(SESSIONS)("%s: a non-respondent's response is a read, and an earlier freeze stays the owner's", async session => {
    const { store } = await setup();
    const { entry } = await resolveAndFreeze(store, session, { derived: answers(session, { principal: WS_A }) });
    const frozen = await recordOf(store, "civic-priorities", session);
    expect(frozen.frozen.principal).toEqual(WS_A);
    const out = await store.submit({
      taskId: "t2",
      caller: WS_B,
      used: [used("civic-priorities", session, entry)],
      derived: answers(session, { principal: WS_A }),
    });
    expect(out).toEqual(readOf(session, "not-respondent"));
    expect(await recordOf(store, "civic-priorities", session)).toEqual(frozen);
  });

  it.each(SESSIONS)("%s: the respondent's freeze reports no read reasons", async session => {
    const { store } = await setup();
    const { out } = await resolveAndFreeze(store, session, { derived: answers(session, { principal: WS_A }) });
    expect(out).toEqual({ status: "frozen", namespace: "production", frozen: [identityKey("civic-priorities", session)], already: [], read: [] });
  });

  it.each(SESSIONS)("%s: no own answer is unavailable authority, never an inherited one", async session => {
    const { store } = await setup();
    const err = await refused(resolveAndFreeze(store, session, { derived: {} }), "respondent-authority-unavailable");
    expect(err.temporary).toBe(true);
    const { out } = await resolveAndFreeze(store, session, { derived: answers(session, { unknown: true }) });
    expect(out).toEqual(readOf(session, "respondent-unknown"));
  });

  it("a mixed submission across such sessions freezes only the caller's", async () => {
    const { store } = await setup();
    const requests = [request("civic-priorities", "constructor", CIVIC), request("civic-priorities", "__proto__", CIVIC)];
    const { table } = await store.resolve({ requests, taskId: "t1" });
    const entries = ["constructor", "__proto__"].map(s => {
      const e = table[identityKey("civic-priorities", s)];
      return used("civic-priorities", s, { ...e, content: CIVIC.find(c => c.instance === e.instance).content });
    });
    // A computed key: a literal `__proto__:` would set the prototype instead.
    const derived = { ...answers("constructor", { principal: WS_A }), ...answers("__proto__", { principal: WS_B }) };
    expect(Object.hasOwn(derived, "__proto__")).toBe(true);
    const out = await store.submit({ taskId: "t1", caller: WS_A, used: entries, derived });
    expect(out).toMatchObject({
      status: "frozen",
      frozen: [identityKey("civic-priorities", "constructor")],
      read: [{ key: identityKey("civic-priorities", "__proto__"), reason: "not-respondent" }],
    });
  });
});
