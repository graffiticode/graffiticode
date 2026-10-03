import test from "node:test";
import assert from "node:assert/strict";
import { createProtectedSwitch, admission } from "../../packages/policy/src/maintenance.js";
import { ACTIVE, DOC, drain, parse, setCanary, setEnabled, SETTLE_MS } from "../lib/protected-execution.js";

// Just enough Firestore: documents with merging set(), and a count of
// unexpired activity entries.
const fakeDb = () => {
  const docs = new Map();
  const active = [];
  return {
    docs,
    active,
    doc: path => ({
      get: async () => ({ exists: docs.has(path), data: () => structuredClone(docs.get(path)) }),
      set: async (data, { merge = false } = {}) => { docs.set(path, merge ? { ...(docs.get(path) ?? {}), ...structuredClone(data) } : structuredClone(data)); },
    }),
    collection: name => ({
      where: (field, op, value) => ({
        count: () => ({
          get: async () => {
            assert.equal(name, ACTIVE);
            assert.deepEqual([field, op], ["expiresAt", ">"]);
            return { data: () => ({ count: active.filter(e => e.expiresAt > value).length }) };
          }
        })
      })
    })
  };
};
const dbsOf = () => [{ name: "policy", db: fakeDb() }, { name: "broker", db: fakeDb() }];
const flagOf = db => db.docs.get(DOC);
const switchOn = db => createProtectedSwitch({ cacheMs: 0, readFlag: async () => flagOf(db) ?? null });
const CANARY = { uid: "0xcanary", connectionId: "conn-canary" };
const meta = { reason: "test", by: "op@example.com" };

test("the operator sequence keeps the canary through every switch flip, as the services read it", async () => {
  const dbs = dbsOf();
  await setEnabled(dbs, true, meta);
  await setCanary(dbs, CANARY, meta);
  await setEnabled(dbs, false, meta);
  for (const { db } of dbs) {
    assert.deepEqual(flagOf(db).canary, CANARY);
    const state = await switchOn(db).state();
    assert.equal(admission(state, CANARY), "canary");
    assert.equal(admission(state, { uid: "0xother", connectionId: "conn-canary" }), null);
  }
  await setEnabled(dbs, true, meta);
  await setEnabled(dbs, false, meta);
  assert.deepEqual(flagOf(dbs[1].db).canary, CANARY);
  assert.equal(flagOf(dbs[1].db).enabled, false);
  await setCanary(dbs, null, meta);
  assert.equal(flagOf(dbs[0].db).enabled, false);
  assert.equal(admission(await switchOn(dbs[0].db).state(), CANARY), null);
});

test("setting the canary never moves the switch, and a canary alone leaves execution off", async () => {
  const dbs = dbsOf();
  await setCanary(dbs, CANARY, meta);
  const state = await switchOn(dbs[0].db).state();
  assert.equal(state.enabled, false);
  await setEnabled(dbs, true, meta);
  await setCanary(dbs, { uid: "0xnew", connectionId: "conn-new" }, meta);
  assert.equal(flagOf(dbs[1].db).enabled, true);
});

test("disable writes Policy before Broker; enable writes Broker before Policy", async () => {
  const order = [];
  const tracked = name => ({ name, db: { doc: () => ({ set: async () => { order.push(name); } }) } });
  const dbs = [tracked("policy"), tracked("broker")];
  await setEnabled(dbs, false, meta);
  await setEnabled(dbs, true, meta);
  assert.deepEqual(order, ["policy", "broker", "broker", "policy"]);
});

// A clock the test drives; sleep advances it.
const clock = start => {
  let t = start;
  return { now: () => t, sleep: async ms => { t += ms; }, advance: ms => { t += ms; } };
};

test("drain does not trust an empty count until the switch has settled", async () => {
  const broker = fakeDb();
  const c = clock(Date.parse("2026-10-03T00:00:00Z"));
  await broker.doc(DOC).set({ enabled: false, updatedAt: new Date(c.now()).toISOString() });
  const result = await drain(broker, { now: c.now, sleep: c.sleep, log: () => {} });
  assert.equal(result.by, "count");
  assert.ok(result.waited >= SETTLE_MS);
});

test("drain waits for active writes to finish, and stops at the bound plus the cache window", async () => {
  const broker = fakeDb();
  const c = clock(Date.parse("2026-10-03T00:00:00Z"));
  await broker.doc(DOC).set({ enabled: false, updatedAt: new Date(c.now()).toISOString() });
  broker.active.push({ expiresAt: new Date(c.now() + 12_000) });
  const finished = await drain(broker, { now: c.now, sleep: c.sleep, log: () => {} });
  assert.equal(finished.by, "count");
  assert.ok(finished.waited >= 12_000);

  const stuck = fakeDb();
  const c2 = clock(Date.parse("2026-10-03T00:00:00Z"));
  await stuck.doc(DOC).set({ enabled: false, updatedAt: new Date(c2.now()).toISOString() });
  stuck.active.push({ expiresAt: new Date(c2.now() + 10 * 60_000) });
  const timedOut = await drain(stuck, { maxMs: 50_000, now: c2.now, sleep: c2.sleep, log: () => {} });
  assert.equal(timedOut.by, "time");
  assert.ok(timedOut.waited >= 52_000);
});

test("drain refuses while Broker is on", async () => {
  const broker = fakeDb();
  await broker.doc(DOC).set({ enabled: true, updatedAt: new Date().toISOString() });
  await assert.rejects(drain(broker, { sleep: async () => {}, log: () => {} }), /disable first/);
});

test("parse validates commands, reasons and the canary", () => {
  const verifyUid = "verify-uid";
  assert.throws(() => parse(["wat"], { verifyUid }), /command must be/);
  assert.throws(() => parse(["enable"], { verifyUid }), /needs --reason/);
  assert.throws(() => parse(["canary", "--uid", "verify-uid", "--connection", "c", "--reason", "r"], { verifyUid }), /VERIFY_UID/);
  assert.throws(() => parse(["canary", "--clear", "--uid", "u", "--reason", "r"], { verifyUid }), /or --clear/);
  assert.throws(() => parse(["drain", "--max-ms", "x"], { verifyUid }), /positive integer/);
  assert.deepEqual(parse(["canary", "--uid", "u", "--connection", "c", "--reason", "r"], { verifyUid }).uid, "u");
});
