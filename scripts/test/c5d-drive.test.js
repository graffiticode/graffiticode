// C5d's drive, offline: every phase's judgment (scripts/lib/c5d-drive-checks.js)
// passing and each check failing on its own, missing observations failing,
// the runner's refusals of production names and URLs, the run's one baseline,
// its command inventory, and manifests never overwritten (scripts/c5d-drive.js,
// run with no cloud: plan, baseline refusals and judge only).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as C from "../lib/c5d-drive-checks.js";
import { writeManifestOnce } from "../lib/c5b-thumbnails.js";
import { verifyRetired } from "../lib/c5a-gate-fixtures.js";

const { DRIVE, FIXTURES, BROKER_RUN, PUBLIC_CAPTURE_LIMIT, DIRECT_REFUSAL, PHASES, DRIVE_PHASES, commandIdFor, driveTargets, driveNamesProblem, runAppService, judgePhase, verdict, thumbnailUrl, stagedObject, operationIdOf, revisionService, latestByPhase, phaseFile, stampOf, captureProblem } = C;

const UID = "995cc0bc98105563168b7fbee7b1e59a4256331c";
const RUN = "t3st0001";
const T = driveTargets({ uid: UID, runId: RUN });
const SHA = n => String(n).repeat(64).slice(0, 64);
const url = (service, tag = null) => `https://${tag ? `${tag}---` : ""}${service}-sja7fatcta-uc.a.run.app`;
const clone = v => structuredClone(v);
const at = s => `2026-11-20T00:00:${String(s).padStart(2, "0")}Z`;

// A completed capture published exactly as reserved, in the shapes the
// services write: L0013's result is exactly { item, url } (snapshot_value),
// the url Broker's thumbnailUrl; Broker's claim evidence is gcs.ts
// thumbnailEvidence.
const capture = ({ commandId, item = FIXTURES.private, seq = 5, sha = SHA("a"), publicCapture = false, generation = 1, stagedGeneration = 1, ownerGeneration = 1, invocationId = "inv-1", stage = "s0" } = {}) => ({
  commandId,
  status: "completed",
  ownerGeneration,
  invocationId,
  result: { url: thumbnailUrl({ bucket: DRIVE.bucket, item, sha256: sha }), item },
  reservations: [{ stage, occurrenceId: "o1", item, captureSequence: seq, publicCapture, state: "staged", generation, sha256: sha, stagedGeneration, stagedAt: at(1) }],
  claim: {
    operationId: `${invocationId}/${stage}/o1`,
    claimedAt: at(2),
    evidence: { format: "gcs-thumbnail-1", bucket: DRIVE.bucket, object: `${item}.png`, item, captureSequence: seq, sha256: sha, commandId, staged: `${commandId}/${stage}/o1.png` },
  },
  object: { generation: "1700000000000001", metadata: { captureSequence: String(seq), commandId, sha256: sha, item } },
});
const faultLines = (kind, commandId, extra = []) => [{ at: at(1), text: `WARN capture fault ${kind} command ${commandId}` }, ...extra.map((t, i) => ({ at: at(2 + i), text: `WARN capture fault ${kind} command ${commandId}: ${t}` }))];
const listingOf = () => [{ name: "abc.png", generation: "1600000000000001" }, { name: "def.png", generation: "1600000000000002" }];
// The public drive compilers' answers, as lib.rs and gateway.rs give them.
const refusedPreflight = (status, reason) => ({ status, body: { status: "error", error: { code: status, message: "preflight is for the gateway only", reason }, data: null } });
const refusedStart = () => ({ status: 200, body: { data: null, errors: [{ message: "This command's session isn't valid for this compiler.", from: -1, to: -1, code: "bad-session" }], revision: { revision: "l0013r-c5d-drive-r1" } } });
const compilerProbes = () => ({
  "gateway-control": { status: 200, body: { status: "success", data: { manifest: { stage: "s0", requiredFunctions: ["snap"] } } } },
  "no-identity": refusedPreflight(401, "caller-rejected"),
  "malformed-identity": refusedPreflight(401, "caller-rejected"),
  "non-gateway": refusedPreflight(403, "route-not-allowed-for-caller"),
  model: { status: 200, body: { model: { lang: "0013", kind: "plan", digest: "d", program: {}, intents: [{ id: "i1", fn: "snap" }] }, errors: [] } },
  "start-malformed-session": refusedStart(),
  "start-forged-session": refusedStart(),
});
const accessProbesPassing = () => {
  const counters = { [FIXTURES.private]: { nextCaptureSequence: 7 }, [FIXTURES.public]: { absent: true } };
  return {
    compilers: { l0013r: compilerProbes(), l0176r: compilerProbes() },
    bucketBefore: [],
    bucketAfter: [],
    policyBefore: { commandIds: ["c:1"], complete: true, pages: 1, itemCaptures: clone(counters) },
    policyAfter: { commandIds: ["c:1"], complete: true, pages: 1, itemCaptures: clone(counters) },
  };
};

// A passing observation for every phase.
const passing = () => {
  const ids = T.ids;
  const dropCapture = { ...capture({ commandId: ids["drop-outcome"], seq: 9, sha: SHA("d") }), status: "uncertain", result: null };
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
            SWEEP_AUDIENCE: url(DRIVE.api),
            SWEEP_CALLERS: "command-sweeper@graffiticode.iam.gserviceaccount.com",
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
    "access-probes": accessProbesPassing(),
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
      claim: dropCapture.claim,
      outcomeAfterDrop: { absent: true },
      objectAfterDrop: { generation: "1700000000000009", metadata: {} },
      droppedFinishedAt: at(10),
      stagedAfterDelete: { absent: true },
      stagedDeletedAt: at(20),
      retry: { commandId: dropCapture.commandId, outcome: "uncertain" },
      reconcile: { status: 200, timedOut: false, attempts: [{ verdict: "too-early" }, { verdict: "applied" }], operations: [{ operationId: dropOp, verdict: "applied", final: true, result: { item: dropR.item, captureSequence: 9, sha256: SHA("d"), url: thumbnailUrl({ bucket: DRIVE.bucket, item: dropR.item, sha256: SHA("d") }) } }] },
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
      older: { ...capture({ commandId: ids.older, seq: 13, ownerGeneration: 2 }), result: { url: thumbnailUrl({ bucket: DRIVE.bucket, item: FIXTURES.private, sha256: SHA("a") }), item: FIXTURES.private, captureSequence: 13 } },
      newer: capture({ commandId: ids.newer, seq: 14 }),
      olderFaultLines: faultLines("exit-after-stage", ids.older),
      olderSteps: [{ step: "publish", observed: "newer-present" }],
      finalObject: { generation: "1700000000000014", metadata: { commandId: ids.newer, captureSequence: "14" } },
    },
    "two-stage": (() => {
      const two = (commandId, items) => ({ ...capture({ commandId }), reservations: items.map((item, i) => ({ ...capture({ commandId, item }).reservations[0], stage: `s${i}`, occurrenceId: `o${i}` })) });
      return { distinctItems: two(T.ids["two-stage"], [FIXTURES.private, FIXTURES.public]), sameProgram: two(T.ids["two-stage-same"], [FIXTURES.private, FIXTURES.private]) };
    })(),
    mixed: { capture: capture({ commandId: T.ids.mixed, seq: 15 }), invocations: 1, tokens: [{ fn: "snap", scopeKinds: ["item"] }, { fn: "save-to-itembank", scopeKinds: ["connection"] }] },
    "non-owner": { status: 200, outcome: "failed", reason: "not-owner", reservations: [] },
    // first-capture's anonymous public capture holds one slot of the window.
    "rate-limit": { priorInWindow: 1, attempted: PUBLIC_CAPTURE_LIMIT, allowed: PUBLIC_CAPTURE_LIMIT - 1, refused: 1, refusedAfterQuota: true, retired: { statuses: { "c:1": "completed", "c:2": "failed" }, listedAfter: [] } },
    "canary-snap": {
      exitCode: 0,
      results: ["snap command", "snap url", "snap sequence", "snap command id", "snap retry"].map(name => ({ name, ok: true })),
      commandId: T.ids["canary-snap"],
      expectedCommandId: T.ids["canary-snap"],
    },
    boundary: {
      commands: [{ commandId: ids["first-private"], invocationId: "inv-1" }, { commandId: ids["drop-outcome"], invocationId: "inv-2" }, { commandId: ids.newer, absent: true }],
      claimsByInvocation: { "inv-1": ["inv-1/s0/o1"], "inv-2": ["inv-2/s0/o1"] },
      queries: [{ query: "broker-c5d-drive: inv-1", count: 2, limit: 1000 }, { query: "broker: inv-2", count: 2, limit: 1000 }],
      poll: { attempts: 22, timedOut: false, observedMs: 5 * 60_000, recollected: true },
      brokerAudit: [
        { service: DRIVE.broker, event: "execute", invocationId: "inv-1", opid: "inv-1/s0/o1" },
        { service: DRIVE.broker, event: "execute-step", invocationId: "inv-2", opid: "inv-2/s0/o1", step: "publish" },
        { service: "broker", event: "receipts", invocationId: "inv-1" },
        { service: "broker", event: "reconcile", invocationId: "inv-2", opid: "inv-2/s0/o1" },
      ],
      reconcileBuckets: [{ opid: "inv-2/s0/o1", bucket: DRIVE.bucket }],
      thumbnailsBefore: listingOf(),
      thumbnailsAfter: listingOf(),
      fixtures: Object.values(FIXTURES),
      compilerCalls: [{ service: DRIVE.l0013r }, { service: DRIVE.l0176r }],
    },
    cleanup: {
      commands: [{ commandId: "c:1", status: "completed" }, { commandId: "c:2", status: "failed" }, { commandId: "c:3", status: "uncertain" }, { commandId: "c:4", status: "partial" }, { commandId: "c:5", status: "absent" }],
      due: [],
      unresolvedIntents: [],
      policyEnumeration: {
        since: at(0),
        tasks: ["task-private", "task-public"],
        queries: [
          { query: "policy commands where taskId == task-private", pages: 1, count: 2, complete: true },
          { query: "policy commands where uid == canary", pages: 2, count: 301, complete: true },
        ],
        commands: [{ commandId: "c:1", uid: UID, taskId: "task-private", createdAt: at(1), status: "completed" }, { commandId: "c:3", uid: "anonymous", taskId: "task-public", createdAt: at(2), status: "uncertain" }],
      },
    },
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
});

// #446 review, finding 1.
test("each URL the runner sends to must be its role's own drive service, stable or tagged: custom domains and other services refused", () => {
  const ok = { ...DRIVE };
  for (const apiUrl of ["https://api.graffiticode.org", url("broker-c5d-drive"), url("api"), url("api", "rel"), url("api-c5d-driver"), "http://" + url("api-c5d-drive").slice(8), "not a url"]) {
    assert.notEqual(driveNamesProblem({ ...ok, apiUrl }), null, apiUrl);
  }
  assert.equal(driveNamesProblem({ ...ok, apiUrl: url("api-c5d-drive") }), null);
  assert.equal(driveNamesProblem({ ...ok, apiUrl: url("api-c5d-drive", "c5d-1") }), null);
  assert.equal(driveNamesProblem({ ...ok, apiUrl: "https://api-c5d-drive-123456789.us-central1.run.app" }), null);
  // Each role to its own service.
  assert.equal(C.driveUrlProblem("broker", url("broker-c5d-drive")), null);
  assert.equal(C.driveUrlProblem("l0013r", url("l0013r-c5d-drive", "t")), null);
  assert.equal(C.driveUrlProblem("l0176r", url("l0176r-c5d-drive")), null);
  assert.match(C.driveUrlProblem("l0176r", url("l0176r-drive")), /l0176r-drive's, not l0176r-c5d-drive's/);
  assert.match(C.driveUrlProblem("l0013r", url("l0013r")), /l0013r's/);
  assert.match(C.driveUrlProblem("broker", "https://broker.graffiticode.org"), /custom domain/);
  assert.match(driveNamesProblem({ ...ok, l0013rUrl: url("api-c5d-drive") }), /api-c5d-drive's, not l0013r-c5d-drive's/);
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
  "access-probes": {
    ...Object.fromEntries(["l0013r", "l0176r"].flatMap(c => [
      [`${c}-gateway-control`, o => { o.compilers[c]["gateway-control"] = { status: 401, body: { status: "error", error: { reason: "caller-rejected" }, data: null } }; }],
      [`${c}-no-identity`, o => { o.compilers[c]["no-identity"] = { status: 200, body: { status: "success", data: { manifest: {} } } }; }],
      [`${c}-malformed-identity`, o => { o.compilers[c]["malformed-identity"].body.error.reason = "route-not-allowed-for-caller"; }],
      [`${c}-non-gateway`, o => { o.compilers[c]["non-gateway"] = { status: 401, body: { status: "error", error: { reason: "caller-rejected" }, data: null } }; }],
      [`${c}-model`, o => { o.compilers[c].model.body.model.intents = []; }],
      [`${c}-start-malformed-session`, o => { o.compilers[c]["start-malformed-session"].body = { data: { url: "https://storage.googleapis.com/graffiticode-c5d-drive/x.png" }, errors: [] }; }],
      [`${c}-start-forged-session`, o => { o.compilers[c]["start-forged-session"].body.occurrences = { i1: ["o1"] }; }],
    ])),
    "drive-bucket-unchanged": o => { o.bucketAfter = [{ name: "x.png", generation: "1700000000000001" }]; },
    "policy-unchanged": o => { o.policyAfter.itemCaptures[FIXTURES.private] = { nextCaptureSequence: 8 }; },
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
  "canary-snap": {
    passed: o => { o.results[4].ok = false; },
    "command-recorded": o => { o.commandId = null; },
  },
  boundary: {
    "audit-complete": o => { o.queries[0].count = 1000; },
    // (An execute by production broker fails this and the bookkeeping check both.)
    "drive-broker-executes": o => { o.brokerAudit.push({ service: "broker-faults", event: "execute", invocationId: "inv-1" }); },
    "production-broker-bookkeeping": o => { o.reconcileBuckets[0].bucket = "graffiticode-thumbnails"; },
    "thumbnails-unchanged": o => { o.thumbnailsAfter[0].generation = "1600000000000099"; },
    "drive-compilers": o => { o.compilerCalls.push({ service: "l0013r" }); },
  },
  cleanup: {
    // (A due inventoried command fails both checks; one in the inventory but not Policy's selection fails only this.)
    terminal: o => { o.commands.push({ commandId: "c:6", status: "pending" }); },
    "policy-enumeration": o => { o.policyEnumeration.commands.push({ commandId: "c:9", uid: "anonymous", taskId: "task-public", createdAt: at(3), status: "pending" }); },
  },
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
  const ear = clone(passing()["exit-after-reserve"]);
  delete ear.counterBefore;
  delete ear.counterAfter;
  assert.match(failsOnly("exit-after-reserve", ear, "same-reservation"), /counter isn't readable/);
  const drop = clone(passing()["drop-outcome"]);
  delete drop.objectAfterDrop.generation;
  delete drop.objectAfterRetry.generation;
  const r = judgePhase("drop-outcome", drop);
  assert.equal(r.passed, false);
  assert.ok(r.checks.find(c => c.id === "replayed").detail.includes("generation isn't readable"));
  const direct = clone(passing()["direct-refused"]);
  direct.before = null;
  direct.after = null;
  assert.match(failsOnly("direct-refused", direct, "nothing-uploaded"), /not observed/);
  const b = clone(passing().boundary);
  delete b.thumbnailsBefore;
  delete b.thumbnailsAfter;
  assert.match(failsOnly("boundary", b, "thumbnails-unchanged"), /not observed/);
  const eas = clone(passing()["exit-after-stage"]);
  delete eas.renders;
  assert.match(failsOnly("exit-after-stage", eas, "staged-reused"), /render count isn't readable/);
  const checks = clone(passing().checks);
  checks.l0013rStatus = {};
  assert.match(failsOnly("checks", checks, "l0013r-env"), /thumbnailBucket not observed, expected null/);
  const sw = clone(passing()["stale-worker"]);
  sw.l0013Lines.push({ at: at(20), text: `WARN capture fault stall-before-stage command ${sw.capture.commandId}: probe unanswered at the bound` });
  assert.match(failsOnly("stale-worker", sw, "takeover-first"), /bound/);
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

// #446 review, finding 5.
test("L0013's own result, { item, url }, passes; its url and Broker's claim evidence are checked apart", () => {
  const cap = passing()["first-capture"].private;
  assert.deepEqual(Object.keys(cap.result).sort(), ["item", "url"]);
  assert.equal(captureProblem("real", cap), null);
  const extra = clone(cap);
  extra.result.captureSequence = 5;
  assert.match(captureProblem("extra", extra), /fields captureSequence,item,url/);
  const wrongUrl = clone(cap);
  wrongUrl.result.url = thumbnailUrl({ bucket: "graffiticode-thumbnails", item: cap.result.item, sha256: SHA("a") });
  assert.match(captureProblem("url", wrongUrl), /isn't https:\/\/storage.googleapis.com\/graffiticode-c5d-drive\//);
  const otherDigest = clone(cap);
  otherDigest.result.url = thumbnailUrl({ bucket: DRIVE.bucket, item: cap.result.item, sha256: SHA("b") });
  assert.match(captureProblem("digest", otherDigest), /isn't/);
  const noClaim = clone(cap);
  delete noClaim.claim;
  assert.match(captureProblem("claim", noClaim), /claim evidence not observed/);
  const claimSeq = clone(cap);
  claimSeq.claim.evidence.captureSequence = 6;
  assert.match(captureProblem("claim", claimSeq), /isn't the reservation's/);
  const claimCommand = clone(cap);
  claimCommand.claim.evidence.commandId = "c:" + "0".repeat(64);
  assert.match(captureProblem("claim", claimCommand), /names command/);
});

// #446 review, finding 6.
test("terminal states are named: uncertain, partial, completed and failed end a command; pending doesn't; anything else is an error", () => {
  for (const s of ["completed", "failed", "uncertain", "partial"]) assert.equal(C.isTerminal(s), true, s);
  assert.equal(C.isTerminal("pending"), false);
  assert.throws(() => C.isTerminal("done"), /unknown command status/);
  // A dropped outcome's command must finish uncertain.
  const d = clone(passing()["drop-outcome"]);
  d.capture.status = "completed";
  assert.match(failsOnly("drop-outcome", d, "dropped"), /expected uncertain/);
  // cleanup takes uncertain and partial as terminal, and fails an unknown status.
  const c = clone(passing().cleanup);
  c.commands.push({ commandId: "c:9", status: "done" });
  assert.match(failsOnly("cleanup", c, "terminal"), /unknown command status/);
  const p = clone(passing().cleanup);
  p.commands.push({ commandId: "c:9", status: "pending" });
  assert.match(failsOnly("cleanup", p, "terminal"), /not terminal: c:9 pending/);
});

test("reconciliation is polled while Broker answers too-early, within its deadline and grace; anything else ends it", async () => {
  const op = "inv-2/s0/o1";
  let t = Date.parse(at(0));
  const now = () => t;
  const sleep = async ms => { t += ms; };
  const answers = verdicts => {
    let i = 0;
    return async () => ({ status: 200, operations: [{ operationId: op, verdict: verdicts[Math.min(i++, verdicts.length - 1)], final: true }] });
  };
  const applied = await C.reconcilePoll({ reconcile: answers(["too-early", "too-early", "applied"]), operationId: op, claimedAt: at(0), now, sleep });
  assert.equal(applied.timedOut, false);
  assert.deepEqual(applied.attempts.map(a => a.verdict), ["too-early", "too-early", "applied"]);
  const unresolved = await C.reconcilePoll({ reconcile: answers(["unresolved"]), operationId: op, claimedAt: at(0), now, sleep });
  assert.equal(unresolved.attempts.length, 1, "anything but too-early ends the poll");
  const failed = await C.reconcilePoll({ reconcile: async () => ({ status: 503, operations: [] }), operationId: op, claimedAt: at(0), now, sleep });
  assert.equal(failed.attempts.length, 1);
  t = Date.parse(at(0));
  const late = await C.reconcilePoll({ reconcile: answers(["too-early"]), operationId: op, claimedAt: at(0), now, sleep });
  assert.equal(late.timedOut, true);
  assert.ok(t - Date.parse(at(0)) <= C.MAX_EXECUTION_MS + C.RECONCILE_GRACE_MS + 60_000, "within the bound");
  // The check fails a timed-out poll.
  const d = clone(passing()["drop-outcome"]);
  d.reconcile.timedOut = true;
  assert.match(failsOnly("drop-outcome", d, "reconciled"), /too-early at its bound/);
  await assert.rejects(C.reconcilePoll({ reconcile: answers(["applied"]), operationId: op, claimedAt: undefined, now, sleep }), /claim's time/);
});

// #446 review, finding 7.
test("the quota burst is sized from the item's earlier public captures, against Policy's own limiter", async () => {
  const { createMemoryCommandBackend, createCommandRecords } = await import("../../packages/policy/dist/command-records.js");
  const now = 1_800_000_000_000;
  const commandStore = { commands: new Map() };
  const records = createCommandRecords({ backend: createMemoryCommandBackend({ commandStore }), now: () => now });
  const item = "public-quota-fixture";
  const reserve = async n => {
    const commandId = "c:" + String(n).padStart(64, "0");
    commandStore.commands.set(commandId, { commandId, status: "pending", owner: { generation: 1, leaseExpiresAt: now + 60_000 }, admission: { stages: { s0: { intents: [{ id: "i", scope: { kind: "item", id: item }, occurrences: ["o1"] }] } } } });
    return records.reserve({ commandId, generation: 1, stage: "s0", occurrenceId: "o1", intentId: "i", item, publicCapture: true, limit: PUBLIC_CAPTURE_LIMIT, windowMs: C.PUBLIC_CAPTURE_WINDOW_MS });
  };
  await reserve(0); // first-capture's anonymous public capture
  // Policy's item-captures record after it: one public capture, now.
  const prior = C.priorPublicCaptures({ item, nextCaptureSequence: 2, publicCaptures: [now] }, now);
  assert.equal(prior, 1);
  const remaining = PUBLIC_CAPTURE_LIMIT - prior;
  let allowed = 0;
  let refused = 0;
  for (let n = 1; n <= remaining + 1; n++) {
    try {
      await reserve(n);
      allowed++;
    } catch (e) {
      assert.equal(e.reason, "rate-limited");
      refused++;
    }
  }
  assert.deepEqual({ allowed, refused }, { allowed: 11, refused: 1 });
  const o = { ...clone(passing()["rate-limit"]), priorInWindow: prior, attempted: remaining + 1, allowed, refused };
  assert.equal(judgePhase("rate-limit", o).passed, true);
  // The old expectation, 12 allowed after an earlier capture, fails.
  assert.match(failsOnly("rate-limit", { ...o, allowed: 12, refused: 0 }, "quota"), /12 allowed, expected 11|refused/);
  // The window's edge, an absent record and unreadable times.
  assert.equal(C.priorPublicCaptures({ publicCaptures: [now - C.PUBLIC_CAPTURE_WINDOW_MS, now - 1] }, now), 1);
  assert.equal(C.priorPublicCaptures({ absent: true }, now), 0);
  assert.throws(() => C.priorPublicCaptures({}, now), /publicCaptures/);
  assert.match(failsOnly("rate-limit", { ...o, priorInWindow: undefined }, "quota"), /aren't readable/);
});

test("the quota phase's Policy client has what verifyRetired calls, due included", async () => {
  const calls = [];
  const client = C.policyFixtureClient(async (method, route, body) => {
    calls.push([method, route, body ?? null]);
    if (route.startsWith("/v1/commands-due")) return { commands: route.includes("scopes=1") ? [{ commandId: "c:2" }] : [] };
    return { status: route.endsWith("c%3A2") ? "pending" : "failed" };
  });
  const verified = await verifyRetired({ client, ids: ["c:1", "c:2"] });
  assert.deepEqual(verified.statuses, { "c:1": "failed", "c:2": "pending" });
  assert.deepEqual(verified.listedAfter, ["c:2"]);
  assert.ok(calls.some(([, r]) => r === "/v1/commands-due?limit=50&recording=1&repairs=1"));
  assert.ok(calls.some(([, r]) => r === "/v1/commands-due?limit=50&recording=1&repairs=1&scopes=1"));
  const o = clone(passing()["rate-limit"]);
  o.retired.listedAfter = ["c:2"];
  assert.match(failsOnly("rate-limit", o, "retired"), /still due: c:2/);
});

// #446 review, finding 8.
test("boundary needs correlated coverage: every claimed operation's execute evidence, every invocation's claims, no truncation, a completed poll", () => {
  // The repro: evidence for one invocation only.
  const repro = clone(passing().boundary);
  repro.brokerAudit = [repro.brokerAudit[0]];
  repro.reconcileBuckets = [];
  const r = judgePhase("boundary", repro);
  assert.equal(r.passed, false);
  assert.match(r.checks.find(c => c.id === "drive-broker-executes").detail, /no broker-c5d-drive execute evidence for inv-2\/s0\/o1/);
  const missingClaims = clone(passing().boundary);
  delete missingClaims.claimsByInvocation["inv-2"];
  assert.match(judgePhase("boundary", missingClaims).checks.find(c => c.id === "audit-complete").detail, /claims not read for inv-2/);
  const truncated = clone(passing().boundary);
  truncated.queries[1].count = 1000;
  assert.match(failsOnly("boundary", truncated, "audit-complete"), /truncated/);
  const paged = clone(passing().boundary);
  paged.queries[0].nextPageToken = "more";
  assert.match(failsOnly("boundary", paged, "audit-complete"), /truncated/);
  const timedOut = clone(passing().boundary);
  timedOut.poll.timedOut = true;
  assert.match(failsOnly("boundary", timedOut, "audit-complete"), /timed out before coverage/);
  const unread = clone(passing().boundary);
  unread.commands.push({ commandId: "c:" + "7".repeat(64) });
  assert.match(failsOnly("boundary", unread, "audit-complete"), /commands not read/);
  const unaccounted = clone(passing().boundary);
  unaccounted.reconcileBuckets = [];
  assert.match(failsOnly("boundary", unaccounted, "production-broker-bookkeeping"), /no bucket read: inv-2\/s0\/o1/);
});

// #446 review, finding 3.
test("the command inventory: the plan's ids and every journaled request own commands; a manifest's ids are only observed; an unanswered intent is reported", () => {
  const j = (file, value) => ({ file, value });
  const anonId = "c:" + "a".repeat(64);
  const nonOwnerId = "c:" + "b".repeat(64);
  const manifestId = "c:" + "c".repeat(64);
  const inv = C.inventory({
    plan: T,
    journal: [
      j("first-private.json", { kind: "keyed", commandId: T.ids["first-private"] }),
      j("first-public.json", { kind: "anonymous", commandId: null }),
      j("first-public.id.json", { commandId: anonId }),
      j("rate-limit-13.json", { kind: "anonymous", commandId: null }),
      j("rate-limit-13.id.json", { commandId: null, noAllocation: { kind: "refusal", status: 400, reason: "bad-request" } }),
      j("rate-limit-14.json", { kind: "anonymous", commandId: null }),
      j("non-owner.json", { kind: "keyed", uid: "someone", commandId: nonOwnerId }),
      j("canary-snap.json", { kind: "canary", commandId: T.ids["canary-snap"] }),
    ],
    manifests: [{ observations: { anything: { deep: [manifestId] } } }],
  });
  for (const id of [...Object.values(T.ids), anonId, nonOwnerId]) assert.ok(inv.commandIds.includes(id), id);
  // A manifest's ids are observations, never ownership (#446 fifth review).
  assert.ok(!inv.commandIds.includes(manifestId));
  assert.deepEqual(inv.observed, [manifestId]);
  assert.deepEqual(inv.unresolvedIntents, ["rate-limit-14.json"], "a refusal before allocation resolves; never answered doesn't");
  // The canary's id is planned from the run id canary.js is given.
  assert.equal(T.ids["canary-snap"], commandIdFor(UID, `canary:${T.canaryRunId}:snap`));
  assert.match(T.canaryRunId, /^[a-z0-9]{4,40}$/);
  // cleanup fails on an unresolved intent.
  const c = clone(passing().cleanup);
  c.unresolvedIntents = ["rate-limit-14.json"];
  assert.match(failsOnly("cleanup", c, "terminal"), /no recorded command id: rate-limit-14.json/);
  // canary-snap fails without its command id, or with another.
  const s = clone(passing()["canary-snap"]);
  s.commandId = null;
  assert.match(failsOnly("canary-snap", s, "command-recorded"), /no command id/);
  s.commandId = "c:" + "d".repeat(64);
  assert.match(failsOnly("canary-snap", s, "command-recorded"), /not the planned/);
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
const planned = () => {
  const parent = mkdtempSync(path.join(tmpdir(), "c5d-drive-cli-"));
  assert.equal(cli(["--phase", "plan", "--run", RUN, "--uid", UID, "--dir", parent]).status, 0);
  return { parent, dir: path.join(parent, RUN) };
};

test("the CLI refuses production and B6 names, and other services' or custom-domain URLs, before anything else", () => {
  for (const argv of [["--api", "api"], ["--broker", "broker"], ["--l0013r", "l0013r"], ["--l0176r", "l0176r-drive"], ["--broker", "broker-faults"], ["--bucket", "graffiticode-thumbnails"], ["--bucket", "graffiticode.appspot.com"],
    ["--api-url", url("api")], ["--api-url", "https://api.graffiticode.org"], ["--api-url", url("broker-c5d-drive")]]) {
    // A temporary --dir: no run directory is ever left in docs/evidence.
    const parent = mkdtempSync(path.join(tmpdir(), "c5d-drive-refused-"));
    const r = cli(["--phase", "checks", "--run", RUN, "--dir", parent, ...argv]);
    assert.equal(r.status, 2, argv.join(" "));
    assert.match(r.stderr, /^refused: /);
    assert.deepEqual(readdirSync(parent), [], "refused before anything was written");
  }
});

test("the CLI's plan is offline, written once, and the run's phases need it", () => {
  const { parent } = planned();
  const plan = JSON.parse(readFileSync(path.join(parent, RUN, "plan.json"), "utf8"));
  assert.deepEqual(plan.faults, T.faults);
  assert.equal(plan.ids["canary-snap"], T.ids["canary-snap"]);
  const again = cli(["--phase", "plan", "--run", RUN, "--uid", UID, "--dir", parent]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /never overwritten/);
  const other = cli(["--phase", "checks", "--run", RUN, "--uid", "someone-else", "--dir", parent]);
  assert.equal(other.status, 2);
  assert.match(other.stderr, /differ from plan.json/);
  assert.equal(cli(["--phase", "checks", "--run", "zzzz9999", "--dir", parent]).status, 2, "no plan, no phase");
});

// #446 review, finding 2.
test("the CLI's baseline is the run's one: refused once captures have begun or once taken, and capture phases need it", () => {
  const started = planned();
  writeFileSync(path.join(started.dir, "first-capture-2026-11-20T00-00-01-000Z.json"), "{}");
  const r = cli(["--phase", "baseline", "--run", RUN, "--uid", UID, "--dir", started.parent]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refused: captures have begun/);
  const journaled = planned();
  writeFileSync(path.join(journaled.dir, "journal", "first-private.json"), "{}");
  assert.match(cli(["--phase", "baseline", "--run", RUN, "--uid", UID, "--dir", journaled.parent]).stderr, /captures have begun/);
  const taken = planned();
  writeFileSync(path.join(taken.dir, "baseline.json"), JSON.stringify({ observations: { thumbnails: listingOf() } }));
  assert.match(cli(["--phase", "baseline", "--run", RUN, "--uid", UID, "--dir", taken.parent]).stderr, /refused: this run's baseline is fixed/);
  const none = planned();
  const capture = cli(["--phase", "first-capture", "--run", RUN, "--uid", UID, "--dir", none.parent]);
  assert.equal(capture.status, 2);
  assert.match(capture.stderr, /no baseline.json/);
});

// Every phase's manifest, as the runner writes them.
const writeRun = (dir, all, { withBaselineFile = true } = {}) => {
  const stamp = s => `2026-11-20T00-00-${String(s).padStart(2, "0")}-000Z`;
  if (withBaselineFile) writeFileSync(path.join(dir, "baseline.json"), JSON.stringify({ observations: all.baseline }));
  DRIVE_PHASES.forEach((p, i) => {
    if (p === "baseline") return;
    let obs = all[p];
    if (p === "drop-outcome") {
      const { stagedAfterDelete, stagedDeletedAt, retry, reconcile, objectAfterRetry, executeSteps, ...first } = obs;
      writeFileSync(path.join(dir, `drop-outcome-retry-${stamp(59)}.json`), JSON.stringify({ observations: { stagedAfterDelete, stagedDeletedAt, retry, reconcile, objectAfterRetry, executeSteps } }));
      obs = first;
    }
    writeFileSync(path.join(dir, `${p}-${stamp(i)}.json`), JSON.stringify({ observations: obs }));
  });
};

test("the CLI's judge reads each phase's latest manifest, joins the operator pauses, and writes a new report each time", () => {
  const { parent, dir } = planned();
  const all = passing();
  writeRun(dir, all);
  writeFileSync(path.join(dir, "cleanup-2026-11-19T00-00-00-000Z.json"), JSON.stringify({ observations: { commands: [], due: [] } }));
  const r = cli(["--phase", "judge", "--run", RUN, "--uid", UID, "--dir", parent]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /DRIVE PASSED/);
  writeFileSync(path.join(dir, "cleanup-2026-11-21T00-00-00-000Z.json"), JSON.stringify({ observations: { ...all.cleanup, due: ["c:1"] } }));
  const failed = cli(["--phase", "judge", "--run", RUN, "--uid", UID, "--dir", parent]);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAILED cleanup\/terminal/);
  assert.equal(readdirSync(dir).filter(f => f.startsWith("report-")).length, 2, "each judgment its own report");
});

// #446 review, finding 2: the owner's reproduction.
test("the CLI's judge holds boundary to baseline.json: a later baseline can't hide a production generation change", () => {
  const { parent, dir } = planned();
  const all = passing();
  const changed = clone(all.baseline);
  changed.thumbnails[0].generation = "1600000000099999";
  // The run's baseline, then a production change, then a later "baseline"
  // and a boundary that both carry the changed listing.
  writeRun(dir, { ...all, boundary: { ...all.boundary, thumbnailsBefore: changed.thumbnails, thumbnailsAfter: changed.thumbnails } });
  writeFileSync(path.join(dir, "baseline-2026-11-20T00-59-00-000Z.json"), JSON.stringify({ observations: changed }));
  const r = cli(["--phase", "judge", "--run", RUN, "--uid", UID, "--dir", parent]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAILED boundary\/thumbnails-unchanged: the listing changed/);
  // With no baseline.json at all, the baseline phase hasn't run.
  const other = planned();
  writeRun(other.dir, all, { withBaselineFile: false });
  writeFileSync(path.join(other.dir, "baseline-2026-11-20T00-00-00-000Z.json"), JSON.stringify({ observations: all.baseline }));
  const missing = cli(["--phase", "judge", "--run", RUN, "--uid", UID, "--dir", other.parent]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /FAILED baseline\/run: not run/);
});

// #446 review, finding 4.
test("Step 34 stages the api with --stage and promotes it only with the canary's and canary.js --snap's evidence; Step 33 expects the floor's refusal", () => {
  const doc = readFileSync(new URL("../../docs/capability-policy-iam-review.md", import.meta.url), "utf8");
  const step33 = doc.slice(doc.indexOf("### Step 33:"), doc.indexOf("### Step 34:"));
  const step34 = doc.slice(doc.indexOf("### Step 34:"), doc.indexOf("## 4. Verification"));
  assert.match(step34, /npm run deploy -- api --stage/);
  assert.match(step34, /npm run deploy -- promote api --release <the staged release id> --evidence docs\/evidence\/c5d\/activation\/api-promote-evidence\.json/);
  assert.doesNotMatch(step34, /`npm run deploy -- api`\)/, "no unstaged api release");
  assert.match(step33, /npm run rollback -- api --release rmwkxlbvy-b5fa92 --plan/);
  assert.match(step33, /refus/);
  for (const step of [step33, step34]) assert.match(step, /HELD/);
  // Step 32 keeps both deletions.
  const step32 = doc.slice(doc.indexOf("### Step 32:"), doc.indexOf("### Step 33:"));
  assert.equal((step32.match(/gcloud storage rm 'gs:\/\/graffiticode-command-staging\//g) ?? []).length, 2);
});

// ------------------------------------------------- #446 second review

// Finding 1: the owner's reproduction, and what counts as proof of no allocation.
test("an ambiguous answer never resolves an intent: only an id, a refusal before allocation, or Policy's records do", () => {
  const known = "c:" + "1".repeat(64);
  const hidden = "c:" + "2".repeat(64);
  const j = (file, value) => ({ file, value });
  // The reproduction: a 500 after allocation, recorded as { commandId: null }.
  const repro = C.inventory({ plan: { ids: { known } }, journal: [j("rate-limit-1.json", { kind: "anonymous", commandId: null }), j("rate-limit-1.id.json", { commandId: null })], manifests: [] });
  assert.deepEqual(repro.unresolvedIntents, ["rate-limit-1.json"]);
  const cleanup = judgePhase("cleanup", { commands: [{ commandId: known, status: "completed" }], due: [hidden], unresolvedIntents: repro.unresolvedIntents });
  assert.equal(cleanup.passed, false);
  assert.match(cleanup.checks.find(c => c.id === "terminal").detail, /no recorded command id: rate-limit-1.json/);
  // An ambiguous answer's evidence file isn't a resolution.
  const ambiguous = C.inventory({ plan: { ids: {} }, journal: [j("a-1.json", { kind: "anonymous", commandId: null }), j("a-1.ambiguous.json", { status: 500, body: null })], manifests: [] });
  assert.deepEqual(ambiguous.unresolvedIntents, ["a-1.json"]);
  // What an answer proves.
  const id = "c:" + "3".repeat(64);
  assert.deepEqual(C.answerResolution({ status: 200, body: {}, commandId: id }), { commandId: id });
  for (const answer of [
    { status: 500, body: null },
    { status: 503, body: { error: { reason: "unavailable" } } },
    { status: 200, body: "not json" },
    { status: 403, body: { error: { reason: "rate-limited" } } },
    { status: 403, body: { error: { reason: "not-owner" } } },
    { status: 404, body: { error: { reason: "task-not-found" } } },
    { status: null, body: null },
  ]) assert.equal(C.answerResolution(answer), null, JSON.stringify(answer));
  for (const reason of C.PRE_ALLOCATION_REFUSALS) {
    const r = C.answerResolution({ status: 403, body: { error: { reason } } });
    assert.deepEqual(r, { commandId: null, noAllocation: { kind: "refusal", status: 403, reason } });
    assert.deepEqual(C.inventory({ plan: { ids: {} }, journal: [j("b.json", { kind: "anonymous", commandId: null }), j("b.id.json", r)], manifests: [] }).unresolvedIntents, []);
  }
  // A forged noAllocation (a 5xx, or an unlisted reason) doesn't resolve.
  for (const noAllocation of [{ kind: "refusal", status: 500, reason: "bad-request" }, { kind: "refusal", status: 403, reason: "rate-limited" }, { kind: "policy-records", found: 1 }]) {
    assert.deepEqual(C.inventory({ plan: { ids: {} }, journal: [j("b.json", { kind: "anonymous" }), j("b.id.json", { commandId: null, noAllocation })], manifests: [] }).unresolvedIntents, ["b.json"]);
  }
});

// #446 third review: the api allocates after the client has lost its answer.
const cmdRecord = (n, s, extra = {}) => ({ commandId: "c:" + String(n).repeat(64), uid: "anonymous", taskId: "task-1", createdAt: at(s), status: "pending", ...extra });

test("the owner's reproduction: a late allocation by the real api bridge fails cleanup until resolve-journal correlates it and it is terminal", async () => {
  const { createMemoryInvocationStore, createMemoryCommandStore } = await import("@graffiticode/policy");
  const { buildCommandBridge } = await import("../../packages/api/src/commands/bridge.js");
  const zero = Date.parse("2026-11-19T20:00:00Z");
  let clock = zero;
  let releasePreflight;
  const preflight = new Promise(resolve => { releasePreflight = resolve; });
  const store = createMemoryCommandStore({ invocationStore: createMemoryInvocationStore() });
  const taskId = "late-public-task";
  const bridge = buildCommandBridge({
    scopes: true,
    env: { COMMANDS_L0013: "on" },
    newKey: () => "bridge:late-request",
    log: () => {},
    eligible: async () => {
      await preflight;
      return { lang: "0013", writes: [{ lang: "0013", credential: "service" }] };
    },
    getRunner: () => ({
      worker: "offline-drive",
      policy: {
        allocate: async args => {
          const out = await store.allocate({ ...args, uid: "anonymous", now: clock, scopes: 1 });
          return { protocol: out.protocol, commandId: out.command.commandId, generation: 1, status: "pending", owned: true };
        },
      },
      run: async ({ commandId }) => ({ commandId, status: "pending" }),
    }),
    compileEnvelope: async outcome => outcome,
  });
  const inFlight = bridge({ tasks: [{ lang: "0013", code: {} }], id: taskId, auth: null });
  const sentAt = new Date(clock).toISOString();
  clock = zero + 1000; // the client loses its connection
  const answeredAt = new Date(clock).toISOString();
  clock = zero + 30_000; // preflight finishes; the api allocates
  releasePreflight();
  const late = await store.get((await inFlight).state.commandId);
  assert.equal(late.createdAt, new Date(zero + 30_000).toISOString());
  const known = "c:" + "1".repeat(64);
  const j = (file, value) => ({ file, value });
  const journal = [j("rate-limit-1.json", { kind: "anonymous", task: taskId, sentAt, commandId: null }), j("rate-limit-1.ambiguous.json", { task: taskId, sentAt, answeredAt, status: null })];
  const policy = () => ({ since: sentAt, tasks: [taskId], queries: [{ query: `policy commands where taskId == ${taskId}`, pages: 1, count: 1, complete: true }], commands: [{ ...late, status: late.status }] });
  const cleanupOf = (inv, status, due) => judgePhase("cleanup", {
    commands: inv.commandIds.map(id => ({ commandId: id, status: id === late.commandId ? status : "completed" })),
    due,
    unresolvedIntents: inv.unresolvedIntents,
    policyEnumeration: { ...policy(), commands: [{ ...late, status }] },
  });
  const due = (await store.listDue({ now: zero + 100_000, limit: 50, scopes: 1, recording: 1, repairs: 1 })).map(c => c.commandId);
  assert.ok(due.includes(late.commandId));
  // Before resolve-journal: unresolved, and Policy's enumeration names the command.
  const before = C.inventory({ plan: { ids: { known } }, journal, manifests: [] });
  assert.deepEqual(before.unresolvedIntents, ["rate-limit-1.json"]);
  const failing = cleanupOf(before, "pending", due);
  assert.equal(failing.passed, false);
  assert.match(failing.checks.find(c => c.id === "terminal").detail, /rerun --phase resolve-journal later/);
  assert.match(failing.checks.find(c => c.id === "policy-enumeration").detail, new RegExp(`inventory lacks: ${late.commandId}`));
  // resolve-journal correlates it, with no upper bound on the query.
  const resolutions = C.correlateIntents({ intents: [{ name: "rate-limit-1", task: taskId, sentAt }], commands: [late], claimed: before.commandIds });
  assert.equal(resolutions["rate-limit-1"].commandId, late.commandId);
  assert.equal(resolutions["rate-limit-1"].resolvedBy.createdAt, late.createdAt);
  const after = C.inventory({ plan: { ids: { known } }, journal: [...journal, j("rate-limit-1.id.json", resolutions["rate-limit-1"])], manifests: [] });
  assert.deepEqual(after.unresolvedIntents, []);
  assert.ok(after.commandIds.includes(late.commandId));
  // Still pending and due: cleanup fails; terminal and not due: it passes.
  assert.equal(cleanupOf(after, "pending", due).passed, false);
  assert.equal(cleanupOf(after, "failed", []).passed, true);
});

// #446 fourth and fifth reviews: a failed cleanup's manifest records what its
// queries found: the command Policy's enumeration discovered, and the shared
// sweeper `due` listing, which names that command and production's too. Queried
// ids are observations, never ownership: resolve-journal still correlates the
// intent with the late command, the next cleanup still reports it missing
// until then, a production command in `due` never joins the drive's
// inventory, and the failed cleanup's evidence stays where it was, unchanged.
test("a failed cleanup's queried commands (enumeration and due) stay observations: resolve-journal still correlates, production's never joins, and the evidence is kept", () => {
  const known = "c:" + "1".repeat(64);
  const late = { commandId: "c:" + "2".repeat(64), uid: "anonymous", taskId: "task-public", createdAt: "2026-11-19T21:00:30Z", status: "pending" };
  // A production command the shared sweeper query also lists as due.
  const unrelated = "c:" + "9".repeat(64);
  const intent = { name: "rate-limit-1", kind: "anonymous", task: "task-public", sentAt: "2026-11-19T21:00:00Z", commandId: null };
  const j = (file, value) => ({ file, value });
  const journal = [j("rate-limit-1.json", intent), j("rate-limit-1.ambiguous.json", { task: intent.task, sentAt: intent.sentAt, status: null })];
  const enumeration = status => ({ since: intent.sentAt, tasks: [intent.task], queries: [{ query: "policy commands where taskId == task-public", pages: 1, count: 1, complete: true }], commands: [{ ...late, status }] });
  const cleanupOf = (inv, status) => judgePhase("cleanup", {
    commands: inv.commandIds.map(id => ({ commandId: id, status: id === late.commandId ? status : "completed" })),
    due: [],
    unresolvedIntents: inv.unresolvedIntents,
    policyEnumeration: enumeration(status),
  });
  // The failed cleanup, saved as the runner saves it.
  const before = C.inventory({ plan: { ids: { known } }, journal, manifests: [] });
  const failed = cleanupOf(before, "pending");
  assert.equal(failed.passed, false);
  const dir = mkdtempSync(path.join(tmpdir(), "c5d-cleanup-evidence-"));
  const file = path.join(dir, "cleanup-1.json");
  writeFileSync(file, JSON.stringify({ phase: "cleanup", passed: false, observations: { commands: before.commandIds.map(id => ({ commandId: id, status: "completed" })), due: [late.commandId, unrelated], unresolvedIntents: before.unresolvedIntents, policyEnumeration: enumeration("pending") } }));
  const saved = readFileSync(file, "utf8");
  const manifests = () => [JSON.parse(readFileSync(file, "utf8"))];
  // A query's ids aren't ownership: both are observed, neither inventoried.
  const withEvidence = C.inventory({ plan: { ids: { known } }, journal, manifests: manifests() });
  assert.deepEqual(withEvidence.commandIds, [known], "only the plan and the journal own commands");
  assert.deepEqual(withEvidence.observed, [late.commandId, unrelated].sort());
  assert.deepEqual(withEvidence.unresolvedIntents, ["rate-limit-1.json"]);
  // So a second cleanup still reports it missing, rather than passing on its own earlier finding.
  assert.match(cleanupOf(withEvidence, "pending").checks.find(c => c.id === "policy-enumeration").detail, new RegExp(`inventory lacks: ${late.commandId}`));
  // And resolve-journal still correlates the intent with it.
  const resolutions = C.correlateIntents({ intents: [intent], commands: [late], claimed: withEvidence.commandIds });
  assert.equal(resolutions["rate-limit-1"].commandId, late.commandId);
  const resolved = C.inventory({ plan: { ids: { known } }, journal: [...journal, j("rate-limit-1.id.json", resolutions["rate-limit-1"])], manifests: manifests() });
  assert.deepEqual(resolved.unresolvedIntents, []);
  assert.ok(resolved.commandIds.includes(late.commandId));
  assert.deepEqual(resolved.commandIds, [known, late.commandId].sort(), "assigned now, by the journal's resolution; production's command never");
  assert.deepEqual(resolved.observed, [unrelated]);
  assert.equal(cleanupOf(resolved, "failed").passed, true);
  // The failed cleanup's evidence is neither moved nor changed.
  assert.deepEqual(readdirSync(dir), ["cleanup-1.json"]);
  assert.equal(readFileSync(file, "utf8"), saved);
});

test("an empty query, or a records-based 'none', never resolves an ambiguous intent", () => {
  const intent = { name: "a", task: "task-1", sentAt: at(10) };
  assert.deepEqual(C.correlateIntents({ intents: [intent], commands: [], claimed: [] }), {});
  // Commands before it was sent, another task's or another principal's aren't candidates.
  assert.deepEqual(C.correlateIntents({ intents: [intent], commands: [cmdRecord(4, 9), cmdRecord(5, 11, { taskId: "task-2" }), cmdRecord(6, 11, { uid: UID })], claimed: [] }), {});
  // A claimed command isn't a candidate either.
  assert.deepEqual(C.correlateIntents({ intents: [intent], commands: [cmdRecord(4, 11)], claimed: [cmdRecord(4, 11).commandId] }), {});
  // A late one, long after, is.
  assert.equal(C.correlateIntents({ intents: [intent], commands: [cmdRecord(4, 59)], claimed: [] }).a.commandId, cmdRecord(4, 59).commandId);
  const j = (file, value) => ({ file, value });
  const none = { commandId: null, noAllocation: { kind: "policy-records", taskId: "task-1", from: at(5), to: at(17), found: 0 } };
  assert.deepEqual(C.inventory({ plan: { ids: {} }, journal: [j("a.json", { kind: "anonymous" }), j("a.id.json", none)], manifests: [] }).unresolvedIntents, ["a.json"]);
  assert.equal(C.ANONYMOUS_SUBJECT, "anonymous");
});

test("two ambiguous intents and one candidate: the one whose window holds it resolves, the other stays; a candidate both could own resolves neither", () => {
  const first = { name: "rate-limit-1", task: "task-1", sentAt: at(10) };
  const second = { name: "rate-limit-2", task: "task-1", sentAt: at(20) };
  const one = C.correlateIntents({ intents: [first, second], commands: [cmdRecord(4, 15)], claimed: [] });
  assert.deepEqual(Object.keys(one), ["rate-limit-1"]);
  assert.equal(one["rate-limit-1"].commandId, cmdRecord(4, 15).commandId);
  // Created after both were sent: either could own it.
  assert.deepEqual(C.correlateIntents({ intents: [first, second], commands: [cmdRecord(4, 25)], claimed: [] }), {});
  // Two candidates for one intent: not unique.
  assert.deepEqual(C.correlateIntents({ intents: [second], commands: [cmdRecord(4, 25), cmdRecord(5, 26)], claimed: [] }), {});
  // An assignment frees the rest: once the first takes its only candidate, the second's is unique.
  const chain = C.correlateIntents({ intents: [first, second], commands: [cmdRecord(4, 15), cmdRecord(5, 25)], claimed: [] });
  assert.equal(chain["rate-limit-1"], undefined, "first could own either: 15 or 25");
  const ordered = C.correlateIntents({ intents: [first, second], commands: [cmdRecord(4, 15), cmdRecord(5, 25)], claimed: [cmdRecord(5, 25).commandId] });
  assert.equal(ordered["rate-limit-1"].commandId, cmdRecord(4, 15).commandId);
});

test("cleanup's Policy enumeration finds a late allocation the journal never mentions", () => {
  const o = clone(passing().cleanup);
  const late = cmdRecord(7, 50, { taskId: "task-public" });
  o.policyEnumeration.commands.push(late);
  assert.match(failsOnly("cleanup", o, "policy-enumeration"), new RegExp(`inventory lacks: ${late.commandId}`));
  // Inventoried but pending, or due: still failing.
  const p = clone(passing().cleanup);
  p.commands.push({ commandId: late.commandId, status: "pending" });
  p.policyEnumeration.commands.push(late);
  assert.equal(judgePhase("cleanup", p).passed, false);
  // The selection: since the run began, on a drive task, the non-owner's, the canary's L0013, or pinned to a drive compiler.
  const selected = C.drivePolicyCommands({
    since: at(10),
    tasks: ["task-1"],
    principals: { canary: UID, nonOwner: "other-user" },
    records: [
      cmdRecord(1, 11),
      cmdRecord(2, 9),
      cmdRecord(3, 12, { taskId: "task-x", uid: "other-user" }),
      cmdRecord(4, 13, { taskId: "task-y", uid: UID, lang: "0013" }),
      cmdRecord(5, 14, { taskId: "task-z", uid: UID, lang: "0176" }),
      cmdRecord(6, 15, { taskId: "task-w", uid: UID, lang: "0176", revisions: ["l0176r-c5d-drive-rmwabc123-1a2b3c"] }),
    ],
  });
  assert.deepEqual(selected.map(c => c.commandId[2]), ["1", "3", "4", "6"]);
  assert.throws(() => C.drivePolicyCommands({ since: "garbage", tasks: [], principals: {}, records: [] }), /start/);
});

test("the enumeration pages to its end, and a truncated or unreadable one fails cleanup", async () => {
  const docs = Array.from({ length: 650 }, (_, i) => ({ name: `d${String(i).padStart(4, "0")}` }));
  const fetchPage = async ({ after, limit }) => {
    const start = after ? docs.findIndex(d => d.name === after) + 1 : 0;
    return docs.slice(start, start + limit);
  };
  const all = await C.paginateAll({ fetchPage, pageSize: 300 });
  assert.deepEqual([all.count, all.pages, all.complete], [650, 3, true]);
  const truncated = await C.paginateAll({ fetchPage, pageSize: 300, maxPages: 2 });
  assert.deepEqual([truncated.count, truncated.complete], [600, false]);
  const exact = await C.paginateAll({ fetchPage: async ({ after }) => (after ? [] : docs.slice(0, 300)), pageSize: 300 });
  assert.deepEqual([exact.pages, exact.complete], [2, true], "a full last page needs one more read to prove the end");
  await assert.rejects(C.paginateAll({ fetchPage: async () => null }), /isn't a list/);
  const o = clone(passing().cleanup);
  o.policyEnumeration.queries[1] = { ...o.policyEnumeration.queries[1], complete: false };
  assert.match(failsOnly("cleanup", o, "policy-enumeration"), /incomplete or truncated/);
  const missing = clone(passing().cleanup);
  delete missing.policyEnumeration;
  assert.match(failsOnly("cleanup", missing, "policy-enumeration"), /not observed/);
});

// Finding 2: the owner's reproduction: the controls first, the violation later.
test("audit polling watches past coverage for the observation period and judges a full recollection: a late production execute fails", async () => {
  const b = passing().boundary;
  const ops = Object.values(b.claimsByInvocation).flat();
  const lateViolation = { service: "broker", event: "execute", invocationId: "inv-1", opid: ops[0] };
  let t = 0;
  let reads = 0;
  // Covered on the first read; the violation is ingested two minutes later.
  const read = async () => {
    reads++;
    return [{ query: "all", count: 5, limit: 1000, entries: t < 120_000 ? b.brokerAudit : [...b.brokerAudit, lateViolation] }];
  };
  const { value, poll } = await C.observeAudit({ read, covered: C.auditCovered(ops), timeoutMs: 60_000, intervalMs: 15_000, now: () => t, sleep: async ms => { t += ms; } });
  assert.ok(reads > 2, "kept reading after coverage");
  assert.equal(poll.observedMs >= C.AUDIT_OBSERVATION_MS, true);
  assert.equal(poll.recollected, true);
  const observed = { ...b, queries: value.map(({ entries, ...q }) => q), brokerAudit: value.flatMap(q => q.entries), poll };
  const judged = judgePhase("boundary", observed);
  assert.equal(judged.passed, false);
  assert.match(judged.checks.find(c => c.id === "drive-broker-executes").detail, /executes by broker/);
  // Without the violation, the same observation passes.
  let u = 0;
  const clean = await C.observeAudit({ read: async () => [{ query: "all", count: 4, limit: 1000, entries: b.brokerAudit }], covered: C.auditCovered(ops), timeoutMs: 60_000, now: () => u, sleep: async ms => { u += ms; } });
  assert.equal(judgePhase("boundary", { ...b, poll: clean.poll }).passed, true);
  // A poll that stopped at coverage, or wasn't recollected, fails.
  assert.match(failsOnly("boundary", { ...clone(b), poll: { attempts: 1, timedOut: false } }, "audit-complete"), /watched .* after coverage/);
  assert.match(failsOnly("boundary", { ...clone(b), poll: { ...b.poll, recollected: false } }, "audit-complete"), /recollected/);
  // Never covered: timed out.
  let v = 0;
  const never = await C.observeAudit({ read: async () => [{ entries: [] }], covered: C.auditCovered(ops), timeoutMs: 60_000, intervalMs: 15_000, now: () => v, sleep: async ms => { v += ms; } });
  assert.equal(never.poll.timedOut, true);
  assert.ok(C.AUDIT_OBSERVATION_MS >= 180_000, "at least the C5a gate's ingestion bound");
});

// Finding 3: Step 34's canary is the established 36-check job invocation.
test("Step 34's canary is the job against the tag with every flag of the established 36/36 invocation, the snap check apart", () => {
  const doc = readFileSync(new URL("../../docs/capability-policy-iam-review.md", import.meta.url), "utf8");
  const step34 = doc.slice(doc.indexOf("### Step 34:"), doc.indexOf("## 4. Verification"));
  const established = readFileSync(new URL("../../docs/evidence/b6-repair-activation/README.md", import.meta.url), "utf8");
  const argsOf = text => {
    const m = /gcloud run jobs execute canary[^`]*?--args=([^\n`]+)/.exec(text);
    assert.ok(m, "no gcloud run jobs execute canary --args=... in the text");
    return m[1].split(",");
  };
  const flagsOf = list => list.filter(a => a.startsWith("--"));
  const wanted = flagsOf(argsOf(established));
  assert.deepEqual(wanted, ["--uid", "--connection", "--chain-admission", "--after-cutover", "--command", "--l0185-tail", "--api-url"]);
  const documented = argsOf(step34);
  for (const f of wanted) assert.ok(documented.includes(f), `Step 34's canary lacks ${f}`);
  assert.equal(documented[documented.indexOf("--api-url") + 1], "<the staged tag URL>");
  const slice5 = JSON.parse(readFileSync(new URL("../../docs/evidence/b6-repair/slice5-api-promote-evidence.json", import.meta.url), "utf8"));
  for (const f of slice5.notes.canaryJob.args.split(" ")) assert.ok(documented.includes(f), `lacks slice 5's ${f}`);
  assert.ok(step34.includes("`notes.canaryJob`: `{ execution: \"canary-<id>\", apiUrl: \"<the staged tag URL>\", args: \"--chain-admission --after-cutover --command --l0185-tail\", checks: 36, failed: 0 }`"));
  // The snap check stays separate, and no bare canary.js run stands for the 36 checks.
  assert.ok(step34.includes("node scripts/canary.js --uid <canary uid> --snap <canary-owned item> --snap-only --api-url <the staged tag URL>"));
  assert.ok(!step34.includes("node scripts/canary.js --uid <canary uid> --connection"));
});

test("the quota check says a window-edge failure needs a fresh run", () => {
  const o = { ...clone(passing()["rate-limit"]), allowed: 12, refused: 1 };
  assert.match(failsOnly("rate-limit", o, "quota"), /fresh run/);
});

// ------------------------------------------ Step 32's correction (run 0aa69b9a)

test("access-probes runs after checks and before baseline, and a missing observation fails", () => {
  assert.deepEqual(DRIVE_PHASES.slice(0, 3), ["checks", "access-probes", "baseline"]);
  assert.deepEqual(PHASES["access-probes"].map(([id]) => id).filter(id => id.startsWith("l0013r-")), C.ACCESS_PROBES.map(p => `l0013r-${p}`));
  // A compiler never probed: all its checks fail, the other's pass.
  const missing = clone(passing()["access-probes"]);
  delete missing.compilers.l0176r;
  const r = judgePhase("access-probes", missing);
  assert.deepEqual(r.checks.filter(c => !c.ok).map(c => c.id), C.ACCESS_PROBES.map(p => `l0176r-${p}`));
  // No model, so no start probes: they fail as unobserved (the model check passes, it was read).
  const noStarts = clone(passing()["access-probes"]);
  delete noStarts.compilers.l0013r["start-malformed-session"];
  delete noStarts.compilers.l0013r["start-forged-session"];
  assert.deepEqual(judgePhase("access-probes", noStarts).checks.filter(c => !c.ok).map(c => c.id), ["l0013r-start-malformed-session", "l0013r-start-forged-session"]);
  // An incomplete enumeration, or an unread counter, fails policy-unchanged.
  const partial = clone(passing()["access-probes"]);
  partial.policyAfter.complete = false;
  assert.match(failsOnly("access-probes", partial, "policy-unchanged"), /incomplete/);
  const unread = clone(passing()["access-probes"]);
  delete unread.policyBefore.itemCaptures[FIXTURES.public];
  assert.match(failsOnly("access-probes", unread, "policy-unchanged"), /not readable/);
  const added = clone(passing()["access-probes"]);
  added.policyAfter.commandIds.push("c:new");
  assert.match(failsOnly("access-probes", added, "policy-unchanged"), /new commands: c:new/);
  const unlisted = clone(passing()["access-probes"]);
  delete unlisted.bucketBefore;
  assert.match(failsOnly("access-probes", unlisted, "drive-bucket-unchanged"), /not observed/);
  // The forged session is shaped like Policy's, and isn't the malformed one.
  const parts = C.forgedSession().split(".");
  assert.equal(parts.length, 3);
  assert.equal(JSON.parse(Buffer.from(parts[0], "base64url")).alg, "ES256");
  assert.equal(JSON.parse(Buffer.from(parts[1], "base64url")).fg, 1);
  assert.notEqual(C.ACCESS_PROBE_MALFORMED_SESSION, C.forgedSession());
});

test("a failed phase exits nonzero: any failed check, or any failed read", () => {
  const all = passing();
  assert.equal(C.phaseExitCode({ phase: "access-probes", observations: all["access-probes"] }), 0);
  const failing = clone(all["access-probes"]);
  failing.compilers.l0013r["no-identity"] = { status: 200, body: { status: "success", data: { manifest: {} } } };
  assert.equal(C.phaseExitCode({ phase: "access-probes", observations: failing }), 1);
  assert.equal(C.phaseExitCode({ phase: "checks", observations: { ...all.checks, errors: { "env:api": "403" } } }), 1);
  for (const p of DRIVE_PHASES.filter(x => !C.PARTIAL_PHASES.includes(x))) assert.equal(C.phaseExitCode({ phase: p, observations: all[p] }), 0, p);
  // Phases judged in parts, or that judge nothing themselves: a failed read fails them.
  for (const p of [...C.PARTIAL_PHASES, "resolve-journal", "resolve-intent", "drop-outcome-retry"]) {
    assert.equal(C.phaseExitCode({ phase: p, observations: { errors: {} } }), 0, p);
    assert.equal(C.phaseExitCode({ phase: p, observations: { errors: { resolution: "refused" } } }), 1, p);
  }
});

// The answer run 0aa69b9a saved for first-public.
const PREFLIGHT_UNAVAILABLE_ANSWER = {
  task: "task-public",
  sentAt: "2026-11-19T23:10:00.000Z",
  answeredAt: "2026-11-19T23:10:02.000Z",
  status: 200,
  failure: null,
  body: { status: "success", data: { errors: [{ message: "Error: preflight of s0 failed (403)", from: -1, to: -1, code: "preflight-unavailable", category: "temporary" }] } },
};

test("the bridge's pre-allocation codes are exactly its refusals before run(true)", () => {
  const source = readFileSync(new URL("../../packages/api/src/commands/bridge.js", import.meta.url), "utf8");
  const allocating = source.indexOf("ran = await run(true)");
  assert.ok(allocating > 0);
  for (const code of C.BRIDGE_PRE_ALLOCATION_CODES) {
    const at = source.indexOf(`"${code}"`);
    assert.ok(at > 0 && at < allocating, `${code} is returned before run(true)`);
  }
  // Not listed: refusals that may follow an allocating call.
  assert.ok(source.lastIndexOf("\"legacy-protocol\"") > allocating);
  assert.ok(!C.BRIDGE_PRE_ALLOCATION_CODES.includes("legacy-protocol"));
  assert.equal(C.BRIDGE_SOURCE, "packages/api/src/commands/bridge.js");
});

test("resolve-intent: a saved bridge pre-allocation answer resolves the intent, the evidence preserved; a candidate or an unlisted code refuses", () => {
  const answer = clone(PREFLIGHT_UNAVAILABLE_ANSWER);
  const before = JSON.stringify(answer);
  assert.equal(C.bridgePreAllocationCode({ status: answer.status, body: answer.body }), "preflight-unavailable");
  const { resolution } = C.preAllocationResolution({ name: "first-public", answer, candidates: [] });
  assert.deepEqual(resolution, {
    commandId: null,
    noAllocation: { kind: "pre-allocation-answer", code: "preflight-unavailable", answeredAt: answer.answeredAt, evidence: "first-public.ambiguous.json", source: "packages/api/src/commands/bridge.js" },
  });
  assert.equal(JSON.stringify(answer), before, "the saved answer is never changed");
  // The inventory accepts it; the .ambiguous.json stays as evidence beside it.
  const j = (file, value) => ({ file, value });
  const journal = [j("first-public.json", { kind: "anonymous", task: answer.task, sentAt: answer.sentAt, commandId: null }), j("first-public.ambiguous.json", answer), j("first-public.id.json", resolution)];
  assert.deepEqual(C.inventory({ plan: { ids: {} }, journal, manifests: [] }).unresolvedIntents, []);
  // A candidate in Policy since it was sent refuses it.
  const late = { commandId: `c:${"9".repeat(64)}`, uid: "anonymous", taskId: answer.task, createdAt: "2026-11-19T23:11:00.000Z" };
  assert.match(C.preAllocationResolution({ name: "first-public", answer, candidates: [late] }).problem, /Policy holds anonymous commands/);
  assert.match(C.preAllocationResolution({ name: "first-public", answer, candidates: undefined }).problem, /not observed/);
  // An unlisted code, a command in the answer, or more than one error: no resolution.
  for (const code of ["legacy-protocol", "rate-limited", "command-not-completed", "not-owner"]) {
    const other = clone(answer);
    other.body.data.errors[0].code = code;
    assert.match(C.preAllocationResolution({ name: "x", answer: other, candidates: [] }).problem, /no bridge pre-allocation code/, code);
  }
  const named = clone(answer);
  named.body.data.command = { commandId: late.commandId };
  assert.match(C.preAllocationResolution({ name: "x", answer: named, candidates: [] }).problem, /no bridge pre-allocation code/);
  const non200 = { ...clone(answer), status: 500 };
  assert.match(C.preAllocationResolution({ name: "x", answer: non200, candidates: [] }).problem, /no bridge pre-allocation code/);
  // A forged noAllocation of this kind isn't accepted: wrong code, wrong source, no evidence.
  for (const forged of [
    { ...resolution.noAllocation, code: "legacy-protocol" },
    { ...resolution.noAllocation, source: "elsewhere.js" },
    { ...resolution.noAllocation, evidence: null },
    { ...resolution.noAllocation, answeredAt: "garbage" },
  ]) {
    assert.deepEqual(C.inventory({ plan: { ids: {} }, journal: [journal[0], j("first-public.id.json", { commandId: null, noAllocation: forged })], manifests: [] }).unresolvedIntents, ["first-public.json"]);
  }
  // An empty query alone still never resolves.
  assert.deepEqual(C.correlateIntents({ intents: [{ name: "first-public", task: answer.task, sentAt: answer.sentAt }], commands: [], claimed: [] }), {});
});

test("anonymousCompile's answer-time resolution recognizes a bridge pre-allocation answer, with its evidence", () => {
  const a = PREFLIGHT_UNAVAILABLE_ANSWER;
  assert.deepEqual(C.answerResolution({ status: a.status, body: a.body, answeredAt: a.answeredAt, evidence: "first-public.answer.json" }), {
    commandId: null,
    noAllocation: { kind: "pre-allocation-answer", code: "preflight-unavailable", answeredAt: a.answeredAt, evidence: "first-public.answer.json", source: "packages/api/src/commands/bridge.js" },
  });
  // Without its evidence and time, it stays ambiguous.
  assert.equal(C.answerResolution({ status: a.status, body: a.body }), null);
  assert.equal(C.journalAnswerName("first-public"), "first-public.answer.json");
});

test("Step 32's correction: public compilers with allUsers, the access probes, closing access before parking, and the aborted run's successor", () => {
  const doc = readFileSync(new URL("../../docs/capability-policy-iam-review.md", import.meta.url), "utf8");
  const step32 = doc.slice(doc.indexOf("### Step 32:"), doc.indexOf("### Step 33:"));
  assert.match(step32, /\*\*Correction \(2026-11-20\)/);
  assert.match(step32, /\| `l0013r-c5d-drive` \| `allUsers`, `api-run`[^|]*, `deploy-smoke` \|/);
  assert.match(step32, /\| `l0176r-c5d-drive` \| `allUsers`, `api-run`, `deploy-smoke` \|/);
  assert.equal((step32.match(/add-iam-policy-binding "\$s" --project=graffiticode --region=us-central1 --member=allUsers --role=roles\/run.invoker/g) ?? []).length, 1);
  assert.match(step32, /remove-iam-policy-binding "\$s" --project=graffiticode --region=us-central1 --member=allUsers --role=roles\/run.invoker/);
  const teardown = step32.slice(step32.indexOf("#### 8."));
  assert.ok(teardown.indexOf("--member=allUsers") < teardown.indexOf("--tag=parked"), "access closed before parking");
  assert.match(step32, /--phase access-probes/);
  for (const probe of C.ACCESS_PROBES) assert.ok(step32.includes(`\`${probe}\``), probe);
  assert.match(step32, /#### 9\. An aborted run and its successor/);
  assert.match(step32, /--phase resolve-intent --run 0aa69b9a --name first-public/);
  // Both deletions stay, and every step is still held.
  assert.equal((step32.match(/gcloud storage rm 'gs:\/\/graffiticode-command-staging\//g) ?? []).length, 2);
  assert.match(step32, /HELD/);
});

// Step 32 live run, 2026-11-20: resolve-intent wrote its resolution, then
// finish() threw ("no such phase resolve-intent") and no manifest was written.
// Every phase the CLI ends with finish() must have a manifest name.
test("every CLI phase that writes a manifest has a manifest name", () => {
  const src = readFileSync(new URL("../c5d-drive.js", import.meta.url), "utf8");
  const blocks = src.split(/\nif \(phase === "/).slice(1).map(b => ({ phase: b.slice(0, b.indexOf("\"")), body: b }));
  const writing = blocks.filter(b => /\bfinish\(/.test(b.body)).map(b => b.phase);
  assert.ok(writing.includes("resolve-intent") && writing.includes("cleanup") && writing.length > 15, JSON.stringify(writing));
  const stamp = C.stampOf(new Date("2026-11-20T00:00:00Z"));
  for (const phase of writing) assert.doesNotThrow(() => C.phaseFile(phase, stamp), phase);
});

test("a rerun of resolve-intent confirms an unchanged resolution and rewrites nothing", () => {
  const noAllocation = { kind: "pre-allocation-answer", code: "preflight-unavailable", answeredAt: "2026-11-19T23:26:15.905Z", evidence: "first-public.ambiguous.json", source: "packages/api/src/commands/bridge.js" };
  const recorded = { at: "2026-11-20T00:25:16.709Z", commandId: null, noAllocation };
  assert.deepEqual(C.confirmResolution({ recorded, recomputed: { commandId: null, noAllocation: { ...noAllocation } } }), { confirmed: true });
  assert.match(C.confirmResolution({ recorded, recomputed: { commandId: null, noAllocation: { ...noAllocation, code: "bridge-retired" } } }).problem, /differs/);
  assert.match(C.confirmResolution({ recorded, recomputed: null }).problem, /no resolution/);
  assert.match(C.confirmResolution({ recorded: { commandId: null }, recomputed: recorded }).problem, /no noAllocation/);
});
