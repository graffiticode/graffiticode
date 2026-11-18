// The C5a gate's L0176 compatibility evidence (scripts/lib/c5a-evidence-checks.js),
// offline. The fixture is what the producers read on 2026-11-18 (run r36074e):
// three recorded v2 plans constructed at Policy 2ce14335 (pre-C5a) and
// f6132821 (serving), artifact inv-4f96721e (made by api-rmwh6ru3u, registry 8)
// with the api's serving windows, and canary command c:0f8fc69b's plan.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planDigest } from "@graffiticode/common/contract";
import { v2DigestProblems, v8ProvenanceProblems, v8ReadProblems, addedFields, registryVersionsObservation } from "../lib/c5a-evidence-checks.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/c5a-evidence.json", import.meta.url), "utf8"));
const v2 = () => structuredClone(fixture.v2);
const matches = (problems, pattern) => assert.ok(problems.some(p => pattern.test(p)), `expected ${pattern}, got ${JSON.stringify(problems)}`);

test("v2: both commits construct exactly the recorded plans and digests", () => {
  const cases = v2();
  assert.equal(cases.length, 3);
  for (const c of cases) {
    assert.equal(c.before.registryVersion, 8);
    assert.equal(c.after.registryVersion, 9);
    assert.equal(planDigest(c.recorded.plan), c.recorded.digest);
  }
  assert.deepEqual(v2DigestProblems(cases), []);
});

test("v2: a refusal, another digest, another invocation or another plan is never identical", () => {
  assert.deepEqual(v2DigestProblems([]), ["no recorded plan was constructed"]);
  let c = v2();
  c[0].before = { admitted: false, refusal: "registry-version-mismatch" };
  matches(v2DigestProblems(c), /refused before \(registry-version-mismatch\)/);
  c = v2();
  c[1].after.planDigest = "f".repeat(64);
  matches(v2DigestProblems(c), /after constructed f{64}/);
  matches(v2DigestProblems(c), /before .* and after .* differ/);
  c = v2();
  c[2].before.invocationId = "inv-00000000-0000-0000-0000-000000000000";
  matches(v2DigestProblems(c), /before used invocation inv-0{8}/);
  c = v2();
  c[0].after.plan = { ...c[0].after.plan, registryVersion: 9 };
  matches(v2DigestProblems(c), /after's plan differs from the recorded plan/);
  c = v2();
  c[0].before.recomputed = "e".repeat(64);
  matches(v2DigestProblems(c), /before's stored plan digests to e{64}/);
  c = v2();
  delete c[1].after;
  matches(v2DigestProblems(c), /not constructed after/);
});

const provenance = () => structuredClone(fixture.provenance);
test("v8 provenance: made while only a registry-8 api served, registry-8 plan, intact, still current", () => {
  const p = provenance();
  assert.deepEqual(v8ProvenanceProblems({ provenance: p, apiWindows: p.apiWindows }), []);
});

test("v8 provenance: any gap in the chain is refused", () => {
  const judge = mutate => {
    const p = provenance();
    mutate(p);
    return v8ProvenanceProblems({ provenance: p, apiWindows: p.apiWindows });
  };
  matches(judge(p => { p.artifact.registryVersion = 9; }), /binds registry 9/);
  matches(judge(p => { p.artifact.recomputedDigest = "0".repeat(64); }), /doesn't digest to its recorded contentDigest/);
  matches(judge(p => { p.head.invocationId = "inv-other"; }), /head names another invocation/);
  matches(judge(p => { p.plan.registryVersion = 9; }), /its plan is registry 9/);
  // A registry-9 api's artifact binds 8 for L0176 too: only the serving window tells them apart.
  matches(judge(p => { p.artifact.createdAt = "2026-11-18T19:25:16.211Z"; }), /api-rmwkxlbvy-b5fa92 \(registry 9\) was serving/);
  matches(judge(p => { p.apiWindows.push({ revision: "api-x", registryVersion: 8, from: "2026-11-16T00:00:00Z", until: "2026-11-17T00:00:00Z" }); }), /2 api revisions were serving/);
  matches(judge(p => { p.apiWindows = []; }), /0 api revisions were serving/);
  assert.deepEqual(v8ProvenanceProblems({ provenance: null, apiWindows: [] }), ["the artifact wasn't read"]);
});

// The live read's shapes: GET /data's envelope ({ status, data: { data, errors } })
// over the stored activity, re-signed per view.
const stored = { data: { type: "string", data: { id: "item-1", name: "graffiticode-canary", questions: [{ type: "mcq" }] } }, errors: [] };
const state = (over = {}) => ({ binding: { uid: "u", ownerUid: "u", connectionId: "c", taskId: "t", invocationId: "inv-1", seq: 1, registryVersion: 8 }, contentDigest: "d1", updateTime: "2026-11-16T18:27:13.990219Z", head: { invocationId: "inv-1", seq: 1 }, ...over });
const read = (over = {}) => ({
  before: state(),
  after: state(),
  stored,
  served: { status: 200, body: { status: "success", data: { data: { ...stored.data, request: { signed: true } }, errors: [] } } },
  broker: [{ event: "execute-step", purpose: "sign", step: "sign", op: "learnosity.sign-items-preview" }],
  ...over,
});

test("v8 read: served unchanged, re-signed, with no dispatch, passes", () => {
  assert.deepEqual(v8ReadProblems(read()), []);
  assert.deepEqual(addedFields(stored, read().served), ["request"]);
});

test("v8 read: a changed artifact, a refused or different view, or any dispatch fails", () => {
  matches(v8ReadProblems(read({ after: state({ contentDigest: "d2" }) })), /content digest changed/);
  matches(v8ReadProblems(read({ after: state({ updateTime: "2026-11-18T20:00:00Z" }) })), /document was rewritten/);
  matches(v8ReadProblems(read({ after: state({ binding: { ...state().binding, seq: 2 } }) })), /bindings changed/);
  matches(v8ReadProblems(read({ after: state({ head: { invocationId: "inv-2", seq: 2 } }) })), /head moved/);
  matches(v8ReadProblems(read({ served: { status: 500, body: null } })), /answered 500/);
  matches(v8ReadProblems(read({ served: { status: 200, body: { data: { data: null, errors: [{ code: "artifact-incompatible" }] } } } })), /\["artifact-incompatible"\]/);
  matches(v8ReadProblems(read({ served: { status: 200, body: { data: { data: { ...stored.data, data: { ...stored.data.data, name: "other" } }, errors: [] } } } })), /isn't the stored one/);
  matches(v8ReadProblems(read({ broker: [{ event: "execute-step", purpose: "dispatch", step: "items", op: "learnosity.write-items" }] })), /dispatched \["learnosity.write-items:items"\]/);
  matches(v8ReadProblems(read({ broker: undefined })), /Broker's audit wasn't read/);
  assert.deepEqual(v8ReadProblems(read({ before: null })), ["the artifact wasn't read before and after"]);
});

test("registry versions: the canary command's stored plan, digest verified, L0185 0 beside L0176 9", () => {
  const { command, revisions, stages } = structuredClone(fixture.registry);
  const planDoc = { revisions, plan: { stages } };
  const obs = registryVersionsObservation({ command, planDoc, digest: command.admission.planDigest });
  assert.deepEqual(obs.problems, []);
  assert.equal(obs.l0185RegistryVersion, 0);
  assert.equal(obs.l0176RegistryVersion, 9);
  assert.deepEqual(obs.revisions, ["l0176r-rmwk08k8n-c74227", "l0185r-rmwczv08x-e43ac0"]);
  matches(registryVersionsObservation({ command, planDoc, digest: "0".repeat(64) }).problems, /digests to 0{64}/);
  matches(registryVersionsObservation({ command, planDoc: { revisions, plan: { stages: stages.filter(s => s.lang !== "0185") } }, digest: command.admission.planDigest }).problems, /0 L0185 stages/);
  matches(registryVersionsObservation({ command: { commandId: "c:x", admission: {} }, planDoc: null, digest: null }).problems, /no admitted plan/);
});
