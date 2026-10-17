import test from "node:test";
import assert from "node:assert/strict";
import { LEGACY_CASES, judgeLegacy, runLegacy } from "../at11/legacy.js";

const creds = { consumer: "retired-consumer", secret: "retired-secret-never-logged", domain: "localhost" };
// Signs like the SDK's init: the consumer in the request, a signature derived from the secret.
const fakeSdk = { init: (service, security, secret, request, action) => ({ security: JSON.stringify({ ...security, signature: `sig-${secret.length}` }), request: JSON.stringify(request), action }) };

test("only Learnosity's own refusal of the key passes", () => {
  assert.equal(judgeLegacy({ status: 401, body: { meta: { status: false, message: "Unauthorized" } } }).passed, true);
  assert.equal(judgeLegacy({ status: 400, body: { meta: { status: false, message: "Consumer key not found" } } }).passed, true);
  assert.equal(judgeLegacy({ status: 200, body: { meta: { status: true } } }).passed, false, "an accepted key fails");
  assert.equal(judgeLegacy({ error: "TimeoutError" }).passed, false);
  assert.equal(judgeLegacy({ status: 404, body: {} }).passed, false, "a wrong route proves nothing");
  assert.equal(judgeLegacy({ status: 500, body: {} }).passed, false);
  assert.equal(judgeLegacy({ status: 400, body: { meta: { status: false, message: "limit must be under 50" } } }).passed, false, "a refusal for another reason proves nothing about the key");
});

test("the cases are signed with the retired consumer and keep no secret in evidence", async () => {
  const sent = [];
  const result = await runLegacy(creds, {
    sdk: fakeSdk,
    doFetch: async (url, init) => { sent.push({ url, body: init.body.toString() }); return new Response(JSON.stringify({ meta: { status: false, message: "Invalid signature" } }), { status: 401 }); },
  });
  assert.equal(result.passed, true);
  assert.equal(result.rows.length, LEGACY_CASES.length);
  assert.ok(sent.every(s => s.body.includes("retired-consumer") && !s.body.includes("retired-secret-never-logged")));
  assert.ok(!JSON.stringify(result).includes("retired-secret-never-logged"));
});

test("the inputs have no defaults", async () => {
  await assert.rejects(runLegacy({ ...creds, consumer: "" }, { sdk: fakeSdk }), /needs consumer/);
  await assert.rejects(runLegacy({ ...creds, secret: undefined }, { sdk: fakeSdk }), /needs secret/);
  await assert.rejects(runLegacy(creds, {}), /SDK/);
});
