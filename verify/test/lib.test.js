import test from "node:test";
import assert from "node:assert/strict";
import { protectedExecutionState, request } from "../lib.js";

const GFE_404 = "\n<html><head>\n<title>404 Page not found</title>\n</head>\n<body><h1>Error: Page not found</h1></body></html>";
const base = new URL("https://tag---svc.run.app");
const sequence = responses => {
  const calls = [];
  const fetch = async url => { calls.push(url.href); const [status, body] = responses.shift(); return new Response(body, { status }); };
  return { fetch, calls };
};

test("retries a front-end routing 404 until the candidate answers", async () => {
  const { fetch, calls } = sequence([[404, GFE_404], [404, GFE_404], [400, JSON.stringify({ error: { message: "bad" } })]]);
  const res = await request({ fetch, base, path: "/task", method: "POST", body: {}, sleep: async () => {} });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.message, "bad");
  assert.equal(res.attempts, 3);
  assert.equal(calls.length, 3);
});

test("never retries the service's own 404, or any other status", async () => {
  for (const [status, body] of [[404, JSON.stringify({ error: { code: 404, message: "" } })], [500, GFE_404], [403, "nope"]]) {
    const { fetch, calls } = sequence([[status, body]]);
    const res = await request({ fetch, base, path: "/data", sleep: async () => {} });
    assert.equal(res.status, status);
    assert.equal(calls.length, 1);
  }
});

test("gives up after the retry budget and returns the routing 404", async () => {
  const { fetch, calls } = sequence(Array.from({ length: 10 }, () => [404, GFE_404]));
  const res = await request({ fetch, base, path: "/", sleep: async () => {} });
  assert.equal(res.status, 404);
  assert.equal(calls.length, 7);
});

test("reports the candidate's protected-execution state, and checks it when the operator names one", async () => {
  const ctx = state => ({ fetch: async () => new Response(JSON.stringify(state), { status: 200 }), candidateUrl: base, headers: {}, log: () => {} });
  assert.deepEqual(await protectedExecutionState(ctx({ enabled: false, source: "flag-missing" }), ""), { enabled: false, source: "flag-missing" });
  assert.deepEqual(await protectedExecutionState(ctx({ enabled: true, source: "flag" }), "on"), { enabled: true, source: "flag" });
  await assert.rejects(protectedExecutionState(ctx({ enabled: true, source: "flag" }), "off"), /expected off, got on/);
  await assert.rejects(protectedExecutionState(ctx({ enabled: true, source: "flag" }), "yes"), /must be on or off/);
  await assert.rejects(protectedExecutionState(ctx({ enabled: "true" }), undefined), /expected \{ enabled, source \}/);
});
