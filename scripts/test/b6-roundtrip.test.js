// The B6 repair round-trip's Broker verdict (scripts/lib/b6-drive-checks.js
// roundtripBrokerProblems), offline. The fixture is the 4fe391 run's own
// Broker evidence (production api-rmwkxlbvy-b5fa92, 2026-11-18): the
// narrowing landed after Broker claimed B's receipt, before any dispatch.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { roundtripBrokerProblems, roundtripOperations, ROUNDTRIP_B_REFUSAL } from "../lib/b6-drive-checks.js";

const STEPS = ["questions", "items"];
const evidence = JSON.parse(readFileSync(new URL("./fixtures/b6-roundtrip-4fe391.json", import.meta.url), "utf8"));
const fresh = () => roundtripOperations(structuredClone(evidence));
const judge = operations => roundtripBrokerProblems({ operations, registeredSteps: STEPS });
const rejects = (mutate, pattern) => {
  const ops = fresh();
  mutate(ops);
  const problems = judge(ops);
  assert.ok(problems.some(p => pattern.test(p)), `expected ${pattern}, got ${JSON.stringify(problems)}`);
};

test("4fe391: B's receipt claimed, definitively failed before any dispatch, is accepted", () => {
  const ops = fresh();
  assert.equal(ops["B, original"].receipt.outcome.status, "failed");
  assert.deepEqual(ops["B, original"].audit.map(e => [e.event, e.outcome, e.reason]), [["execute", "failed", ROUNDTRIP_B_REFUSAL]]);
  assert.deepEqual(judge(ops), []);
});

test("B refused before Broker (97c038's shape: no receipt, no record) is accepted", () => {
  const ops = fresh();
  ops["B, original"] = { receipt: null, audit: [] };
  assert.deepEqual(judge(ops), []);
});

test("missing evidence is never a pass", () => {
  rejects(o => { o["B, original"].receipt = undefined; }, /B, original: its Broker receipt wasn't read/);
  rejects(o => { o["A, repair"].audit = undefined; }, /A, repair: its Broker audit wasn't read/);
  rejects(o => { delete o["B, repair"]; }, /B, repair: its Broker receipt wasn't read/);
  assert.deepEqual(roundtripBrokerProblems({ operations: fresh(), registeredSteps: [] }), ["the operation's registered dispatch steps weren't given"]);
});

test("an uncertain or other outcome for B is rejected", () => {
  rejects(o => { o["B, original"].receipt.outcome = null; }, /claimed, with no final outcome \(uncertain\)/);
  rejects(o => { o["B, original"].receipt.outcome.status = "uncertain"; }, /final outcome uncertain, expected failed/);
  rejects(o => { o["B, original"].receipt.outcome.status = "succeeded"; }, /final outcome succeeded, expected failed/);
  rejects(o => { o["B, original"].audit[0].reason = "authorization-denied:connection-revoked"; }, /expected failed authorization-denied:not-granted/);
  rejects(o => { o["B, original"].receipt.outcome.steps = ["questions"]; }, /lists completed steps/);
  rejects(o => { o["B, original"].receipt.steps = [{ n: 0, step: "questions" }]; }, /has step records/);
  rejects(o => { o["B, original"].audit = []; }, /0 execute records, expected exactly one/);
  rejects(o => { o["B, original"] = { receipt: null, audit: [{ service: "broker", event: "execute", outcome: "failed", reason: ROUNDTRIP_B_REFUSAL }] }; }, /no receipt, but Broker recorded/);
});

test("extra claims are rejected", () => {
  rejects(o => { o["B, original"].audit.push({ ...o["B, original"].audit[0] }); }, /2 execute records, expected exactly one/);
  rejects(o => { o["A, original"].audit.push({ service: "broker", event: "execute", outcome: "allowed" }); }, /A, original: execute records \["allowed","allowed"\]/);
  rejects(o => { o["A, repair"].receipt = { claim: { operationId: "x" }, outcome: null, steps: [], attempts: 0 }; }, /A, repair: has a Broker receipt/);
  rejects(o => { o["A, repair"].audit.push({ service: "broker", event: "execute", outcome: "allowed" }); }, /A, repair: has 1 Broker record/);
  rejects(o => { o["B, repair"].receipt = null; }, /B, repair: no Broker receipt/);
});

test("dispatches: each registered step exactly once for A and repaired B, none for original B", () => {
  rejects(o => { o["A, original"].audit.push({ service: "broker", event: "execute-step", outcome: "allowed", purpose: "dispatch", step: "items" }); }, /A, original: dispatched items 2 time\(s\)/);
  rejects(o => { o["B, repair"].audit = o["B, repair"].audit.filter(e => e.step !== "questions"); }, /B, repair: dispatched questions 0 time\(s\)/);
  rejects(o => { o["B, repair"].audit.push({ service: "broker", event: "execute-step", outcome: "allowed", purpose: "dispatch", step: "activities" }); }, /unregistered step activities/);
  rejects(o => { o["B, original"].audit.push({ service: "broker", event: "execute-step", outcome: "allowed", purpose: "dispatch", step: "questions" }); }, /B, original: dispatched \["questions"\]/);
  rejects(o => { o["A, original"].receipt.outcome.status = "failed"; }, /A, original: final outcome failed, expected succeeded/);
  rejects(o => { o["B, repair"].receipt.steps = [{ n: 0, step: "questions" }]; }, /B, repair: step records \["questions"\]/);
  rejects(o => { o["A, original"].audit[0].service = "broker-faults"; }, /an audit record from broker-faults/);
});
