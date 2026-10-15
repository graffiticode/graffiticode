// RETAIN-01 checks (scripts/lib/retention.js), against fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { checkDatabase, configVerdict, compareDatabase, compareRelationships, cutoffFor, fixtureCheck, CUTOFF_MARGIN_MS, MAY_EXPIRE, PROTECTED } from "../lib/retention.js";
import { parse } from "../retention-check.js";

const P = "proj";
const ttl = (db, group, field = "expiresAt") => ({ name: `projects/${P}/databases/${db}/collectionGroups/${group}/fields/${field}`, ttlConfig: { state: "ACTIVE" } });
// A fake gcloud: answers by command, or throws.
const gcloud = answers => async args => {
  const key = args.slice(0, args.findIndex(a => a.startsWith("--"))).join(" ");
  const answer = answers[key];
  if (answer instanceof Error) throw answer;
  return answer;
};
const GOOD = {
  "firestore databases describe": { pointInTimeRecoveryEnablement: "POINT_IN_TIME_RECOVERY_ENABLED", versionRetentionPeriod: "604800s" },
  "firestore backups schedules list": [{ dailyRecurrence: {}, retention: "8467200s" }],
};

test("a database passes with TTL only where expiry is allowed, PITR on and a backup schedule", async () => {
  const r = await checkDatabase({ run: gcloud({ ...GOOD, "firestore fields ttls list": [ttl("broker", "jtis"), ttl("broker", "active-executions")] }), project: P, database: "broker" });
  assert.deepEqual([r.ttl.result, r.pitr.result, r.backups.result], ["pass", "pass", "pass"]);
  assert.match(r.ttl.detail, /jtis, active-executions/);
  assert.equal(configVerdict([r]), "pass");
});

test("a TTL on a protected collection fails, wherever it is", async () => {
  for (const [db, group] of [["broker", "receipts"], ["broker", "outcome"], ["policy", "invocations"], ["policy", "plans"], ["(default)", "artifacts"], ["policy", "jtis"]]) {
    const r = await checkDatabase({ run: gcloud({ ...GOOD, "firestore fields ttls list": [ttl(db, group)] }), project: P, database: db });
    assert.equal(r.ttl.result, "fail", `${db}/${group}`);
    assert.equal(configVerdict([r]), "fail");
  }
});

test("PITR off or no backup schedule fails; a gcloud failure is incomplete, never a pass", async () => {
  const off = await checkDatabase({ run: gcloud({ "firestore fields ttls list": [], "firestore databases describe": { pointInTimeRecoveryEnablement: "POINT_IN_TIME_RECOVERY_DISABLED" }, "firestore backups schedules list": [] }), project: P, database: "policy" });
  assert.deepEqual([off.pitr.result, off.backups.result], ["fail", "fail"]);
  const broken = await checkDatabase({ run: gcloud({ ...GOOD, "firestore fields ttls list": new Error("permission denied") }), project: P, database: "policy" });
  assert.equal(broken.ttl.result, "incomplete");
  assert.equal(configVerdict([broken]), "incomplete");
  // A fail anywhere outranks an incomplete elsewhere.
  assert.equal(configVerdict([broken, off]), "fail");
});

// Documents as the comparison reads them (times in ms).
const doc = (path, data, createTime, updateTime = createTime) => ({ path, data, createTime, updateTime });
const T = 1_000_000;

test("system preview sessions' signature slots may expire (cleanup only), only in Broker's database, and are no protected record", async () => {
  const r = await checkDatabase({ run: gcloud({ ...GOOD, "firestore fields ttls list": [ttl("broker", "jtis"), ttl("broker", "system-session-slots")] }), project: P, database: "broker" });
  assert.equal(r.ttl.result, "pass");
  assert.match(r.ttl.detail, /system-session-slots/);
  assert.ok(MAY_EXPIRE.broker.includes("system-session-slots"));
  assert.ok(Object.values(PROTECTED).every(patterns => patterns.every(p => !p.startsWith("system-session-slots"))));
  const elsewhere = await checkDatabase({ run: gcloud({ ...GOOD, "firestore fields ttls list": [ttl("policy", "system-session-slots")] }), project: P, database: "policy" });
  assert.equal(elsewhere.ttl.result, "fail");
  // A restore comparison never expects them.
  const restore = compareDatabase({ database: "broker", production: [doc("system-session-slots/sid-1:0", { k: 0 }, 10)], restored: [], cutoff: T });
  assert.deepEqual([restore.reference, restore.problems], [0, []]);
});

test("documents unchanged before the cutoff are compared field for field; later updates only for existence", () => {
  const production = [
    doc("receipts/a", { binding: { x: 1 }, pld: "p1" }, 10),
    doc("receipts/a/steps/0", { step: "questions" }, 11),
    doc("receipts/a/outcome/final", { status: "succeeded" }, 12),
    doc("receipts/b", { binding: { x: 2 } }, 20),
    doc("receipts/c", { binding: { x: 3 } }, T + 5), // created after the cutoff: not expected
    doc("jtis/j", { expiresAt: 1 }, 5), // not protected
  ];
  const restored = [
    doc("receipts/a", { pld: "p1", binding: { x: 1 } }, 10), // same fields, other order
    doc("receipts/a/steps/0", { step: "questions" }, 11),
    doc("receipts/a/outcome/final", { status: "succeeded" }, 12),
    doc("receipts/b", { binding: { x: 2 } }, 20),
  ];
  const ok = compareDatabase({ database: "broker", production, restored, cutoff: T });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.reference, 4);
  assert.deepEqual(ok.counts["receipts/*/steps"], { reference: 1, restoredOfReference: 1 });

  const bad = compareDatabase({ database: "broker", production, restored: [restored[0], doc("receipts/a/steps/0", { step: "items" }, 11)], cutoff: T });
  assert.deepEqual(bad.problems.sort(), ["differs receipts/a/steps/0", "missing receipts/a/outcome/final", "missing receipts/b"]);
});

test("a document created before the cutoff and updated since is checked for existence, not contents", () => {
  // An invocation that got its plan digest after the backup.
  const production = [doc("invocations/i1", { planDigest: "p1", seq: 1 }, 10, T + 100)];
  assert.deepEqual(compareDatabase({ database: "policy", production, restored: [doc("invocations/i1", { seq: 1 }, 10)], cutoff: T }).problems, []);
  assert.deepEqual(compareDatabase({ database: "policy", production, restored: [], cutoff: T }).problems, ["missing (updated since) invocations/i1"]);
});

test("links are checked between records that existed before the cutoff, across the two restores", () => {
  const policyProduction = [
    doc("idempotency-keys/k1", { invocationId: "i1" }, 10),
    doc("invocations/i1", { planDigest: "p1" }, 10, 11),
    doc("plans/p1", { invocationId: "i1" }, 11),
    doc("idempotency-keys/k2", { invocationId: "i2" }, T + 1), // after the cutoff: not checked
  ];
  const brokerProduction = [doc("receipts/r1", { pld: "p1" }, 12), doc("receipts/r2", { pld: "p9" }, 12)];
  const complete = compareRelationships({ policyProduction, brokerProduction, policyRestored: policyProduction.slice(0, 3), brokerRestored: brokerProduction, cutoff: T });
  assert.deepEqual(complete, []);
  const broken = compareRelationships({ policyProduction, brokerProduction, policyRestored: [policyProduction[0]], brokerRestored: [], cutoff: T });
  assert.deepEqual(broken, [
    "key idempotency-keys/k1 -> invocations/i1 missing in restore",
    "invocation invocations/i1 -> plans/p1 missing in restore",
    "plan p1 -> receipts/r1 missing in restore",
  ]);
});

test("the cutoff is the earlier exact snapshot time minus the margin, never rounded, and refused without one", () => {
  const policy = Date.parse("2026-10-14T03:17:42.517Z");
  const broker = Date.parse("2026-10-14T03:19:05.004Z");
  assert.equal(cutoffFor([policy, broker]), policy - CUTOFF_MARGIN_MS);
  assert.equal(new Date(cutoffFor([policy, broker])).toISOString(), "2026-10-14T03:16:42.517Z");
  assert.throws(() => cutoffFor([policy, Number.NaN]), /snapshot time/);
  assert.throws(() => cutoffFor([]), /snapshot time/);
});

test("the canary's receipts before the cutoff are fixtures, and each must be in the restore", () => {
  const brokerProduction = [
    doc("receipts/c1", { binding: { connectionId: "conn-canary" } }, 10),
    doc("receipts/c2", { binding: { connectionId: "conn-canary" } }, T + 1), // after: not a fixture
    doc("receipts/u1", { binding: { connectionId: "conn-user" } }, 10),
  ];
  assert.deepEqual(fixtureCheck({ brokerProduction, brokerRestored: [brokerProduction[0]], cutoff: T, canaryConnections: ["conn-canary"] }), { fixtures: 1, missing: [] });
  assert.deepEqual(fixtureCheck({ brokerProduction, brokerRestored: [], cutoff: T, canaryConnections: ["conn-canary"] }), { fixtures: 1, missing: ["receipts/c1"] });
});

test("options: the configuration check by default; --compare needs both restores, the canary, and never a production database", () => {
  assert.equal(parse([]).compare, false);
  const ok = parse(["--compare", "--policy-restore", "policy-restore-1", "--broker-restore", "broker-restore-1", "--canary-connection", "conn-canary"]);
  assert.deepEqual([ok.policyRestore, ok.brokerRestore, ok.canaryConnections], ["policy-restore-1", "broker-restore-1", ["conn-canary"]]);
  assert.throws(() => parse(["--compare", "--policy-restore", "x"]), /--policy-restore and --broker-restore/);
  assert.throws(() => parse(["--compare", "--policy-restore", "x", "--broker-restore", "y"]), /--canary-connection/);
  assert.throws(() => parse(["--compare", "--policy-restore", "policy", "--broker-restore", "y", "--canary-connection", "c"]), /production database/);
  assert.throws(() => parse(["--wat", "1"]), /unknown option/);
});
