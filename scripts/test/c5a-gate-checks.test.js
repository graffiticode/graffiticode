// The C5a gate's verdict, offline (scripts/lib/c5a-gate-checks.js): one
// complete passing observation set, and each check failing on its own when
// its evidence is wrong or missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKS, verdict, GATE_BUCKET } from "../lib/c5a-gate-checks.js";

const approved = { l0013r: { revision: "l0013r-rmwl2casf-31e8b9", contractVersions: [3] }, l0000r: { revision: "l0000r-rmw8gtkc2-830693", contractVersions: [1, 2] }, l0176r: { revision: "l0176r-rmwk08k8n-c74227", contractVersions: [1, 2] }, beforeDigest: "a1", afterDigest: "a1" };
const stage = (lang, over = {}) => ({ lang, revision: approved[`l${lang}r`].revision, contractVersions: approved[`l${lang}r`].contractVersions, registryVersion: lang === "0000" ? 0 : 9, ...over });
const PASSING = () => ({
  gateBucket: GATE_BUCKET,
  approvals: structuredClone(approved),
  canary: { checks: 36, failed: 0, l0185RegistryVersion: 0, l0176RegistryVersion: 9 },
  repairRoundtrip: { passed: true },
  v2PlanDigest: { before: "p1", after: "p1" },
  v8Artifact: { served: true },
  plans: [
    { name: "private", stages: [stage("0013")], admitted: true },
    { name: "mixed", stages: [stage("0013"), stage("0176")], admitted: true },
    { name: "composition", stages: [stage("0000"), stage("0013")], admitted: true },
  ],
  preSlice6: { reason: "contract-version-unsupported" },
  privateOwner: { outcome: "completed", reservedSequence: 7, published: { bucket: GATE_BUCKET, captureSequence: 7 } },
  privateNonOwner: { outcome: "failed", reason: "not-owner" },
  narrowed: { reason: "not-owner" },
  publicAnonymous: { outcome: "completed", subject: "anonymous", publicCapture: true, rateLimited: true },
  mixed: { invocations: 1, tokens: [{ fn: "snap", scopeKinds: ["item"] }, { fn: "save-to-itembank", scopeKinds: ["connection"] }] },
  mismatches: [{ direction: "service-with-connection", reason: "credential-scope-mismatch" }, { direction: "connection-with-item", reason: "credential-scope-mismatch" }],
  composition: { outcome: "completed", connectionId: null, contractVersion: 3, itemScopeAuthorized: true },
  conditional: { attempts: [{ decisionId: "d1" }, { decisionId: "d2" }], finalSequence: 12, newerSequence: 12 },
  reserveStageBind: { order: ["reserve", "stage", "bind"], repeatReserveSame: true, repeatStageSame: true, publishedSequence: 7, reservedSequence: 7, outOfOrderFinal: 12, outOfOrderNewer: 12 },
  elsewhere: { appspotBefore: "h1", appspotAfter: "h1", thumbnailsObjects: 0 },
  oldWorkers: { listedToProduction: 0, sweeperLeases: 0 },
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
  assert.deepEqual(v.checks.filter(c => c.ok), []);
  assert.ok(v.checks.every(c => typeof c.detail === "string" && c.detail !== "ok"));
});

test("each check fails on its own evidence", () => {
  failsOnly("l0176-unchanged", o => { o.canary.failed = 1; });
  failsOnly("l0176-unchanged", o => { o.v2PlanDigest.after = "p2"; });
  failsOnly("plans-pin-approved", o => { o.plans[0].stages[0].revision = "l0013r-rmwjzlgz6-2882e6"; });
  failsOnly("private-owner", o => { o.privateOwner.published.captureSequence = 6; });
  failsOnly("private-owner", o => { o.privateOwner.published.bucket = "graffiticode.appspot.com"; });
  failsOnly("private-non-owner", o => { o.narrowed = { reason: "allowed" }; });
  failsOnly("public-anonymous", o => { o.publicAnonymous.publicCapture = false; });
  failsOnly("public-anonymous", o => { o.publicAnonymous.rateLimited = false; });
  failsOnly("mixed-chain", o => { o.mixed.invocations = 2; });
  failsOnly("mixed-chain", o => { o.mixed.tokens[0].scopeKinds = ["item", "connection"]; });
  failsOnly("mismatches", o => { o.mismatches.pop(); });
  failsOnly("composition", o => { o.composition.connectionId = "conn-1"; });
  failsOnly("per-stage-contracts", o => { o.preSlice6.reason = "allowed"; });
  failsOnly("per-stage-contracts", o => { o.approvals.afterDigest = "a2"; });
  failsOnly("conditional-retry", o => { o.conditional.attempts[1].decisionId = "d1"; });
  failsOnly("conditional-retry", o => { o.conditional.finalSequence = 11; });
  failsOnly("reserve-stage-bind", o => { o.reserveStageBind.repeatStageSame = false; });
  failsOnly("reserve-stage-bind", o => { o.reserveStageBind.order = ["stage", "reserve", "bind"]; });
  failsOnly("nothing-elsewhere", o => { o.elsewhere.thumbnailsObjects = 1; });
  failsOnly("nothing-elsewhere", o => { o.elsewhere.appspotAfter = "h2"; });
  failsOnly("old-workers", o => { o.oldWorkers.sweeperLeases = 1; });
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
