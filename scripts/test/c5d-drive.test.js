// C5d's drive, offline: every phase's judgment (scripts/lib/c5d-drive-checks.js)
// passing and each check failing on its own, missing observations failing,
// the runner's refusals of production names, and manifests never overwritten
// (scripts/c5d-drive.js, run with no cloud: plan and judge only).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DRIVE, FIXTURES, BROKER_RUN, PUBLIC_CAPTURE_LIMIT, DIRECT_REFUSAL, PHASES, DRIVE_PHASES,
  commandIdFor, driveTargets, driveNamesProblem, runAppService, judgePhase, verdict, thumbnailUrl,
  stagedObject, operationIdOf, revisionService, latestByPhase, phaseFile, stampOf, captureProblem,
} from "../lib/c5d-drive-checks.js";
import { writeManifestOnce } from "../lib/c5b-thumbnails.js";

const UID = "995cc0bc98105563168b7fbee7b1e59a4256331c";
const RUN = "t3st0001";
const T = driveTargets({ uid: UID, runId: RUN });
const SHA = n => String(n).repeat(64).slice(0, 64);
const url = (service, tag = null) => `https://${tag ? `${tag}---` : ""}${service}-sja7fatcta-uc.a.run.app`;
const clone = v => structuredClone(v);
const at = s => `2026-11-20T00:00:${String(s).padStart(2, "0")}Z`;

// A completed capture published exactly as reserved.
const capture = ({ commandId, item = FIXTURES.private, seq = 5, sha = SHA("a"), publicCapture = false, generation = 1, stagedGeneration = 1, ownerGeneration = 1, invocationId = "inv-1", stage = "s0" } = {}) => ({
  commandId,
  status: "completed",
  ownerGeneration,
  invocationId,
  result: { item, captureSequence: seq, sha256: sha, url: thumbnailUrl({ bucket: DRIVE.bucket, item, sha256: sha }) },
  reservations: [{ stage, occurrenceId: "o1", item, captureSequence: seq, publicCapture, state: "staged", generation, sha256: sha, stagedGeneration, stagedAt: at(1) }],
  object: { generation: "1700000000000001", metadata: { captureSequence: String(seq), commandId, sha256: sha } },
});
const faultLines = (kind, commandId, extra = []) => [{ at: at(1), text: `WARN capture fault ${kind} command ${commandId}` }, ...extra.map((t, i) => ({ at: at(2 + i), text: `WARN capture fault ${kind} command ${commandId}: ${t}` }))];
const listingOf = () => [{ name: "abc.png", generation: "1600000000000001" }, { name: "def.png", generation: "1600000000000002" }];

// A passing observation for every phase.
const passing = () => {
  const ids = T.ids;
  const dropCapture = capture({ commandId: ids["drop-outcome"], seq: 9, sha: SHA("d") });
  const dropR = dropCapture.reservations[0];
  const dropOp = operationIdOf(dropCapture.invocationId, dropR);
  const stale = capture({ commandId: ids["stale-worker"], stagedGeneration: 2, ownerGeneration: 2, seq: 10 });
  return {
    checks: {
      services: {
        broker: { env: { THUMBNAIL_BUCKET: DRIVE.bucket, COMMAND_STAGING_BUCKET: "graffiticode-command-staging" } },
        l0013r: { env: { BROKER_URL: url(DRIVE.broker), L0013_CAPTURE_FAULTS: JSON.stringify(T.faults.L0013_CAPTURE_FAULTS) } },
        l0176r: { env: { BROKER_URL: url(DRIVE.broker) } },
        api: {
          env: {
            COMMANDS_L0013: "on",
            COMMANDS_L0176: "on",
            COMMAND_SCOPES: "on",
            INTERPRETER_L0013: "on",
            COMPILE_GENERATION_L0013: "c5d-drive-1",
            BASE_URL_L0013: url(DRIVE.l0013r),
            BASE_URL_L0176: url(DRIVE.l0176r),
            API_COMMAND_FAULT_TARGETS: JSON.stringify(T.faults.API_COMMAND_FAULT_TARGETS),
            SWEEP_AUDIENCE: "aud",
            SWEEP_CALLERS: "command-sweeper",
          },
        },
      },
      l0013rStatus: { thumbnailBucket: null },
      bucket: {
        settings: { uniform: true, publicAccessPrevention: "enforced" },
        bindings: [
          { role: "roles/storage.legacyBucketOwner", members: ["projectOwner:graffiticode"] },
          { role: "roles/storage.objectUser", members: [BROKER_RUN] },
        ],
      },
      targets: T.faults,
    },
    baseline: { thumbnails: listingOf() },
    "first-capture": {
      private: capture({ commandId: ids["first-private"] }),
      public: capture({ commandId: "c:" + "e".repeat(64), item: FIXTURES.public, publicCapture: true, seq: 2 }),
      publicSubject: "anonymous",
    },
    "direct-refused": { status: 200, messages: [`${DIRECT_REFUSAL}. Set it to the bucket`], before: { absent: true }, after: { absent: true } },
    "exit-after-reserve": {
      capture: capture({ commandId: ids["exit-after-reserve"], ownerGeneration: 2, seq: 6 }),
      faultLines: faultLines("exit-after-reserve", ids["exit-after-reserve"]),
      counterBefore: { nextCaptureSequence: 6 },
      counterAfter: { nextCaptureSequence: 7 },
    },
    "exit-after-stage": {
      capture: capture({ commandId: ids["exit-after-stage"], ownerGeneration: 2, seq: 7 }),
      faultLines: faultLines("exit-after-stage", ids["exit-after-stage"]),
      renders: 1,
      stagedAtExit: capture({ commandId: ids["exit-after-stage"], seq: 7 }).reservations[0],
    },
    "drop-outcome": {
      uid: UID,
      brokerFaults: { BROKER_FAULTS: "drop-outcome", BROKER_FAULT_PRINCIPALS: UID },
      capture: dropCapture,
      operationId: dropOp,
      claim: { evidence: { format: "gcs-thumbnail-1", bucket: DRIVE.bucket, object: `${dropR.item}.png`, item: dropR.item, captureSequence: 9, sha256: SHA("d"), commandId: dropCapture.commandId, staged: stagedObject(dropCapture.commandId, dropR) } },
      outcomeAfterDrop: { absent: true },
      objectAfterDrop: { generation: "1700000000000009", metadata: {} },
      droppedFinishedAt: at(10),
      stagedAfterDelete: { absent: true },
      stagedDeletedAt: at(20),
      retry: { commandId: dropCapture.commandId, outcome: "completed" },
      reconcile: { status: 200, operations: [{ operationId: dropOp, verdict: "applied", final: true, result: { item: dropR.item, captureSequence: 9, sha256: SHA("d"), url: thumbnailUrl({ bucket: DRIVE.bucket, item: dropR.item, sha256: SHA("d") }) } }] },
      objectAfterRetry: { generation: "1700000000000009", metadata: {} },
      executeSteps: [{ event: "execute-step", opid: dropOp, step: "publish" }],
    },
    "stale-worker": {
      capture: stale,
      policyAudit: [
        { at: at(5), event: "command-lease", outcome: "allowed", reason: "takeover", commandId: stale.commandId },
        { at: at(9), event: "command-reserve", outcome: "denied", reason: "stale-generation", commandId: stale.commandId },
        { at: at(10), event: "command-stage", outcome: "denied", reason: "stale-generation", commandId: stale.commandId },
      ],
      l0013Lines: faultLines("stall-before-stage", stale.commandId, ["stalling until the takeover", "takeover observed"]),
      apiLines: [
        { at: at(1), text: `WARN command ${stale.commandId}: fault stop-renewal at generation 1` },
        { at: at(11), text: `WARN command ${stale.commandId}: stopped, stale-generation` },
      ],
    },
    "staging-gone": {
      capture: { ...capture({ commandId: ids["staging-gone"] }), status: "failed", result: null },
      faultLines: faultLines("exit-after-stage", ids["staging-gone"]),
      stagedAtExit: capture({ commandId: ids["staging-gone"] }).reservations[0],
      stagedAfterDelete: { absent: true },
      claim: { absent: true },
      objectBefore: { generation: "1700000000000003", metadata: {} },
      objectAfter: { generation: "1700000000000003", metadata: {} },
      renders: 1,
      fresh: capture({ commandId: ids["staging-gone-fresh"], seq: 12 }),
    },
    "older-after-newer": {
      older: capture({ commandId: ids.older, seq: 13, ownerGeneration: 2 }),
      newer: capture({ commandId: ids.newer, seq: 14 }),
      olderFaultLines: faultLines("exit-after-stage", ids.older),
      olderSteps: [{ step: "publish", observed: "newer-present" }],
      finalObject: { generation: "1700000000000014", metadata: { commandId: ids.newer, captureSequence: "14" } },
    },
    "two-stage": (() => {
      const two = (commandId, items) => ({ ...capture({ commandId }), reservations: items.map((item, i) => ({ ...capture({ commandId, item }).reservations[0], stage: `s${i}`, occurrenceId: `o${i}` })) });
      return { distinctItems: two(T.ids["two-stage"], [FIXTURES.private, FIXTURES.public]), sameProgram: two("c:" + "f".repeat(64), [FIXTURES.private, FIXTURES.private]) };
    })(),
    mixed: { capture: capture({ commandId: T.ids.mixed, seq: 15 }), invocations: 1, tokens: [{ fn: "snap", scopeKinds: ["item"] }, { fn: "save-to-itembank", scopeKinds: ["connection"] }] },
    "non-owner": { status: 200, outcome: "failed", reason: "not-owner", reservations: [] },
    "rate-limit": { allowed: PUBLIC_CAPTURE_LIMIT, refused: 1, refusedAfterQuota: true, retired: { statuses: { "c:1": "completed", "c:2": "failed" } } },
    "canary-snap": { exitCode: 0, results: ["snap command", "snap url", "snap sequence", "snap command id", "snap retry"].map(name => ({ name, ok: true })) },
    boundary: {
      invocations: ["inv-1", "inv-2"],
      brokerAudit: [
        { service: DRIVE.broker, event: "execute", invocationId: "inv-1" },
        { service: DRIVE.broker, event: "execute-step", invocationId: "inv-2" },
        { service: "broker", event: "receipts", invocationId: "inv-1" },
        { service: "broker", event: "reconcile", invocationId: "inv-2", opid: "inv-2/s0/o1" },
      ],
      reconcileBuckets: [{ opid: "inv-2/s0/o1", bucket: DRIVE.bucket }],
      thumbnailsBefore: listingOf(),
      thumbnailsAfter: listingOf(),
      fixtures: Object.values(FIXTURES),
      compilerCalls: [{ service: DRIVE.l0013r }, { service: DRIVE.l0176r }],
    },
    cleanup: { commands: [{ commandId: "c:1", status: "completed" }, { commandId: "c:2", status: "failed" }], due: [] },
  };
};

const failsOnly = (phase, obs, id) => {
  const r = judgePhase(phase, obs);
  assert.equal(r.passed, false, `${phase} passed`);
  const failed = r.checks.filter(c => !c.ok).map(c => c.id);
  assert.deepEqual(failed, [id], `${phase}: failed ${JSON.stringify(r.checks.filter(c => !c.ok))}`);
  return r.checks.find(c => c.id === id).detail;
};

// ----------------------------------------------------------- targets, names

test("the run's targets: Policy's command ids, five compiler faults and one api fault, the newer never targeted", () => {
  assert.equal(T.ids.older, commandIdFor(UID, `c5d-drive:${RUN}:older`));
  assert.match(T.ids.older, /^c:[0-9a-f]{64}$/);
  assert.deepEqual(Object.values(T.faults.L0013_CAPTURE_FAULTS).sort(), ["exit-after-reserve", "exit-after-stage", "exit-after-stage", "exit-after-stage", "stall-before-stage"]);
  assert.equal(T.faults.L0013_CAPTURE_FAULTS[T.ids.newer], undefined);
  assert.deepEqual(T.faults.API_COMMAND_FAULT_TARGETS, { [T.ids["stale-worker"]]: "stop-renewal" });
  assert.deepEqual(driveTargets({ uid: UID, runId: RUN }), T, "deterministic");
  assert.throws(() => driveTargets({ uid: UID, runId: "BAD RUN" }));
});

test("the drive's names only: production, B6's and the production buckets are refused", () => {
  const ok = { ...DRIVE };
  assert.equal(driveNamesProblem(ok), null);
  for (const [k, v] of [["api", "api"], ["broker", "broker"], ["l0013r", "l0013r"], ["l0176r", "l0176r"], ["l0176r", "l0176r-drive"], ["broker", "broker-faults"], ["api", "policy"]]) {
    assert.match(driveNamesProblem({ ...ok, [k]: v }), /never runs against/, `${k}=${v}`);
  }
  for (const b of ["graffiticode-thumbnails", "graffiticode.appspot.com", "graffiticode-command-staging"]) assert.match(driveNamesProblem({ ...ok, bucket: b }), /never publishes/);
  assert.match(driveNamesProblem({ ...ok, api: "api-other" }), /not the drive's/);
  assert.match(driveNamesProblem({ ...ok, apiUrl: url("api", "rel") }), /never calls a production service/);
  assert.equal(driveNamesProblem({ ...ok, apiUrl: url("api-c5d-drive", "rel") }), null);
});

test("whole service names from Cloud Run URLs and revisions", () => {
  assert.equal(runAppService(url("l0176r-c5d-drive")), "l0176r-c5d-drive");
  assert.equal(runAppService(url("l0176r-c5d-drive", "c5d-1")), "l0176r-c5d-drive");
  assert.equal(runAppService("https://l0013r-c5d-drive-123456.us-central1.run.app"), "l0013r-c5d-drive");
  assert.equal(runAppService("https://l0176.graffiticode.org"), null);
  assert.equal(revisionService("l0013r-c5d-drive-rmwjzlgz6-2882e6"), "l0013r-c5d-drive");
  assert.equal(stagedObject("c:x", { stage: "s0", occurrenceId: "o1" }), "gs://graffiticode-command-staging/c:x/s0/o1.png");
});

// ---------------------------------------------------------------- the phases

test("every phase passes on its passing observations, and the drive passes only with all of them", () => {
  const all = passing();
  for (const p of DRIVE_PHASES) {
    const r = judgePhase(p, all[p]);
    assert.equal(r.passed, true, `${p}: ${JSON.stringify(r.checks.filter(c => !c.ok))}`);
  }
  assert.equal(verdict(all).passed, true);
  const { boundary, ...missing } = all;
  const v = verdict(missing);
  assert.equal(v.passed, false);
  assert.equal(v.phases.find(p => p.phase === "boundary").checks[0].detail, "not run");
});

test("a failed read fails its phase, whatever else passed", () => {
  assert.match(failsOnly("baseline", { ...passing().baseline, errors: { thumbnails: "403" } }, "observations-read"), /thumbnails \(403\)/);
});

// One mutation per check: each fails that check alone.
const MUTATIONS = {
  checks: {
    "broker-env": o => { o.services.broker.env.BROKER_FAULTS = "drop-outcome"; },
    "l0013r-env": o => { o.services.l0013r.env.THUMBNAIL_BUCKET = "graffiticode.appspot.com"; },
    "l0176r-env": o => { o.services.l0176r.env.BROKER_URL = url("broker"); },
    "api-env": o => { o.services.api.env.API_COMMAND_FAULT_TARGETS = JSON.stringify({ "c:other": "stop-renewal" }); },
    bucket: o => { o.bucket.bindings.push({ role: "roles/storage.objectViewer", members: ["allUsers"] }); },
  },
  baseline: { "thumbnails-listed": o => { o.thumbnails = []; } },
  "first-capture": {
    private: o => { o.private.object.metadata.captureSequence = "4"; },
    "public-anonymous": o => { o.publicSubject = UID; },
  },
  "direct-refused": {
    refused: o => { o.messages = ["something else"]; },
    "nothing-uploaded": o => { o.after = { generation: "1700000000000099", metadata: {} }; },
  },
  "exit-after-reserve": {
    "fault-fired": o => { o.faultLines = []; },
    "taken-over": o => { o.capture.ownerGeneration = 1; },
    "same-reservation": o => { o.counterAfter = { nextCaptureSequence: 8 }; },
  },
  "exit-after-stage": {
    "fault-fired": o => { o.faultLines = faultLines("exit-after-reserve", o.capture.commandId); },
    "staged-reused": o => { o.renders = 2; },
  },
  "drop-outcome": {
    "fault-scoped": o => { o.brokerFaults.BROKER_FAULT_PRINCIPALS = "someone-else"; },
    dropped: o => { o.outcomeAfterDrop = { outcome: "succeeded" }; },
    "staging-deleted": o => { o.stagedDeletedAt = at(5); },
    replayed: o => { o.executeSteps.push({ event: "execute-step", opid: o.operationId, step: "publish" }); },
    reconciled: o => { o.reconcile.operations[0].result.captureSequence = 10; },
  },
  "stale-worker": {
    "faults-fired": o => { o.apiLines = o.apiLines.filter(l => !l.text.includes("stop-renewal")); },
    "takeover-first": o => { o.policyAudit[0].at = at(30); },
    "stage-refused": o => { o.policyAudit = o.policyAudit.filter(e => e.event !== "command-stage"); },
    "generation-2-published": o => { o.capture.reservations[0].stagedGeneration = 1; },
    "old-worker-finished-nothing": o => { o.apiLines = o.apiLines.filter(l => !l.text.includes("stopped")); },
  },
  "staging-gone": {
    "fault-fired": o => { o.stagedAtExit.stagedGeneration = 2; },
    "deleted-before-claim": o => { o.claim = { evidence: {} }; },
    "failed-nothing-published": o => { o.capture.status = "completed"; },
    "fresh-capture": o => { o.fresh.commandId = o.capture.commandId; },
  },
  "older-after-newer": {
    "older-stopped": o => { o.olderFaultLines = []; },
    "newer-published": o => { o.newer.status = "failed"; },
    "older-newer-present": o => { o.olderSteps = [{ step: "publish", observed: "published" }]; },
  },
  "two-stage": { "one-invocation": o => { o.sameProgram.reservations[1].stage = "s0"; } },
  mixed: { "one-invocation-own-scopes": o => { o.tokens[0].scopeKinds = ["item", "connection"]; } },
  "non-owner": { refused: o => { o.reservations = [{}]; } },
  "rate-limit": {
    quota: o => { o.refusedAfterQuota = false; },
    retired: o => { o.retired.statuses["c:2"] = "pending"; },
  },
  "canary-snap": { passed: o => { o.results[4].ok = false; } },
  boundary: {
    // (An execute by production broker fails this and the bookkeeping check both.)
    "drive-broker-executes": o => { o.brokerAudit.push({ service: "broker-faults", event: "execute", invocationId: "inv-1" }); },
    "production-broker-bookkeeping": o => { o.reconcileBuckets[0].bucket = "graffiticode-thumbnails"; },
    "thumbnails-unchanged": o => { o.thumbnailsAfter[0].generation = "1600000000000099"; },
    "drive-compilers": o => { o.compilerCalls.push({ service: "l0013r" }); },
  },
  cleanup: { terminal: o => { o.due = ["c:1"]; } },
};

test("every check fails on its own", () => {
  for (const [phase, checks] of Object.entries(MUTATIONS)) {
    const ids = PHASES[phase].map(([id]) => id);
    assert.deepEqual(Object.keys(checks).sort(), [...ids].sort(), `${phase}: a mutation for every check`);
    for (const [id, mutate] of Object.entries(checks)) {
      const o = clone(passing()[phase]);
      mutate(o);
      failsOnly(phase, o, id);
    }
  }
});

test("a missing observation fails, never reads as unchanged (the #441 lesson)", () => {
  // Counters absent on both sides.
  const ear = clone(passing()["exit-after-reserve"]);
  delete ear.counterBefore;
  delete ear.counterAfter;
  assert.match(failsOnly("exit-after-reserve", ear, "same-reservation"), /counter isn't readable/);
  // Generations missing on both sides of the retry.
  const drop = clone(passing()["drop-outcome"]);
  delete drop.objectAfterDrop.generation;
  delete drop.objectAfterRetry.generation;
  const r = judgePhase("drop-outcome", drop);
  assert.equal(r.passed, false);
  assert.ok(r.checks.find(c => c.id === "replayed").detail.includes("generation isn't readable"));
  // An object read neither as present nor as absent.
  const direct = clone(passing()["direct-refused"]);
  direct.before = null;
  direct.after = null;
  assert.match(failsOnly("direct-refused", direct, "nothing-uploaded"), /not observed/);
  // Listings absent on both sides.
  const b = clone(passing().boundary);
  delete b.thumbnailsBefore;
  delete b.thumbnailsAfter;
  assert.match(failsOnly("boundary", b, "thumbnails-unchanged"), /not observed/);
  // A render count that wasn't read.
  const eas = clone(passing()["exit-after-stage"]);
  delete eas.renders;
  assert.match(failsOnly("exit-after-stage", eas, "staged-reused"), /render count isn't readable/);
  // /status without the field.
  const checks = clone(passing().checks);
  checks.l0013rStatus = {};
  assert.match(failsOnly("checks", checks, "l0013r-env"), /thumbnailBucket not observed, expected null/);
  // A stall that hit its bound never passes as a takeover.
  const sw = clone(passing()["stale-worker"]);
  sw.l0013Lines.push({ at: at(20), text: `WARN capture fault stall-before-stage command ${sw.capture.commandId}: probe unanswered at the bound` });
  assert.match(failsOnly("stale-worker", sw, "takeover-first"), /bound/);
  // The drive's bucket missing from a capture.
  assert.match(captureProblem("x", { ...passing()["first-capture"].private, object: undefined }), /nothing readable published/);
});

test("the dropped operation's result is compared field for field, with no extra fields", () => {
  const o = clone(passing()["drop-outcome"]);
  o.reconcile.operations[0].result.extra = 1;
  assert.match(failsOnly("drop-outcome", o, "reconciled"), /extra fields/);
  const p = clone(passing()["drop-outcome"]);
  p.claim.evidence.bucket = "graffiticode-thumbnails";
  const r = judgePhase("drop-outcome", p);
  assert.ok(!r.checks.find(c => c.id === "dropped").ok);
  assert.ok(!r.checks.find(c => c.id === "reconciled").ok, "the expected url is the evidence bucket's, which a wrong bucket changes");
});

// ------------------------------------------------------------------ manifests

test("manifests: named by phase and stamp, the latest per phase, and never overwritten", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "c5d-drive-"));
  const f = phaseFile("boundary", stampOf(new Date("2026-11-20T01:02:03.004Z")));
  assert.equal(f, "boundary-2026-11-20T01-02-03-004Z.json");
  assert.throws(() => phaseFile("no-such-phase", "2026-11-20T01-02-03-004Z"));
  writeManifestOnce(path.join(dir, f), { a: 1 });
  assert.throws(() => writeManifestOnce(path.join(dir, f), { a: 2 }), /never overwritten/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, f), "utf8")), { a: 1 });
  assert.deepEqual(latestByPhase(["drop-outcome-2026-11-20T01-00-00-000Z.json", "drop-outcome-retry-2026-11-20T02-00-00-000Z.json", "drop-outcome-2026-11-20T03-00-00-000Z.json", "plan.json"]), {
    "drop-outcome": "drop-outcome-2026-11-20T03-00-00-000Z.json",
    "drop-outcome-retry": "drop-outcome-retry-2026-11-20T02-00-00-000Z.json",
  });
});

// --------------------------------------------------------- the CLI, offline

const CLI = new URL("../c5d-drive.js", import.meta.url).pathname;
const cli = argv => spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } });

test("the CLI refuses production and B6 names before anything else", () => {
  for (const argv of [["--api", "api"], ["--broker", "broker"], ["--l0013r", "l0013r"], ["--l0176r", "l0176r-drive"], ["--broker", "broker-faults"], ["--bucket", "graffiticode-thumbnails"], ["--bucket", "graffiticode.appspot.com"], ["--api-url", url("api")]]) {
    const r = cli(["--phase", "checks", "--run", RUN, ...argv]);
    assert.equal(r.status, 2, argv.join(" "));
    assert.match(r.stderr, /^refused: /);
  }
});

test("the CLI's plan is offline, written once, and the run's phases need it", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "c5d-drive-cli-"));
  const r = cli(["--phase", "plan", "--run", RUN, "--uid", UID, "--dir", parent]);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(readFileSync(path.join(parent, RUN, "plan.json"), "utf8"));
  assert.deepEqual(plan.faults, T.faults);
  assert.ok(r.stdout.includes(`L0013_CAPTURE_FAULTS='${JSON.stringify(T.faults.L0013_CAPTURE_FAULTS)}'`));
  const again = cli(["--phase", "plan", "--run", RUN, "--uid", UID, "--dir", parent]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /never overwritten/);
  // Another uid would target other commands than the services were set with.
  const other = cli(["--phase", "checks", "--run", RUN, "--uid", "someone-else", "--dir", parent]);
  assert.equal(other.status, 2);
  assert.match(other.stderr, /differ from plan.json/);
  assert.equal(cli(["--phase", "checks", "--run", "zzzz9999", "--dir", parent]).status, 2, "no plan, no phase");
});

test("the CLI's judge reads each phase's latest manifest, joins the operator pauses, and writes a new report each time", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "c5d-drive-judge-"));
  assert.equal(cli(["--phase", "plan", "--run", RUN, "--uid", UID, "--dir", parent]).status, 0);
  const dir = path.join(parent, RUN);
  const all = passing();
  const stamp = s => `2026-11-20T00-00-${String(s).padStart(2, "0")}-000Z`;
  DRIVE_PHASES.forEach((p, i) => {
    let obs = all[p];
    // The drop phase's own manifest, and its retry's (the operator pause).
    if (p === "drop-outcome") {
      const { stagedAfterDelete, stagedDeletedAt, retry, reconcile, objectAfterRetry, executeSteps, ...first } = obs;
      writeFileSync(path.join(dir, `drop-outcome-retry-${stamp(59)}.json`), JSON.stringify({ observations: { stagedAfterDelete, stagedDeletedAt, retry, reconcile, objectAfterRetry, executeSteps } }));
      obs = first;
    }
    writeFileSync(path.join(dir, `${p}-${stamp(i)}.json`), JSON.stringify({ observations: obs }));
  });
  // An earlier failed run of a phase is superseded by its later one.
  writeFileSync(path.join(dir, "cleanup-2026-11-19T00-00-00-000Z.json"), JSON.stringify({ observations: { commands: [], due: [] } }));
  const r = cli(["--phase", "judge", "--run", RUN, "--uid", UID, "--dir", parent]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /DRIVE PASSED/);
  // A failing latest manifest fails the drive.
  writeFileSync(path.join(dir, "cleanup-2026-11-21T00-00-00-000Z.json"), JSON.stringify({ observations: { ...all.cleanup, due: ["c:1"] } }));
  const failed = cli(["--phase", "judge", "--run", RUN, "--uid", UID, "--dir", parent]);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAILED cleanup\/terminal/);
  assert.equal(readdirSync(dir).filter(f => f.startsWith("report-")).length, 2, "each judgment its own report");
});
