import test from "node:test";
import assert from "node:assert/strict";
import { countStageRecords, createTally, evaluateGate, finishCorpus, parseStageLine, percentile, recordCorpusRun, THRESHOLDS } from "../lib/interpret-soak.js";

test("percentile is nearest-rank, and null for no values", () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
  assert.equal(percentile([3, 1, 2, NaN], 50), 2);
});

test("stage lines parse; other lines don't", () => {
  assert.deepEqual(parseStageLine("stage {\"run\":\"interpret\",\"lang\":\"0184\"}"), { run: "interpret", lang: "0184" });
  assert.equal(parseStageLine("chain: a no-store stage"), null);
  assert.equal(parseStageLine("stage {not json"), null);
});

test("stage records count per language: cache, kind and outcome; legacy and other languages ignored", () => {
  const counts = countStageRecords([
    { run: "interpret", lang: "0184", cache: "miss", kind: "value" },
    { run: "interpret", lang: "L0184", cache: "hit", kind: "plan" },
    { run: "interpret", lang: "0184", cache: "skip", outcome: "model-unavailable" },
    { run: "legacy", lang: "0184", cache: "skip" },
    { run: "interpret", lang: "0999", cache: "miss" },
  ], ["0184"]);
  assert.deepEqual(counts, { "0184": { hit: 1, miss: 1, skip: 1, kinds: { value: 1, plan: 1 }, outcomes: { "model-unavailable": 1 } } });
});

// A tally that meets every threshold for one value-and-plan language.
const passing = () => {
  const t = createTally(["0184"]);
  const p = t.per["0184"];
  p.misses = THRESHOLDS.misses;
  p.hits = THRESHOLDS.hits;
  p.kinds = { value: 600, plan: 600 };
  for (let i = 0; i < 4; i++) for (let r = 0; r < 3; r++) recordCorpusRun(t, "0184", i);
  finishCorpus(t, "0184", 4);
  p.latency = { miss: [100, 120], hit: [50, 60], direct: [20, 30] };
  t.legacy.latency = [100, 110];
  for (const s of Object.keys(t.chains)) t.chains[s] = 200;
  t.requests = 10000;
  t.concurrent.requests = 2500;
  t.viewLoop.immutable = 5;
  t.viewLoop.staleNoStore = 5;
  return t;
};
const logs = { "0184": { hit: 1950, miss: 2400, skip: 0, kinds: { value: 700, plan: 700 }, outcomes: {} } };

test("a drive that meets every criterion passes, with the rehearsal recorded", () => {
  const v = evaluateGate({ tally: passing(), logCounts: logs, kindsByLang: { "0184": ["value", "plan"] }, inputReaders: ["0184"], rehearsal: { passed: true } });
  assert.deepEqual(v.checks.filter(c => !c.pass).map(c => c.name), []);
  assert.equal(v.passed, true);
});

test("each shortfall fails its own check", () => {
  const fail = (mutate, logCounts = logs) => {
    const t = passing();
    mutate(t);
    return evaluateGate({ tally: t, logCounts, kindsByLang: { "0184": ["value", "plan"] }, inputReaders: ["0184"], rehearsal: { passed: true } }).checks.filter(c => !c.pass).map(c => c.name);
  };
  assert.deepEqual(fail(t => { t.per["0184"].misses = 10; }), ["L0184: 2000 fresh interpretations"]);
  assert.deepEqual(fail(t => { t.per["0184"].kinds.value = 10; }), ["L0184: 500 value executions"]);
  assert.deepEqual(fail(t => { t.per["0184"].corpus.minRuns = 2; }), ["L0184: every corpus case run 3 times"]);
  assert.deepEqual(fail(t => { t.per["0184"].mismatches.push({ case: 1 }); }), ["L0184: every answer equals its oracle"]);
  assert.deepEqual(fail(t => { t.per["0184"].latency.hit = [1000]; }), ["L0184: hit p95 within budget"]);
  // The budget is the legacy path's; without a baseline there is none, and both latency checks fail.
  assert.deepEqual(fail(t => { t.legacy.latency = []; }), ["L0184: miss p95 within budget", "L0184: hit p95 within budget"]);
  assert.deepEqual(fail(t => { t.chains["view-loop"] = 5; }), ["chain view-loop: 200 runs"]);
  assert.deepEqual(fail(t => { t.concurrent.requests = 100; }), ["20% of the drive at concurrency 16+ on one key"]);
  assert.deepEqual(fail(t => { t.retried = 50; }), ["transient retries at most 0.1%"]);
  assert.deepEqual(fail(t => { t.concurrent.divergent.push("x"); }), ["concurrent answers for one key are identical"]);
  // From the logs: too few hits for the repeats sent, and an unexpected failure code.
  assert.deepEqual(fail(() => {}, { "0184": { ...logs["0184"], hit: 1000 } }), ["L0184: repeats hit 95%"]);
  assert.deepEqual(fail(() => {}, { "0184": { ...logs["0184"], outcomes: { "no-store-intermediate": 1 } } }), ["L0184: no unexpected failure outcomes"]);
});

test("a language is held only to the kinds its corpus produces", () => {
  const t = passing();
  t.per["0184"].kinds = { value: 600, plan: 0 };
  const names = kinds => evaluateGate({ tally: t, kindsByLang: { "0184": kinds }, inputReaders: ["0184"], rehearsal: { passed: true } }).checks.filter(c => !c.pass).map(c => c.name);
  assert.deepEqual(names(["value"]), []);
  assert.deepEqual(names(["value", "plan"]), ["L0184: 500 plan executions"]);
});

test("without an input-reading language, or without the rehearsal, the gate doesn't pass", () => {
  assert.equal(evaluateGate({ tally: passing(), logCounts: logs, kindsByLang: { "0184": ["value", "plan"] }, inputReaders: ["0179"], rehearsal: { passed: true } }).passed, false);
  assert.equal(evaluateGate({ tally: passing(), logCounts: logs, kindsByLang: { "0184": ["value", "plan"] }, inputReaders: ["0184"] }).passed, false);
});
