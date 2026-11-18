// The C5a gate's verdict, offline (scripts/lib/c5a-gate-checks.js): one
// complete passing observation set, and each check failing on its own when
// its evidence is wrong or missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pinnedStage } from "@graffiticode/common/contract";
import { createAudit } from "@graffiticode/policy";
import { CHECKS, verdict, GATE_BUCKET, PUBLIC_CAPTURE_LIMIT, planObservation, planStages, tokensFromAudit, rateLimitFromAudit, brokerAuditFilter, dueObservation } from "../lib/c5a-gate-checks.js";

const approved = { l0013r: { revision: "l0013r-rmwl2casf-31e8b9", contractVersions: [3] }, l0000r: { revision: "l0000r-rmw8gtkc2-830693", contractVersions: [1, 2] }, l0176r: { revision: "l0176r-rmwk08k8n-c74227", contractVersions: [1, 2] }, beforeDigest: "a1", afterDigest: "a1" };
const stage = (lang, i, over = {}) => ({ stage: `s${i}`, lang, revision: approved[`l${lang}r`].revision, contractVersions: approved[`l${lang}r`].contractVersions, registryVersion: lang === "0000" ? 0 : 9, ...over });
const PASSING = () => ({
  gateBucket: GATE_BUCKET,
  approvals: structuredClone(approved),
  canary: { checks: 36, failed: 0, l0185RegistryVersion: 0, l0176RegistryVersion: 9 },
  repairRoundtrip: { passed: true },
  v2PlanDigest: { before: "p1", after: "p1" },
  v8Artifact: { served: true },
  plans: [
    { name: "private", stages: [stage("0013", 0)], admitted: true },
    { name: "mixed", stages: [stage("0013", 0), stage("0176", 1)], admitted: true },
    { name: "composition", stages: [stage("0000", 0), stage("0013", 1)], admitted: true },
  ],
  privateOwner: { outcome: "completed", reservedSequence: 7, published: { bucket: GATE_BUCKET, captureSequence: 7 } },
  privateNonOwner: { outcome: "failed", reason: "not-owner" },
  narrowed: { reason: "not-owner" },
  publicAnonymous: { outcome: "completed", subject: "anonymous", publicCapture: true, rateLimit: { allowed: PUBLIC_CAPTURE_LIMIT, refused: 1, refusedAfterQuota: true, attempted: PUBLIC_CAPTURE_LIMIT + 1 } },
  mixed: { invocations: 1, tokens: [{ fn: "snap", scopeKinds: ["item"] }, { fn: "save-to-itembank", scopeKinds: ["connection"] }] },
  deployed: { policy: "p".repeat(40), broker: "b".repeat(40), l0013r: "l".repeat(40) },
  hermetic: {
    mismatches: { service: "broker", commit: "b".repeat(40), test: "packages/broker/src/gcs.spec.ts › credential-scope-mismatch", output: "ok 2 of 2", passed: true, results: [{ direction: "service-with-connection", reason: "credential-scope-mismatch" }, { direction: "connection-with-item", reason: "credential-scope-mismatch" }] },
    preSlice6: { service: "policy", commit: "p".repeat(40), test: "packages/policy/src/scopes.spec.ts › contract-version-unsupported", output: "ok", passed: true, fixture: { lang: "0013", approved: true, contractVersions: [1, 2] }, result: { reason: "contract-version-unsupported" } },
  },
  composition: { outcome: "completed", connectionId: null, contractVersion: 3, itemScopeAuthorized: true },
  conditional: { attempts: [{ decisionId: "d1" }, { decisionId: "d2" }], finalSequence: 12, newerSequence: 12 },
  reserveStageBind: { order: ["reserve", "stage", "bind"], repeatReserveSame: true, repeatStageSame: true, publishedSequence: 7, reservedSequence: 7, outOfOrderFinal: 12, outOfOrderNewer: 12 },
  elsewhere: { appspotBefore: "h1", appspotAfter: "h1", thumbnailsObjects: 0 },
  oldWorkers: { v3Fixtures: ["c:v3a", "c:v3b"], productionListedV3: [], scopedListedV3: ["c:v3a", "c:v3b"], controlListedToProduction: true, productionLease: "worker-unsupported" },
  consoleRoute: [{ caller: "policy-run@graffiticode.iam.gserviceaccount.com", status: 200 }, { caller: "api-run@graffiticode.iam.gserviceaccount.com", status: 403 }, { caller: "anonymous", status: 403 }],
  proxy: { verifyRollout: true, at11: "step26-exception" },
});

const failsOnly = (id, mutate) => {
  const o = PASSING();
  mutate(o);
  const v = verdict(o);
  assert.equal(v.passed, false, `${id}: the gate still passed`);
  assert.deepEqual(v.checks.filter(c => !c.ok).map(c => c.id), [id], `${id}: ${JSON.stringify(v.checks.filter(c => !c.ok))}`);
};

test("a complete observation set passes every check", () => {
  const v = verdict(PASSING());
  assert.deepEqual(v.checks.filter(c => !c.ok), []);
  assert.equal(v.passed, true);
  assert.equal(v.checks.length, CHECKS.length);
});

test("nothing observed passes nothing", () => {
  const v = verdict({});
  assert.equal(v.passed, false);
  // Only "no read failed" holds of nothing; every other check needs evidence.
  assert.deepEqual(v.checks.filter(c => c.ok).map(c => c.id), ["observations-read"]);
  assert.ok(v.checks.filter(c => !c.ok).every(c => typeof c.detail === "string" && c.detail !== "ok"));
});

test("each check fails on its own evidence", () => {
  failsOnly("l0176-unchanged", o => { o.canary.failed = 1; });
  failsOnly("l0176-unchanged", o => { o.v2PlanDigest.after = "p2"; });
  failsOnly("plans-pin-approved", o => { o.plans[0].stages[0].revision = "l0013r-rmwjzlgz6-2882e6"; });
  failsOnly("private-owner", o => { o.privateOwner.published.captureSequence = 6; });
  failsOnly("private-owner", o => { o.privateOwner.published.bucket = "graffiticode.appspot.com"; });
  failsOnly("private-non-owner", o => { o.narrowed = { reason: "allowed" }; });
  failsOnly("public-anonymous", o => { o.publicAnonymous.publicCapture = false; });
  failsOnly("public-anonymous", o => { o.publicAnonymous.rateLimit.refused = 0; });
  // The reviewer's case: one capture allowed, then twelve refusals.
  failsOnly("public-anonymous", o => { o.publicAnonymous.rateLimit = { allowed: 1, refused: 12, refusedAfterQuota: true, attempted: 13 }; });
  failsOnly("public-anonymous", o => { o.publicAnonymous.rateLimit.refusedAfterQuota = false; });
  failsOnly("public-anonymous", o => { delete o.publicAnonymous.rateLimit; });
  failsOnly("mixed-chain", o => { o.mixed.invocations = 2; });
  failsOnly("mixed-chain", o => { o.mixed.tokens[0].scopeKinds = ["item", "connection"]; });
  failsOnly("mismatches", o => { o.hermetic.mismatches.results.pop(); });
  failsOnly("mismatches", o => { o.hermetic.mismatches.commit = "0".repeat(40); });
  failsOnly("composition", o => { o.composition.connectionId = "conn-1"; });
  failsOnly("per-stage-contracts", o => { o.hermetic.preSlice6.result.reason = "allowed"; });
  // An unapproved fixture tests another refusal.
  failsOnly("per-stage-contracts", o => { o.hermetic.preSlice6.fixture.approved = false; });
  failsOnly("per-stage-contracts", o => { o.approvals.afterDigest = "a2"; });
  failsOnly("conditional-retry", o => { o.conditional.attempts[1].decisionId = "d1"; });
  failsOnly("conditional-retry", o => { o.conditional.finalSequence = 11; });
  failsOnly("reserve-stage-bind", o => { o.reserveStageBind.repeatStageSame = false; });
  failsOnly("reserve-stage-bind", o => { o.reserveStageBind.order = ["stage", "reserve", "bind"]; });
  failsOnly("nothing-elsewhere", o => { o.elsewhere.thumbnailsObjects = 1; });
  failsOnly("nothing-elsewhere", o => { o.elsewhere.appspotAfter = "h2"; });
  failsOnly("old-workers", o => { o.oldWorkers.productionListedV3 = ["c:v3a"]; });
  failsOnly("old-workers", o => { o.oldWorkers.controlListedToProduction = false; });
  failsOnly("old-workers", o => { o.oldWorkers.scopedListedV3 = ["c:v3a"]; });
  failsOnly("old-workers", o => { o.oldWorkers.productionLease = "leased"; });
  failsOnly("old-workers", o => { o.oldWorkers.v3Fixtures = []; });
  failsOnly("console-route", o => { o.consoleRoute[1].status = 200; });
  failsOnly("proxy", o => { o.proxy.at11 = "pending"; });
});

test("registry versions and per-stage contracts are judged from the plans' own stages", () => {
  failsOnly("registry-versions", o => { o.plans[1].stages[1].registryVersion = 8; });
  failsOnly("registry-versions", o => { o.canary.l0185RegistryVersion = 9; });
  // An L0176 stage at [3] breaks both its pin and the per-stage rule.
  const o = PASSING();
  o.plans[1].stages[1].contractVersions = [3];
  assert.deepEqual(verdict(o).checks.filter(c => !c.ok).map(c => c.id).sort(), ["per-stage-contracts", "plans-pin-approved"]);
});

// The owner's review of #417: a failed read never passes as an empty one, and
// each scenario needs its own languages and stages.
test("a failed read fails the gate, whatever else was observed", () => {
  failsOnly("observations-read", o => { o.errors = { elsewhere: "storage permission denied" }; });
  // The runner records a failed read as an error and no observation: both fail.
  const o = PASSING();
  o.errors = { elsewhere: "storage permission denied" };
  delete o.elsewhere;
  assert.deepEqual(verdict(o).checks.filter(c => !c.ok).map(c => c.id).sort(), ["nothing-elsewhere", "observations-read"]);
});

test("every scenario needs its expected stages, and every pinned language its approved revision", () => {
  // The reviewer's case: no L0000 or L0176 stage, and no approvals named for them.
  const o = PASSING();
  for (const p of o.plans) if (p.name !== "private") p.stages = p.stages.filter(st => st.lang === "0013");
  delete o.approvals.l0000r;
  delete o.approvals.l0176r;
  const failed = verdict(o).checks.filter(c => !c.ok).map(c => c.id);
  assert.equal(verdict(o).passed, false);
  for (const id of ["scenarios", "plans-pin-approved", "registry-versions"]) assert.ok(failed.includes(id), `${id} should fail: ${failed}`);
  failsOnly("scenarios", o2 => { o2.plans[2].stages.reverse(); o2.plans[2].stages.forEach((st, i) => { st.stage = `s${i}`; }); });
  // A mixed chain without its L0176 stage: the scenario fails (and with it the
  // only L0176 manifest, so registry versions too).
  const noSave = PASSING();
  noSave.plans = noSave.plans.filter(p => p.name !== "mixed").concat([{ name: "mixed", stages: [stage("0013", 0)], admitted: true }]);
  assert.deepEqual(verdict(noSave).checks.filter(c => !c.ok).map(c => c.id).sort(), ["registry-versions", "scenarios"]);
});

// The adapters, against the shapes the services write.
test("a plan's stages come from its stored document's `plan`, as Policy commits it", () => {
  const manifest = lang => ({ stage: lang === "0000" ? "s0" : "s1", lang, sourceDigest: "a".repeat(64), programDigest: "b".repeat(64), optionsDigest: "c".repeat(64), revision: approved[`l${lang}r`].revision, imageDigest: `sha256:${"d".repeat(64)}`, registryVersion: lang === "0000" ? 0 : 9, requiredFunctions: lang === "0013" ? ["snap"] : [] });
  // packages/policy/src/firestore.ts commitPlan: tx.set(planRef, { plan, invocationId, revisions, createdAt }).
  const planDoc = { plan: { contractVersion: 3, invocationId: "inv-1", stages: [manifest("0000"), manifest("0013")].map(pinnedStage) }, invocationId: "inv-1", revisions: [], createdAt: "2026-11-17T00:00:00Z" };
  assert.equal(planStages(planDoc).length, 2);
  assert.deepEqual(planStages({ stages: planDoc.plan.stages }), [], "a bare stages array is not a stored plan document");
  const record = { status: "completed", admission: { planDigest: "p", stages: { s1: { lang: "0013", revision: approved.l0013r.revision }, s0: { lang: "0000", revision: approved.l0000r.revision } } } };
  const approvals = { [`0013/${approved.l0013r.revision}`]: { contractVersions: [3] }, [`0000/${approved.l0000r.revision}`]: { contractVersions: [1, 2] } };
  assert.deepEqual(planObservation("composition", { record, planDoc }, approvals), {
    name: "composition",
    admitted: true,
    stages: [
      { stage: "s0", lang: "0000", revision: approved.l0000r.revision, contractVersions: [1, 2], registryVersion: 0 },
      { stage: "s1", lang: "0013", revision: approved.l0013r.revision, contractVersions: [3], registryVersion: 9 },
    ],
  });
});

test("execution tokens' scopes come from Broker's execute audit, as the audit writes it", () => {
  const written = [];
  const audit = createAudit({ sink: r => written.push(r), pseudonymize: v => `p:${v}` });
  // packages/broker/src/broker.ts's execute record: connectionId from `conn`,
  // itemId from `scp`, with the operation id's parts.
  audit({ event: "execute", uid: "u", ownerUid: "u", connectionId: null, lang: "0013", fn: "snap", op: "gcs.put-thumbnail", invocationId: "inv-1a2b", itemId: "privateItem00000001", outcome: "allowed" });
  audit({ event: "execute", uid: "u", ownerUid: "u", connectionId: "conn-1", lang: "0176", fn: "save-to-itembank", op: "learnosity.write-items", invocationId: "inv-1a2b", outcome: "allowed" });
  audit({ event: "execute-step", lang: "0013", fn: "snap", op: "gcs.put-thumbnail", invocationId: "inv-1a2b", outcome: "allowed" });
  const entries = written.map(jsonPayload => ({ jsonPayload: { ...jsonPayload, logName: "security_audit" } }));
  assert.deepEqual(tokensFromAudit(entries), [{ fn: "snap", scopeKinds: ["item"] }, { fn: "save-to-itembank", scopeKinds: ["connection"] }]);
  assert.match(brokerAuditFilter("inv-1a2b"), /jsonPayload\.invocationId="inv-1a2b"/);
});

test("the public-capture quota comes from Policy's reservation audit, as the audit writes it", () => {
  const written = [];
  const audit = createAudit({ sink: r => written.push(r), pseudonymize: v => `p:${v}` });
  const id = i => `c:${i.toString(16).padStart(64, "0")}`;
  for (let i = 0; i < PUBLIC_CAPTURE_LIMIT; i++) audit({ event: "command-reserve", commandId: id(i), itemId: "publicItem000000001", publicCapture: true, outcome: "allowed" });
  audit({ event: "command-reserve", commandId: id(99), itemId: "publicItem000000001", outcome: "denied", reason: "rate-limited" });
  // Cloud Logging entries, a second apart, in order.
  const entries = written.map((jsonPayload, i) => ({ timestamp: new Date(Date.UTC(2026, 10, 17, 22, 0, i)).toISOString(), jsonPayload }));
  assert.deepEqual(rateLimitFromAudit(entries), { allowed: PUBLIC_CAPTURE_LIMIT, refused: 1, refusedAfterQuota: true });
  // One command's repeated reservation counts once; a refusal before the
  // quota's last allowed one isn't the quota's.
  const repeated = entries.map((e, i) => (i < PUBLIC_CAPTURE_LIMIT ? { ...e, jsonPayload: { ...e.jsonPayload, commandId: id(0) } } : e));
  assert.equal(rateLimitFromAudit(repeated).allowed, 1);
  const early = entries.map((e, i) => (i === PUBLIC_CAPTURE_LIMIT ? { ...e, timestamp: entries[0].timestamp } : e));
  assert.equal(rateLimitFromAudit(early).refusedAfterQuota, false);
});

// The owner's second review of #417.
test("hermetic evidence must name the deployed commit, and a fallback never replaces a live observation", () => {
  // A live violation stays a violation, whatever the fallback says.
  failsOnly("private-non-owner", o => {
    o.narrowed = { reason: "allowed" };
    o.hermetic.narrowed = { service: "policy", commit: "p".repeat(40), test: "t", output: "ok", passed: true, uninducible: "race", result: { reason: "not-owner" } };
  });
  // With no live observation, a valid fallback is accepted...
  const fallback = PASSING();
  delete fallback.conditional;
  fallback.hermetic.conditional = { service: "broker", commit: "b".repeat(40), test: "packages/broker/src/gcs.spec.ts › precondition", output: "ok", passed: true, uninducible: "the older capture couldn't be made to publish first from outside", result: { attempts: [{ decisionId: "d1" }, { decisionId: "d2" }], finalSequence: 2, newerSequence: 2 } };
  assert.deepEqual(verdict(fallback).checks.filter(c => !c.ok), []);
  // ...but not without saying why the case couldn't be induced live, nor at
  // another commit.
  failsOnly("conditional-retry", o => { delete o.conditional; o.hermetic.conditional = { ...fallback.hermetic.conditional, uninducible: "" }; });
  failsOnly("conditional-retry", o => { delete o.conditional; o.hermetic.conditional = { ...fallback.hermetic.conditional, commit: "0".repeat(40) }; });
  failsOnly("reserve-stage-bind", o => { delete o.reserveStageBind; });
  // No deployed commit observed: no hermetic row can pass.
  const o = PASSING();
  delete o.deployed;
  assert.deepEqual(verdict(o).checks.filter(c => !c.ok).map(c => c.id).sort(), ["mismatches", "per-stage-contracts"]);
});

test("the due observation comes from the due queries' answers, as each worker asks", () => {
  const due = dueObservation({
    v3Fixtures: ["c:v3a", "c:v3b"],
    control: "c:v2",
    productionQueries: [{ commands: [{ commandId: "c:other" }] }, { commands: [{ commandId: "c:v2", generation: 1 }] }],
    scopedQueries: [{ commands: [{ commandId: "c:v3a" }, { commandId: "c:v2" }] }, { commands: [{ commandId: "c:v3b" }] }],
    productionLease: "worker-unsupported",
  });
  assert.deepEqual(due, { v3Fixtures: ["c:v3a", "c:v3b"], productionListedV3: [], scopedListedV3: ["c:v3a", "c:v3b"], controlListedToProduction: true, productionLease: "worker-unsupported", queries: 4 });
  // The reviewer's case: production listed a v3 command (its lease refused).
  const leaked = dueObservation({ v3Fixtures: ["c:v3a"], control: "c:v2", productionQueries: [{ commands: [{ commandId: "c:v3a" }, { commandId: "c:v2" }] }], scopedQueries: [{ commands: [{ commandId: "c:v3a" }] }], productionLease: "worker-unsupported" });
  const o = PASSING();
  o.oldWorkers = leaked;
  assert.deepEqual(verdict(o).checks.filter(c => !c.ok).map(c => c.id), ["old-workers"]);
});
