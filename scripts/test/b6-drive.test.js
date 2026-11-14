// The B6 drive's verdicts (scripts/lib/b6-drive-checks.js), offline: the
// owner's review of #390 found each of these could pass on bad evidence.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MANDATORY_PHASES, phaseProblems, artifactPresent, savedReferences, lrnIdOf, sourceProblems, lowerRebuildProblems, dispatchProblems, auditByOperation,
} from "../lib/b6-drive-checks.js";

test("GET /data's real envelope: a missing artifact is absent, a saved one present", () => {
  assert.equal(artifactPresent({ status: 200, json: { status: "success", data: { errors: [{ code: "artifact-not-found", message: "not saved" }] } } }), false);
  assert.equal(artifactPresent({ status: 404, json: { data: null } }), false);
  assert.equal(artifactPresent({ status: 200, json: { status: "success", data: { data: null, errors: [] } } }), false);
  assert.equal(artifactPresent({ status: 200, json: { status: "success", data: { data: { tag: "saved" }, errors: [] } } }), true);
});

test("the report needs every mandatory phase's latest run to have passed", () => {
  const all = MANDATORY_PHASES.map(phase => ({ phase, ok: true }));
  assert.deepEqual(phaseProblems(all), []);
  assert.deepEqual(phaseProblems([...all, { phase: "probes", ok: false }]), ["probes: its latest run didn't pass"]);
  // A failed run fixed by a later pass is fine; a missing phase isn't.
  assert.deepEqual(phaseProblems([{ phase: "probes", ok: false }, ...all]), []);
  assert.deepEqual(phaseProblems(all.filter(r => r.phase !== "boundary")), ["boundary: never ran"]);
  assert.deepEqual(phaseProblems([]).length, MANDATORY_PHASES.length);
});

// One original with occurrence `a` failed by fail-write, repaired.
const audited = entries => auditByOperation(entries, ["inv-orig/s0/a", "inv-repair/s0/a"]);
const ops = audit => [
  { occurrence: "orig s0 a", opid: "inv-orig/s0/a", kind: "original", outcome: "failed", source: "receipt", audit: audit.get("inv-orig/s0/a") },
  { occurrence: "orig s0 a", opid: "inv-repair/s0/a", kind: "repair", outcome: "completed", source: "receipt", audit: audit.get("inv-repair/s0/a") },
];
const CLEAN = [
  { jsonPayload: { event: "execute", outcome: "failed", opid: "inv-orig/s0/a" } },
  { jsonPayload: { event: "execute", outcome: "allowed", opid: "inv-repair/s0/a" } },
  { jsonPayload: { event: "execute-step", purpose: "dispatch", step: "questions", opid: "inv-repair/s0/a" } },
  { jsonPayload: { event: "execute-step", purpose: "dispatch", step: "items", opid: "inv-repair/s0/a" } },
];

test("dispatch evidence: one claim per receipt, a dispatch per completed write, each step once", () => {
  assert.deepEqual(dispatchProblems(ops(audited(CLEAN))), []);
  // Missing logs are a failure, not a pass.
  assert.ok(dispatchProblems(ops(audited([]))).some(p => p.includes("claim(s), expected 1")));
  assert.ok(dispatchProblems(ops(audited([]))).some(p => p.includes("no dispatch evidence")));
  assert.ok(dispatchProblems([{ occurrence: "x", opid: "x", kind: "original", outcome: "completed", source: "receipt", audit: undefined }]).some(p => p.includes("no audit read")));
  // The same step twice under one operation id.
  const twice = [...CLEAN, { jsonPayload: { event: "execute-step", purpose: "dispatch", step: "questions", opid: "inv-repair/s0/a" } }];
  assert.ok(dispatchProblems(ops(audited(twice))).some(p => p.includes("step questions dispatched 2 times")));
  // Two claims of one operation.
  const claimedTwice = [...CLEAN, { jsonPayload: { event: "execute", outcome: "allowed", opid: "inv-repair/s0/a" } }];
  assert.ok(dispatchProblems(ops(audited(claimedTwice))).some(p => p.includes("2 claim(s)")));
  // A replay or the maintenance canary's note isn't a claim.
  const replayed = [...CLEAN, { jsonPayload: { event: "execute", outcome: "replayed", opid: "inv-repair/s0/a" } }, { jsonPayload: { event: "execute", outcome: "allowed", reason: "canary-during-maintenance", opid: "inv-repair/s0/a" } }];
  assert.deepEqual(dispatchProblems(ops(audited(replayed))), []);
});

test("dispatch evidence: a failed write dispatched nothing, an answered occurrence has no operation, and an occurrence dispatches under one id", () => {
  const failedDispatched = [...CLEAN, { jsonPayload: { event: "execute-step", purpose: "dispatch", step: "questions", opid: "inv-orig/s0/a" } }];
  const problems = dispatchProblems(ops(audited(failedDispatched)));
  assert.ok(problems.some(p => p.includes("a failed write with 1 dispatch")));
  assert.ok(problems.some(p => p.includes("dispatched under 2 operation ids")));
  const answered = auditByOperation([{ jsonPayload: { event: "execute", outcome: "allowed", opid: "inv-repair/s0/b" } }], ["inv-repair/s0/b"]);
  assert.ok(dispatchProblems([{ occurrence: "orig s0 b", opid: "inv-repair/s0/b", kind: "answered", audit: answered.get("inv-repair/s0/b") }])[0].includes("answered from its record"));
  // Refused by Policy: no claim expected, and none found.
  const refused = auditByOperation([], ["inv-orig/s0/c"]);
  assert.deepEqual(dispatchProblems([{ occurrence: "orig s0 c", opid: "inv-orig/s0/c", kind: "original", outcome: "failed", source: "policy-refusal", audit: refused.get("inv-orig/s0/c") }]), []);
});

test("source evidence: every saved reference was sent under exactly the recorded tag", () => {
  const ref = (lrn, n = 0) => `gc-0123456789abcdef-graffiticode-${lrn}-${n}`;
  assert.equal(lrnIdOf(ref("b6drive-x-old")), "b6drive-x-old");
  const recorded = JSON.stringify({ data: { tag: "b6drive-x-old" }, errors: [] });
  const artifact = tag => ({ saved: true, references: [ref(tag)] });
  assert.deepEqual(sourceProblems({ recordedOutputText: recorded, artifact: artifact("b6drive-x-old"), oldTag: "b6drive-x-old" }), []);
  // The successor's tag starts with the old one: still a failure.
  assert.ok(sourceProblems({ recordedOutputText: recorded, artifact: artifact("b6drive-x-old-changed"), oldTag: "b6drive-x-old" }).length > 0);
  // Unrelated content, or nothing saved.
  assert.ok(sourceProblems({ recordedOutputText: recorded, artifact: { tag: "WRONG-SOURCE" }, oldTag: "b6drive-x-old" }).some(p => p.includes("no saved reference")));
  // The recorded output must itself be the old content.
  assert.ok(sourceProblems({ recordedOutputText: JSON.stringify({ data: { tag: "new" } }), artifact: artifact("b6drive-x-old"), oldTag: "b6drive-x-old" })[0].includes("recorded L0185 output"));
  assert.deepEqual(savedReferences({ a: [{ saved: true, references: ["r1"] }], b: { saved: false, references: ["r2"] } }), ["r1"]);
});

test("the lower stage's rebuild is logged under the original, the head's run under the repair", () => {
  const originalLines = ["command orig: call materialize s1 L0176 at https://compiler"];
  const repairLines = ["command repair: call start s0 L0176 at https://compiler (repair, with its recorded occurrences)"];
  assert.deepEqual(lowerRebuildProblems({ originalLines, repairLines }), []);
  assert.deepEqual(lowerRebuildProblems({ originalLines: [], repairLines }), ["no `call materialize s1` under the original"]);
  assert.ok(lowerRebuildProblems({ originalLines, repairLines: [...repairLines, "command repair: call start s1 L0176 at https://compiler"] }).includes("the lower stage was started"));
});
