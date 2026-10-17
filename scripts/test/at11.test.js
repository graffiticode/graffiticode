import test from "node:test";
import assert from "node:assert/strict";
import { SERVER_CASES, BROWSER_CASES, judgeDataApi, runServer, judgeBrowser, harness, signedBrowserCases } from "../at11/d1.js";

// --- the D1 probe ---

const creds = { consumer: "test-consumer", secret: "test-secret-never-logged", domain: "localhost" };

test("a Data API case passes only when Learnosity refuses it", () => {
  assert.equal(judgeDataApi({ status: 403, body: { meta: { status: false, message: "Consumer not permitted" } } }).passed, true);
  assert.equal(judgeDataApi({ status: 200, body: { meta: { status: true } } }).passed, false);
  assert.equal(judgeDataApi({ error: "TimeoutError" }).passed, false);
  assert.equal(judgeDataApi({ status: 500, body: {} }).passed, false);
});

test("the server cases are signed with the given consumer and keep no secret in evidence", async () => {
  const sent = [];
  const rows = await runServer(creds, { doFetch: async (url, init) => { sent.push({ url, body: init.body.toString() }); return new Response(JSON.stringify({ meta: { status: false, message: "no" } }), { status: 403 }); } });
  assert.equal(rows.length, SERVER_CASES.length);
  assert.ok(rows.every(r => r.passed));
  assert.ok(sent.every(s => s.body.includes("test-consumer") && !s.body.includes("test-secret-never-logged")));
  assert.ok(!JSON.stringify(rows).includes("test-secret-never-logged"));
});

test("the browser harness carries signatures, never the secret, and only the preview control may initialize", () => {
  const page = harness(signedBrowserCases(creds));
  assert.ok(!page.includes("test-secret-never-logged"));
  assert.ok(page.includes("test-consumer"));
  const results = BROWSER_CASES.map(c => ({ id: c.id, outcome: c.control ? "initialized" : "refused" }));
  assert.equal(judgeBrowser(results).passed, true);
  const allowed = results.map(r => r.id === "items-initial" ? { ...r, outcome: "initialized" } : r);
  assert.equal(judgeBrowser(allowed).passed, false);
  const noControl = results.map(r => r.id.includes("control") ? { ...r, outcome: "refused" } : r);
  assert.deepEqual([judgeBrowser(noControl).void, judgeBrowser(noControl).passed], [true, false]);
});
