// The C5a gate's verdict, offline (scripts/lib/c5a-gate-checks.js): one
// complete passing observation set, and each check failing on its own when
// its evidence is wrong or missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pinnedStage } from "@graffiticode/common/contract";
import { createAudit } from "@graffiticode/policy";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { CHECKS, verdict, GATE_BUCKET, PUBLIC_CAPTURE_LIMIT, planObservation, planStages, tokensFromAudit, rateLimitFromAudit, brokerAuditFilter, dueObservation, pollUntil, reservesCover, imageObservation, MAX_MEAN_DIFF, MAX_REDDISH, verbatimProblem, fieldEvidence, rsbCaptureProblem } from "../lib/c5a-gate-checks.js";
import { decodePng, imageLooks, compareImages } from "../lib/png.js";

// The quota burst's commands: the quota's completed captures, then the one
// refused its reservation (retired: failed).
const QUOTA = Array.from({ length: PUBLIC_CAPTURE_LIMIT + 1 }, (_, i) => `c:anon${i + 1}`);
// Verbatim jest output of a passing test (the #421 review): the file's PASS
// line and a tick for each title the record names.
const jest = (file, ...titles) => `PASS src/${file}\n  describe\n${titles.map(t => `    ✓ ${t} (3 ms)`).join("\n")}\n\nTests:       ${titles.length} passed`;
const image = scenario => ({ scenario, expectedCommandIds: [`c:${scenario}`], commandId: `c:${scenario}`, generation: "1", captureSequence: 1, sha256: "s", width: 1024, height: 152, reddish: 0, blue: 4839, transparent: 0, reference: scenario === "public" ? "public" : "private", sameSize: true, identical: true, meanDiff: 0 });

const approved = { l0013r: { revision: "l0013r-rmwl2casf-31e8b9", contractVersions: [3] }, l0000r: { revision: "l0000r-rmw8gtkc2-830693", contractVersions: [1, 2] }, l0176r: { revision: "l0176r-rmwk08k8n-c74227", contractVersions: [1, 2] }, beforeDigest: "a1", beforeDigestKind: "canonical", afterDigest: "a1", afterDigestKind: "canonical" };
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
  publicAnonymous: { outcome: "completed", subject: "anonymous", publicCapture: true, rateLimit: { allowed: PUBLIC_CAPTURE_LIMIT, refused: 1, refusedAfterQuota: true, attempted: PUBLIC_CAPTURE_LIMIT + 1 }, commandIds: QUOTA },
  mixed: { invocations: 1, tokens: [{ fn: "snap", scopeKinds: ["item"] }, { fn: "save-to-itembank", scopeKinds: ["connection"] }] },
  deployed: { policy: "p".repeat(40), broker: "b".repeat(40), l0013r: "l".repeat(40) },
  hermetic: {
    mismatches: { service: "broker", commit: "b".repeat(40), test: "packages/broker/src/gcs.spec.ts › credential and scope › refuses a service operation with a connection; refuses a connection operation with an item", output: jest("gcs.spec.ts", "refuses a service operation with a connection", "refuses a connection operation with an item"), passed: true, results: [{ direction: "service-with-connection", reason: "credential-scope-mismatch" }, { direction: "connection-with-item", reason: "credential-scope-mismatch" }] },
    preSlice6: { service: "policy", commit: "p".repeat(40), test: "packages/policy/src/scopes.spec.ts › the per-stage contract rule › refuses a pre-slice-6 l0013r", output: jest("scopes.spec.ts", "refuses a pre-slice-6 l0013r"), passed: true, fixture: { lang: "0013", approved: true, contractVersions: [1, 2] }, result: { reason: "contract-version-unsupported" } },
  },
  composition: { outcome: "completed", connectionId: null, contractVersion: 3, itemScopeAuthorized: true },
  conditional: { attempts: [{ decisionId: "d1" }, { decisionId: "d2" }], finalSequence: 12, newerSequence: 12 },
  reserveStageBind: { order: ["reserve", "stage", "bind"], repeatReserveSame: true, repeatStageSame: true, publishedSequence: 7, reservedSequence: 7, outOfOrderFinal: 12, outOfOrderNewer: 12 },
  elsewhere: { appspotBefore: "h1", appspotAfter: "h1", thumbnailsObjects: 0 },
  oldWorkers: { v3Fixtures: ["c:v3a", "c:v3b"], control: "c:v2", productionListedV3: [], scopedListedV3: ["c:v3a", "c:v3b"], controlListedToProduction: true, controlListedToScoped: true, productionLease: "worker-unsupported" },
  fixtureCleanup: { fixtures: ["c:v3a", "c:v3b", "c:v2", ...QUOTA], statuses: { "c:v3a": "failed", "c:v3b": "failed", "c:v2": "failed", ...Object.fromEntries(QUOTA.map((id, i) => [id, i < PUBLIC_CAPTURE_LIMIT ? "completed" : "failed"])) }, listedAfter: [] },
  consoleRoute: [{ caller: "policy-run@graffiticode.iam.gserviceaccount.com", status: 200 }, { caller: "api-run@graffiticode.iam.gserviceaccount.com", status: 403 }, { caller: "anonymous", status: 403 }],
  proxy: { verifyRollout: true, at11: "step26-exception" },
  images: {
    references: { private: { sha256: "r1", width: 1024, height: 152 }, public: { sha256: "r2", width: 1024, height: 152 } },
    captures: ["private", "composition", "mixed", "public"].map(image),
  },
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
  failsOnly("old-workers", o => { o.oldWorkers.controlListedToScoped = false; });
  failsOnly("fixtures-retired", o => { o.fixtureCleanup.statuses["c:v3b"] = "pending"; });
  failsOnly("fixtures-retired", o => { o.fixtureCleanup.listedAfter = ["c:v3a"]; });
  // #418 review: the command past the quota, left pending and due.
  failsOnly("fixtures-retired", o => { o.fixtureCleanup.statuses["c:anon13"] = "pending"; o.fixtureCleanup.listedAfter = ["c:anon13"]; });
  failsOnly("fixtures-retired", o => { o.fixtureCleanup.fixtures = o.fixtureCleanup.fixtures.filter(id => id !== "c:anon13"); delete o.fixtureCleanup.statuses["c:anon13"]; });
  failsOnly("fixtures-retired", o => { delete o.publicAnonymous.commandIds; });
  failsOnly("console-route", o => { o.consoleRoute[1].status = 200; });
  failsOnly("proxy", o => { o.proxy.at11 = "pending"; });
  // The r381d64 captures: the composition photographed "failed to post compile".
  failsOnly("images-correct", o => { Object.assign(o.images.captures[1], { reddish: 0.826, identical: false, sameSize: false, height: 54, meanDiff: null }); });
  failsOnly("images-correct", o => { o.images.captures[2].meanDiff = 0.97; o.images.captures[2].identical = false; });
  failsOnly("images-correct", o => { o.images.captures[0].commandId = "c:composition"; });
  failsOnly("images-correct", o => { o.images.captures[3].reference = "private"; });
  failsOnly("images-correct", o => { o.images.captures.pop(); });
  failsOnly("images-correct", o => { delete o.images.references.public; });
  failsOnly("images-correct", o => { o.images.captures[1].transparent = 1; });
  failsOnly("images-correct", o => { delete o.images.captures[0].transparent; });
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
    o.hermetic.narrowed = { service: "policy", commit: "p".repeat(40), test: "packages/policy/src/scopes.spec.ts › v3 › narrowed", output: jest("scopes.spec.ts", "narrowed"), passed: true, uninducible: "race", result: { reason: "not-owner" } };
  });
  // With no live observation, a valid fallback is accepted...
  const fallback = PASSING();
  delete fallback.conditional;
  fallback.hermetic.conditional = { service: "broker", commit: "b".repeat(40), test: "packages/broker/src/gcs.spec.ts › publishing › precondition", output: jest("gcs.spec.ts", "precondition"), passed: true, uninducible: "the older capture couldn't be made to publish first from outside", result: { attempts: [{ decisionId: "d1" }, { decisionId: "d2" }], finalSequence: 2, newerSequence: 2 } };
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
  assert.deepEqual(due, { v3Fixtures: ["c:v3a", "c:v3b"], control: "c:v2", productionListedV3: [], scopedListedV3: ["c:v3a", "c:v3b"], controlListedToProduction: true, controlListedToScoped: true, productionLease: "worker-unsupported", queries: 4 });
  // The reviewer's case: production listed a v3 command (its lease refused).
  const leaked = dueObservation({ v3Fixtures: ["c:v3a"], control: "c:v2", productionQueries: [{ commands: [{ commandId: "c:v3a" }, { commandId: "c:v2" }] }], scopedQueries: [{ commands: [{ commandId: "c:v3a" }] }], productionLease: "worker-unsupported" });
  const o = PASSING();
  o.oldWorkers = leaked;
  assert.deepEqual(verdict(o).checks.filter(c => !c.ok).map(c => c.id), ["old-workers"]);
});

// The owner's review of the r381d64 captures: image content is evidence, and an
// audit read waits for ingestion.
const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const SHEET = "c5a-private-sheet.png"; // E3: the private fixture, rendered correctly
const ERROR = "c5a-private-error.png"; // the composition and mixed captures: "failed to post compile"
const PUBLIC = "c5a-public-sheet.png"; // the public fixture: the same sheet, one word different

test("the camera's PNGs decode, and an error render is told from the sheet by its pixels", () => {
  const sheet = decodePng(fixture(SHEET));
  const error = decodePng(fixture(ERROR));
  assert.deepEqual([sheet.width, sheet.height, error.width, error.height], [1024, 152, 1024, 54]);
  const looks = { sheet: imageLooks(sheet), error: imageLooks(error) };
  assert.ok(looks.sheet.reddish < MAX_REDDISH && looks.sheet.blue > 4000, JSON.stringify(looks.sheet));
  assert.ok(looks.error.reddish > 0.8 && looks.error.blue === 0, JSON.stringify(looks.error));
  // A correct render is identical to its reference; one word different is not close enough.
  assert.deepEqual(compareImages(sheet, decodePng(fixture(SHEET))), { sameSize: true, identical: true, meanDiff: 0 });
  const near = compareImages(sheet, decodePng(fixture(PUBLIC)));
  assert.ok(near.sameSize && !near.identical && near.meanDiff > MAX_MEAN_DIFF * 10, JSON.stringify(near));
  assert.equal(compareImages(sheet, error).sameSize, false);
  assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG/);
});

// A PNG writer for the tests: IHDR, one IDAT of already-filtered rows, IEND.
const crc = buf => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, "latin1"), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
const writePng = ({ width, height, colorType, filtered }) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(filtered)), chunk("IEND", Buffer.alloc(0))]);
};
// An RGBA image as a filter-0 PNG.
const rgbaPng = ({ width, height, rgba }) => writePng({ width, height, colorType: 6, filtered: Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4))]))) });

test("decoding undoes every PNG row filter", () => {
  // A 3×2 RGB image, written with filters 1–4 against a filter-0 reading.
  const pixels = [[[10, 20, 30], [40, 50, 60], [70, 80, 90]], [[15, 25, 35], [45, 255, 65], [0, 5, 250]]];
  const png = filter => {
    const rows = pixels.map(r => Buffer.from(r.flat()));
    const out = [];
    rows.forEach((row, y) => {
      const prev = y ? rows[y - 1] : Buffer.alloc(row.length);
      const f = Buffer.alloc(row.length);
      for (let x = 0; x < row.length; x++) {
        const a = x >= 3 ? row[x - 3] : 0;
        const b = prev[x];
        const c = x >= 3 ? prev[x - 3] : 0;
        const p = a + b - c;
        const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
        f[x] = (row[x] - [0, a, b, (a + b) >> 1, paeth][filter]) & 255;
      }
      out.push(Buffer.from([filter]), f);
    });
    return writePng({ width: 3, height: 2, colorType: 2, filtered: Buffer.concat(out) });
  };
  const expected = Uint8Array.from(pixels.flat().flatMap(p => [...p, 255]));
  for (const filter of [0, 1, 2, 3, 4]) assert.deepEqual(decodePng(png(filter)).rgba, expected, `filter ${filter}`);
});

test("an image observation names its command, and is judged against its item's reference", () => {
  const sheet = decodePng(fixture(SHEET));
  const observe = (png, commandId) => imageObservation({ scenario: "composition", expectedCommandIds: ["c:comp"], object: { commandId, generation: "2", captureSequence: 2 }, looks: imageLooks(png), comparison: compareImages(png, sheet), reference: "private", sha256: "x" });
  const o = PASSING();
  o.images.captures[1] = observe(sheet, "c:comp");
  assert.equal(verdict(o).passed, true);
  o.images.captures[1] = observe(decodePng(fixture(ERROR)), "c:comp");
  assert.match(verdict(o).checks.find(c => c.id === "images-correct").detail, /composition: an error render/);
  o.images.captures[1] = observe(sheet, "c:mixed");
  assert.match(verdict(o).checks.find(c => c.id === "images-correct").detail, /c:mixed's capture, not this scenario's/);
});

test("a transparent image is never a correct capture, even with the reference's RGB values", () => {
  // The #418 review's reproducer: the private reference's RGB, every alpha 0.
  const sheet = decodePng(fixture(SHEET));
  assert.equal(imageLooks(sheet).transparent, 0, "the camera's screenshots are opaque");
  const invisible = decodePng(rgbaPng({ ...sheet, rgba: sheet.rgba.map((v, i) => (i % 4 === 3 ? 0 : v)) }));
  assert.equal(imageLooks(invisible).transparent, 1);
  const comparison = compareImages(invisible, sheet);
  assert.ok(!comparison.identical && comparison.meanDiff > MAX_MEAN_DIFF, JSON.stringify(comparison));
  // One translucent pixel is enough to fail, though it is all but identical.
  const one = Uint8Array.from(sheet.rgba);
  one[3] = 254;
  const translucent = decodePng(rgbaPng({ ...sheet, rgba: one }));
  assert.ok(compareImages(translucent, sheet).meanDiff <= MAX_MEAN_DIFF);
  const observe = png => imageObservation({ scenario: "composition", expectedCommandIds: ["c:comp"], object: { commandId: "c:comp", generation: "2", captureSequence: 2 }, looks: imageLooks(png), comparison: compareImages(png, sheet), reference: "private", sha256: "x" });
  for (const png of [invisible, translucent]) {
    const o = PASSING();
    o.images.captures[1] = observe(png);
    const result = verdict(o);
    assert.equal(result.passed, false);
    assert.match(result.checks.find(c => c.id === "images-correct").detail, /composition: unexpected transparency/);
  }
  // The same image, opaque, passes.
  const o = PASSING();
  o.images.captures[1] = observe(decodePng(rgbaPng(sheet)));
  assert.equal(verdict(o).passed, true);
});

test("an audit read polls until every expected record is ingested, and no longer than its bound", async () => {
  // The r381d64 case: the 13th reserve (refused) arrived after the first read.
  const reserve = (commandId, outcome) => ({ jsonPayload: { event: "command-reserve", commandId, outcome } });
  const ids = ["c:1", "c:2", "c:13"];
  const reads = [[reserve("c:1", "allowed"), reserve("c:2", "allowed")], [reserve("c:1", "allowed"), reserve("c:2", "allowed"), reserve("c:13", "denied")]];
  let t = 0;
  const clock = { now: () => t, sleep: async ms => { t += ms; } };
  let n = 0;
  const done = await pollUntil({ read: async () => reads[Math.min(n++, 1)], done: reservesCover(ids), timeoutMs: 60_000, intervalMs: 10_000, ...clock });
  assert.deepEqual([done.attempts, done.timedOut, done.value.length], [2, false, 3]);
  // Never ingested: it stops at its bound and returns what it had.
  t = 0;
  const stuck = await pollUntil({ read: async () => reads[0], done: reservesCover(ids), timeoutMs: 30_000, intervalMs: 10_000, ...clock });
  assert.deepEqual([stuck.attempts, stuck.timedOut, stuck.value.length], [4, true, 2]);
  assert.ok(t <= 30_000);
});

// The #421 review: field-level evidence. Every record (and every supporting
// entry) at its own service's deployed commit with verbatim output; a live
// field always decides; each capture's order and sequences from one occurrence.
test("hermetic output must be the test's verbatim passing jest output", () => {
  const T = "packages/policy/src/scopes.spec.ts › v3 › first; second";
  assert.equal(verbatimProblem(T, jest("scopes.spec.ts", "first", "second")), null);
  assert.match(verbatimProblem(T, "ok 2 of 2"), /doesn't show scopes.spec.ts passing/);
  assert.match(verbatimProblem(T, jest("scopes.spec.ts", "first")), /\["second"\]/);
  assert.match(verbatimProblem(T, `${jest("scopes.spec.ts", "first", "second")}\nFAIL src/other.spec.ts`), /shows a failure/);
  assert.match(verbatimProblem(T, `${jest("scopes.spec.ts", "first", "second")}\n    ✕ third`), /shows a failure/);
  assert.match(verbatimProblem("packages/policy/src/scopes.spec.ts", jest("scopes.spec.ts", "x")), /doesn't name a file and a test/);
  failsOnly("mismatches", o => { o.hermetic.mismatches.output = "ok 2 of 2"; });
  failsOnly("per-stage-contracts", o => { o.hermetic.preSlice6.output = jest("scopes.spec.ts", "another test"); });
});

const CONDITIONAL = () => ({
  fields: ["attempts", "finalSequence", "newerSequence"],
  service: "broker",
  commit: "b".repeat(40),
  test: "packages/broker/src/gcs.spec.ts › publishing › ends a 412 race",
  output: jest("gcs.spec.ts", "ends a 412 race"),
  passed: true,
  uninducible: "no approved interface pauses or reorders execution",
  supporting: [{ service: "policy", commit: "p".repeat(40), test: "packages/policy/src/scopes.spec.ts › v3 › each with its own decision", output: jest("scopes.spec.ts", "each with its own decision"), passed: true }],
  result: { attempts: [{ decisionId: "d1" }, { decisionId: "d2" }], finalSequence: 6, newerSequence: 6 },
});
test("supporting entries are checked against their own service, deployed commit, test and output", () => {
  const ok = o => { delete o.conditional; o.hermetic.conditional = { records: [CONDITIONAL()] }; };
  const o = PASSING();
  ok(o);
  assert.deepEqual(verdict(o).checks.filter(c => !c.ok), []);
  failsOnly("conditional-retry", x => { ok(x); x.hermetic.conditional.records[0].supporting[0].commit = "b".repeat(40); });
  failsOnly("conditional-retry", x => { ok(x); x.hermetic.conditional.records[0].supporting[0].output = "ok"; });
  failsOnly("conditional-retry", x => { ok(x); x.hermetic.conditional.records[0].supporting[0].passed = false; });
  failsOnly("conditional-retry", x => { ok(x); x.hermetic.conditional.records[0].supporting[0].service = "nowhere"; });
  failsOnly("conditional-retry", x => { ok(x); delete x.hermetic.conditional.records[0].result.newerSequence; });
  failsOnly("conditional-retry", x => { ok(x); x.hermetic.conditional.records[0].fields = ["attempts", "finalSequence"]; });
});

test("a live field always decides, and a hermetic record never replaces it", () => {
  // A partial live observation: its failing field decides even beside a passing record.
  failsOnly("conditional-retry", x => { x.conditional = { finalSequence: 5 }; x.hermetic.conditional = { records: [CONDITIONAL()] }; });
  const x = PASSING();
  x.conditional = { finalSequence: 5 };
  x.hermetic.conditional = { records: [CONDITIONAL()] };
  const ev = fieldEvidence(x, "conditional", ["attempts", "finalSequence", "newerSequence"]);
  assert.deepEqual(ev.sources, { attempts: "broker@bbbbbbbb", finalSequence: "live", newerSequence: "broker@bbbbbbbb" });
  assert.equal(ev.values.finalSequence, 5);
  // A passing live field is used too, the rest from the record.
  const y = PASSING();
  y.conditional = { finalSequence: 6 };
  y.hermetic.conditional = { records: [CONDITIONAL()] };
  assert.deepEqual(verdict(y).checks.filter(c => !c.ok), []);
});

// Live per-capture evidence (each scenario's object, its own command's
// reservation and bind for the same occurrence) with the repeats from Policy
// and the out-of-order pair from Broker.
// One capture per image scenario, each naming the command and generation of
// that scenario's image observation (PASSING's image(): c:<scenario>, "1").
const capture = (scenario = "private", over = {}) => ({ scenario, commandId: `c:${scenario}`, objectCommandId: `c:${scenario}`, objectGeneration: "1", occurrenceId: "snap:1", boundOccurrenceId: "snap:1", item: "item-1", reservations: 1, reservedAt: "2026-11-18T21:00:00.000Z", stagedAt: "2026-11-18T21:00:05.000Z", boundAt: "2026-11-18T21:00:06.000Z", reservedSequence: 4, publishedSequence: 4, ...over });
const SCENARIO_NAMES = ["private", "composition", "mixed", "public"];
const RSB = () => ({
  records: [
    { fields: ["repeatReserveSame", "repeatStageSame"], service: "policy", commit: "p".repeat(40), test: "packages/policy/src/captures.spec.ts › reserve, stage and bind › run in order, each once", output: jest("captures.spec.ts", "run in order, each once"), passed: true, uninducible: "a repeat needs a crash or takeover", result: { repeatReserveSame: true, repeatStageSame: true } },
    { fields: ["outOfOrderNewer", "outOfOrderFinal"], service: "broker", commit: "b".repeat(40), test: "packages/broker/src/gcs.spec.ts › publishing › completes an older capture", output: jest("gcs.spec.ts", "completes an older capture"), passed: true, uninducible: "no approved interface reorders execution", result: { outOfOrderNewer: 6, outOfOrderFinal: 6 } },
  ],
});
test("reserve/stage/bind: live captures correlated to one occurrence, the rest per field", () => {
  const live = o => { o.reserveStageBind = { captures: SCENARIO_NAMES.map(n => capture(n)) }; o.hermetic.reserveStageBind = RSB(); };
  const o = PASSING();
  live(o);
  assert.deepEqual(verdict(o).checks.filter(c => !c.ok), []);
  assert.equal(rsbCaptureProblem(capture()), null);
  failsOnly("reserve-stage-bind", x => { live(x); x.reserveStageBind.captures[1].objectCommandId = "c:private"; });
  failsOnly("reserve-stage-bind", x => { live(x); x.reserveStageBind.captures[0].boundOccurrenceId = "snap:2"; });
  failsOnly("reserve-stage-bind", x => { live(x); x.reserveStageBind.captures[0].reservations = 2; });
  failsOnly("reserve-stage-bind", x => { live(x); x.reserveStageBind.captures[0].stagedAt = "2026-11-18T21:00:07.000Z"; });
  failsOnly("reserve-stage-bind", x => { live(x); delete x.reserveStageBind.captures[0].boundAt; });
  failsOnly("reserve-stage-bind", x => { live(x); x.reserveStageBind.captures[1].publishedSequence = 5; });
  failsOnly("reserve-stage-bind", x => { live(x); x.reserveStageBind.captures = []; });
  failsOnly("reserve-stage-bind", x => { live(x); x.hermetic.reserveStageBind.records[1].commit = "p".repeat(40); });
  failsOnly("reserve-stage-bind", x => { live(x); x.hermetic.reserveStageBind.records[0].uninducible = ""; });
  failsOnly("reserve-stage-bind", x => { live(x); x.hermetic.reserveStageBind.records.pop(); });
  // A live out-of-order observation decides over the Broker record.
  failsOnly("reserve-stage-bind", x => { live(x); x.reserveStageBind.outOfOrderFinal = 5; x.reserveStageBind.outOfOrderNewer = 6; });
});

// The second #421 review: every scenario must be covered, each correlated
// with its own image observation; a present live field decides even as null.
test("reserve/stage/bind needs every image scenario, correlated with its image", () => {
  const live = (o, names = SCENARIO_NAMES) => { o.reserveStageBind = { captures: names.map(n => capture(n)) }; o.hermetic.reserveStageBind = RSB(); };
  // The reviewer's false pass: only the private capture.
  failsOnly("reserve-stage-bind", x => live(x, ["private"]));
  for (const missing of SCENARIO_NAMES) failsOnly("reserve-stage-bind", x => live(x, SCENARIO_NAMES.filter(n => n !== missing)));
  failsOnly("reserve-stage-bind", x => live(x, [...SCENARIO_NAMES, "private"]));
  failsOnly("reserve-stage-bind", x => live(x, [...SCENARIO_NAMES, "extra"]));
  failsOnly("reserve-stage-bind", x => { live(x); x.reserveStageBind.captures[2].objectGeneration = "2"; });
  failsOnly("reserve-stage-bind", x => { live(x); delete x.reserveStageBind.captures[3].objectGeneration; });
  failsOnly("reserve-stage-bind", x => { live(x); x.reserveStageBind.captures[3] = capture("public", { commandId: "c:other", objectCommandId: "c:other" }); });
  const o = PASSING();
  live(o);
  assert.match(verdict(o).checks.find(c => c.id === "reserve-stage-bind").detail, /^ok$/);
  live(o, ["private"]);
  assert.match(verdict(o).checks.find(c => c.id === "reserve-stage-bind").detail, /composition: 0 reserve\/stage\/bind observation/);
});

test("a live field present as null decides; the fallback never fills it", () => {
  // The reviewer's false pass: finalSequence: null beside a passing record.
  failsOnly("conditional-retry", x => { x.conditional = { finalSequence: null }; x.hermetic.conditional = { records: [CONDITIONAL()] }; });
  failsOnly("conditional-retry", x => { x.conditional = { finalSequence: undefined }; x.hermetic.conditional = { records: [CONDITIONAL()] }; });
  failsOnly("private-non-owner", x => { x.narrowed = { reason: null }; x.hermetic.narrowed = { ...CONDITIONAL(), fields: undefined, service: "policy", commit: "p".repeat(40), test: "packages/policy/src/scopes.spec.ts › v3 › narrowed", output: jest("scopes.spec.ts", "narrowed"), result: { reason: "not-owner" } }; });
  const x = PASSING();
  x.conditional = { finalSequence: null };
  x.hermetic.conditional = { records: [CONDITIONAL()] };
  const ev = fieldEvidence(x, "conditional", ["attempts", "finalSequence", "newerSequence"]);
  assert.deepEqual(ev.problems, ["conditional.finalSequence: observed live as null"]);
  assert.equal(ev.sources.finalSequence, undefined);
});
