/* eslint-disable camelcase -- Learnosity protocol field names (consumer_key, user_id, session_id, response_id), as at12-rollback.test.js */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import LearnositySDK from "learnosity-sdk-nodejs";
import { FETCHED_TTL_MS, INTERPRETED_PROFILES, answerProblem, asDelivered, compareCase, compareInterpreted, compareLexicon, compareProbe, comparable, corpusBlock, evaluated, formAssets, formProblems, isEnvelope, maskSigned, metadataProblem, ruleProblems, semantic, sendable, signingMetadataProblem } from "../lang-parity.js";

const answer = (status, body) => ({ status, text: JSON.stringify(body) });

test("the checked-in allowlist is valid", async () => {
  const rules = JSON.parse(await readFile(new URL("../lang-parity.allow.json", import.meta.url), "utf8"));
  assert.deepEqual(ruleProblems(rules), []);
});

test("a rule needs a known kind, a note, and its fields", () => {
  assert.deepEqual(ruleProblems({
    184: [{ kind: "error-text", note: "x" }],
    "0001": [{ kind: "everything", note: "x" }, { kind: "case", note: " " }, { kind: "header", note: "x", path: "/form" }],
    "0002": {},
  }), [
    "184: not a four-digit language id",
    "0001[0]: kind must be one of error-text, error-presentation, lexicon-superset, upstream-envelope, form-body, case, header, volatile",
    "0001[1]: a note must explain the difference",
    "0001[1]: a case rule names its program source (src)",
    "0001[2]: a header rule names its path and header",
    "0002: rules must be a list",
  ]);
});

test("the deployment's revision is not compared; everything else in the envelope is", () => {
  assert.deepEqual(comparable(answer(200, { data: 1, errors: [], revision: "l0184-abc" })), { status: 200, body: { data: 1, errors: [] } });
  assert.equal(compareCase(answer(200, { data: 1, errors: [], revision: "a" }), answer(200, { data: 1, errors: [], revision: "b" })), "identical");
  assert.equal(compareCase(answer(200, { data: 1, errors: [], cache: false }), answer(200, { data: 1, errors: [] })), "different");
  assert.deepEqual(compareCase(answer(200, { data: 1, errors: [] }), answer(400, { data: 1, errors: [] })), { invalid: { ts: null, rust: "HTTP 400" } });
  // Two failures are not agreement.
  assert.ok(compareCase({ status: 500, text: "boom" }, { status: 500, text: "boom" }).invalid);
});

test("error-text allows only reworded messages: same status, same number of errors, same everything else", () => {
  const rules = [{ kind: "error-text", note: "x" }];
  const ts = answer(200, { data: null, errors: [{ message: "Got tag dark", from: 1, to: 2 }] });
  assert.deepEqual(compareCase(ts, answer(200, { data: null, errors: [{ message: "Got the string \"dark\"", from: 1, to: 2 }] }), { rules }), { allowed: "error-text" });
  assert.equal(compareCase(ts, answer(200, { data: null, errors: [{ message: "other", from: 1, to: 3 }] }), { rules }), "different");
  assert.equal(compareCase(ts, answer(200, { data: null, errors: [{ message: "a", from: 1, to: 2 }, { message: "b", from: 1, to: 2 }] }), { rules }), "different");
  assert.equal(compareCase(answer(200, { data: 1, errors: [] }), answer(200, { data: 2, errors: [] }), { rules }), "different");
  // Without the rule, reworded text is a difference.
  assert.equal(compareCase(ts, answer(200, { data: null, errors: [{ message: "Got the string", from: 1, to: 2 }] })), "different");
});

test("a case rule allows exactly that program", () => {
  const rules = [{ kind: "case", src: "plan 158..", note: "x" }];
  const [ts, rust] = [answer(200, { data: [], errors: [] }), answer(200, { data: null, errors: [{ message: "e" }] })];
  assert.deepEqual(compareCase(ts, rust, { src: "plan 158..", rules }), { allowed: "case" });
  assert.equal(compareCase(ts, rust, { src: "plan 159..", rules }), "different");
});

test("a lexicon may be a superset only under its rule, and never changes a TypeScript word", () => {
  const rules = [{ kind: "lexicon-superset", note: "x" }];
  const ts = { add: { tk: 1 } };
  assert.equal(compareLexicon(ts, { add: { tk: 1 } }), "identical");
  assert.equal(compareLexicon(ts, { add: { tk: 1 }, "format-number": { tk: 2 } }), "different");
  assert.deepEqual(compareLexicon(ts, { add: { tk: 1 }, "format-number": { tk: 2 } }, rules), { allowed: "lexicon-superset" });
  assert.equal(compareLexicon(ts, { add: { tk: 9 }, more: {} }, rules), "different");
  assert.equal(compareLexicon(ts, undefined, rules), "different");
});

test("a probe compares status and the cache, type and cross-origin headers, allowing only reviewed header rules", () => {
  const ts = { status: 200, headers: { "cache-control": "no-store", "content-type": "text/html", "x-other": "a" } };
  const rust = { status: 200, headers: { "content-type": "text/html", "x-other": "b" } };
  assert.deepEqual(compareProbe("/form", ts, rust), [{ path: "/form", what: "cache-control", ts: "no-store", rust: null }]);
  assert.deepEqual(compareProbe("/form", ts, rust, [{ kind: "header", path: "/form", header: "Cache-Control", note: "x" }]), []);
  assert.deepEqual(compareProbe("/form", ts, rust, [{ kind: "header", path: "/assets", header: "cache-control", note: "x" }]).length, 1);
  assert.deepEqual(compareProbe("/", { status: 200, headers: {} }, { status: 404, headers: {} }), [{ path: "/", what: "not 200", rust: 404 }, { path: "/", what: "status", ts: 200, rust: 404 }]);
});

test("falsy upstream data isn't sent, as the API never sends it", () => {
  assert.equal(sendable({ ast: {}, data: "" }), false);
  assert.equal(sendable({ ast: {}, data: 0 }), false);
  assert.equal(sendable({ ast: {} }), true);
  assert.equal(sendable({ ast: {}, data: { a: 1 } }), true);
});

test("the corpus block has the promote evidence's shape", () => {
  assert.deepEqual(corpusBlock({ ranAt: "2026-10-28T00:00:00Z", tasks: 3, failures: 0, extra: 1 }), { ranAt: "2026-10-28T00:00:00Z", tasks: 3, failures: 0 });
});

test("upstream-envelope allows a difference only for a case whose upstream data is an envelope", () => {
  const rules = [{ kind: "upstream-envelope", note: "x" }];
  const [ts, rust] = [answer(200, { data: { data: { a: 1 }, errors: [] }, errors: [] }), answer(200, { data: { a: 1 }, errors: [] })];
  assert.deepEqual(compareCase(ts, rust, { data: { data: { a: 1 }, errors: [] }, rules }), { allowed: "upstream-envelope" });
  assert.equal(compareCase(ts, rust, { data: { a: 1 }, rules }), "different");
  assert.equal(compareCase(ts, rust, { data: { data: { a: 1 }, errors: [] } }), "different");
  assert.equal(isEnvelope({ errors: [] }), true);
  assert.equal(isEnvelope({ data: 1, errors: "no" }), false);
  assert.equal(isEnvelope([{ errors: [] }]), false);
  assert.equal(isEnvelope(null), false);
});

test("error-presentation allows only differences in how errors are presented", () => {
  const rules = [{ kind: "error-presentation", note: "x" }];
  const ts = answer(200, { data: null, errors: [{ message: "empty array has no head", from: -1, to: -1 }, { message: "dup", from: -1, to: -1 }] });
  const rust = answer(200, { data: null, errors: [{ message: "empty list has no head", from: 0, to: 2 }] });
  assert.deepEqual(compareCase(ts, rust, { rules }), { allowed: "error-presentation" });
  // Not without the rule; not when data, status or another field differs; not when one side has no errors.
  assert.equal(compareCase(ts, rust), "different");
  assert.equal(compareCase(ts, answer(200, { data: 1, errors: [{ message: "e" }] }), { rules }), "different");
  assert.ok(compareCase(ts, answer(400, { data: null, errors: [{ message: "e" }] }), { rules }).invalid);
  assert.equal(compareCase(ts, answer(200, { data: null, errors: [{ message: "e" }], cache: false }), { rules }), "different");
  assert.equal(compareCase(ts, answer(200, { data: null, errors: [] }), { rules }), "different");
});

test("an answer is compared only if it arrived with 200 as an object with an errors list", () => {
  assert.equal(answerProblem(answer(200, { data: 1, errors: [] })), null);
  assert.equal(answerProblem({ status: 0, text: "TypeError: fetch failed" }), "no answer (TypeError: fetch failed)");
  assert.equal(answerProblem(answer(503, { errors: [] })), "HTTP 503");
  assert.equal(answerProblem({ status: 200, text: "<html>" }), "not a JSON object");
  assert.equal(answerProblem(answer(200, [1])), "not a JSON object");
  assert.equal(answerProblem(answer(200, { data: 1 })), "no errors list");
  // Every failure is invalid, both failing the same way included, and no rule rescues it.
  const all = [{ kind: "case", src: "p..", note: "x" }, { kind: "error-presentation", note: "x" }, { kind: "upstream-envelope", note: "x" }];
  const down = { status: 0, text: "ECONNREFUSED" };
  assert.deepEqual(compareCase(down, down, { src: "p..", data: { errors: [] }, rules: all }), { invalid: { ts: "no answer (ECONNREFUSED)", rust: "no answer (ECONNREFUSED)" } });
  assert.ok(compareCase(answer(200, { data: 1, errors: [] }), answer(503, { errors: [] }), { src: "p..", rules: all }).invalid);
});

test("two missing lexicons are not the same lexicon", () => {
  assert.equal(compareLexicon(undefined, undefined), "different");
  assert.equal(compareLexicon({ a: 1 }, null), "different");
  assert.equal(compareLexicon({ a: 1 }, { a: 1 }), "identical");
});

test("a probed path must answer 200 on both sides", () => {
  const ok = { status: 200, headers: {} };
  assert.deepEqual(compareProbe("/", ok, ok), []);
  assert.deepEqual(compareProbe("/", { status: 503, headers: {} }, { status: 503, headers: {} }),
    [{ path: "/", what: "not 200", ts: 503 }, { path: "/", what: "not 200", rust: 503 }]);
});

test("a form loads a script, and every relative asset it references must load from its own server", () => {
  const html = "<script type=\"module\" src=\"/assets/index-AB12.js\"></script><link rel=\"stylesheet\" href=\"./assets/index-CD34.css\"><a href=\"https://example.com/x\">x</a><img src=\"data:image/png;base64,AA\"><a href=\"#top\">t</a>";
  assert.deepEqual(formAssets(html), ["/assets/index-AB12.js", "/assets/index-CD34.css"]);
  const good = { "/assets/index-AB12.js": { status: 200, length: 10 }, "/assets/index-CD34.css": { status: 200, length: 5 } };
  assert.deepEqual(formProblems("rust", html, good), []);
  assert.deepEqual(formProblems("rust", html, { ...good, "/assets/index-AB12.js": { status: 404, length: 0 } }),
    [{ side: "rust", what: "asset /assets/index-AB12.js", status: 404, length: 0 }]);
  assert.deepEqual(formProblems("ts", "<html><body>no bundle</body></html>", {}), [{ side: "ts", what: "the form loads no script" }]);
});

test("--interpreted: the model interpreted in both modes must answer exactly as the compile, revision aside", () => {
  const answer = body => ({ status: 200, text: JSON.stringify(body) });
  const compiled = answer({ data: { type: "charts" }, errors: [] });
  const modelled = answer({ model: { lang: "0184", kind: "value", digest: "d", value: { type: "charts" } }, errors: [], revision: "r" });
  const same = answer({ data: { type: "charts" }, errors: [], revision: "r" });
  assert.equal(compareInterpreted(compiled, modelled, { evaluate: same, present: same }), "identical");
  const other = answer({ data: { type: "other" }, errors: [] });
  assert.equal(compareInterpreted(compiled, modelled, { evaluate: same, present: other }), "different");
  // Interpretation must not add anything to the envelope either.
  const extra = answer({ data: { type: "charts" }, errors: [], cache: false });
  assert.equal(compareInterpreted(compiled, modelled, { evaluate: same, present: extra }), "different");
  assert.equal(compareInterpreted(compiled, modelled, null), "different");
  assert.deepEqual(compareInterpreted(compiled, modelled, { evaluate: { status: 500, text: "" }, present: same }), { invalid: { evaluate: "HTTP 500" } });
});

test("--interpreted compares semantically: a cache class and expiresAt aside, as revision (C3)", () => {
  const answer = body => ({ status: 200, text: JSON.stringify(body) });
  const compiled = answer({ data: [1], errors: [], cache: "shared", expiresAt: 1000 });
  const modelled = answer({ model: { lang: "0185", kind: "plan", digest: "d", program: {} }, errors: [], revision: "r" });
  const later = answer({ data: [1], errors: [], cache: "shared", expiresAt: 2000, revision: "r" });
  assert.equal(compareInterpreted(compiled, modelled, { evaluate: later, present: later }), "identical");
  assert.equal(compareInterpreted(compiled, modelled, { evaluate: later, present: answer({ data: [2], errors: [], cache: "shared", expiresAt: 2000 }) }), "different");
  // `cache: false` is no-store, not a class: still compared.
  assert.deepEqual(semantic(answer({ data: 1, errors: [], cache: false })).body, { data: 1, errors: [], cache: false });
  assert.deepEqual(semantic(answer({ data: 1, errors: [], cache: "immutable", expiresAt: null })).body, { data: 1, errors: [] });
});

test("--interpreted validates the cache metadata on its own (C3)", () => {
  const answer = body => ({ status: 200, text: JSON.stringify(body) });
  const sentAt = 1_000_000;
  const receivedAt = sentAt + 200;
  const at = { sentAt, receivedAt };
  const shared = expiresAt => answer({ data: [1], errors: [], cache: "shared", expiresAt });
  // A case that fetched: shared, expiring within [sent, received + TTL + skew].
  assert.equal(metadataProblem(shared(sentAt + FETCHED_TTL_MS), { fetches: true, ...at }), null);
  assert.equal(metadataProblem(shared(sentAt + 1000), { fetches: true, ...at }), null);
  assert.match(metadataProblem(shared(receivedAt + FETCHED_TTL_MS + 60_000), { fetches: true, ...at }), /isn't shared within the TTL/);
  assert.match(metadataProblem(shared(sentAt - 60_000), { fetches: true, ...at }), /isn't shared within the TTL/);
  assert.match(metadataProblem(answer({ data: [1], errors: [] }), { fetches: true, ...at }), /isn't shared/);
  assert.match(metadataProblem(answer({ data: [1], errors: [], cache: "private", expiresAt: sentAt + 1000 }), { fetches: true, ...at }), /isn't shared/);
  // A fetch that failed: unrestricted, or validly shared.
  const failed = { data: null, errors: [{ message: "404" }] };
  assert.equal(metadataProblem(answer(failed), { fetches: true, ...at }), null);
  assert.equal(metadataProblem(answer({ ...failed, cache: "shared", expiresAt: sentAt + FETCHED_TTL_MS }), { fetches: true, ...at }), null);
  assert.match(metadataProblem(answer({ ...failed, cache: "shared" }), { fetches: true, ...at }), /isn't shared within/);
  // No fetch: no restriction at all.
  assert.equal(metadataProblem(answer({ data: 1, errors: [] }), { fetches: false, ...at }), null);
  assert.equal(metadataProblem(answer({ data: 1, errors: [], cache: "immutable" }), { fetches: false, ...at }), null);
  assert.match(metadataProblem(shared(sentAt + FETCHED_TTL_MS), { fetches: false, ...at }), /with no fetch/);
  assert.match(metadataProblem(answer({ data: 1, errors: [], expiresAt: sentAt }), { fetches: false, ...at }), /with no fetch/);
});

test("--interpreted: a program with no model must fail exactly as it compiles", () => {
  const answer = body => ({ status: 200, text: JSON.stringify(body) });
  const errors = [{ message: "bad", from: 0, to: 1 }];
  const noModel = answer({ model: null, errors, revision: "r" });
  assert.equal(compareInterpreted(answer({ data: null, errors }), noModel, null), "identical");
  assert.equal(compareInterpreted(answer({ data: null, errors: [{ message: "other", from: 0, to: 1 }] }), noModel, null), "different");
  assert.equal(compareInterpreted(answer({ data: 1, errors: [] }), noModel, null), "different");
});

test("a case's data is also sent as the API delivers it: wrapped in the stage below's envelope", () => {
  assert.deepEqual(asDelivered({ title: "x" }), { data: { title: "x" }, errors: [] });
  assert.deepEqual(asDelivered([1, 2]), { data: [1, 2], errors: [] });
  assert.deepEqual(asDelivered("text"), { data: "text", errors: [] });
  // No data, or an empty record (which POST /compile never appends as a stage): nothing to deliver.
  for (const none of [undefined, null, {}]) assert.equal(asDelivered(none), null);
});

test("volatile masks only values and keys that wholly match its pattern, then needs identical answers", () => {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const rules = [{ kind: "volatile", pattern: uuid, note: "fresh session ids" }, { kind: "volatile", pattern: "graffiticode-\\d{4}-\\d{2}-\\d{2}T\\d{6}\\d{3}Z-row-\\d+", note: "timestamped row keys" }];
  const answer = (sid, row, extra = {}) => ({ status: 200, text: JSON.stringify({ data: { ["session" + "_id"]: sid, rows: { [row]: { index: 0 } }, ...extra }, errors: [] }) });
  const a = answer("b1121c60-557f-421a-8a31-b0c17ff2da6f", "graffiticode-2026-11-03T214751584Z-row-0");
  const b = answer("523baf9f-b668-47a9-915b-f058b4d3d5f4", "graffiticode-2026-11-03T214751563Z-row-0");
  assert.deepEqual(compareCase(a, b, { rules }), { allowed: "volatile" });
  // Anything else that differs still fails.
  assert.equal(compareCase(a, answer("523baf9f-b668-47a9-915b-f058b4d3d5f4", "graffiticode-2026-11-03T214751563Z-row-0", { stimulus: null }), { rules }), "different");
  // A value that only contains a match isn't masked, and a fixed id against a fresh one fails.
  assert.equal(compareCase(answer("t", "r"), answer("b1121c60-557f-421a-8a31-b0c17ff2da6f", "r"), { rules }), "different");
  assert.equal(compareCase(answer("id b1121c60-557f-421a-8a31-b0c17ff2da6f", "r"), answer("id 523baf9f-b668-47a9-915b-f058b4d3d5f4", "r"), { rules }), "different");
  // Without the rule, the fresh ids differ.
  assert.equal(compareCase(a, b), "different");
  assert.deepEqual(ruleProblems({ "0176": [{ kind: "volatile", note: "x" }] }), ["0176[0]: a volatile rule names its pattern"]);
  assert.deepEqual(ruleProblems({ "0176": [{ kind: "volatile", pattern: "(", note: "x" }] }), ["0176[0]: the pattern is not a regular expression"]);
});

// C6 part 2: L0176 under --interpreted, field by field.
// Signed packets as Broker makes them (packages/broker/src/operations.ts): the installed
// Learnosity SDK, a fresh user_id and session_id per signature, a throwaway secret.
const sdk = new LearnositySDK();
const PAYLOAD = { id: "graffiticode-0123456789abcdef", name: "Test", questions: [{ type: "mcq", response_id: "r1" }] };
const signPacket = (service, { payload = PAYLOAD, consumer = "test0consumer001", domain = "l0176.graffiticode.org", expires = "20261112-1834" } = {}) =>
  sdk.init(service, { consumer_key: consumer, domain, user_id: randomUUID(), expires }, "0".repeat(40),
    { ...payload, type: "local_practice", session_id: randomUUID() });

test("the SDK's packets are the shapes maskSigned knows", () => {
  const questions = signPacket("questions");
  assert.deepEqual(Object.keys(questions).sort(), ["consumer_key", "expires", "id", "meta", "name", "questions", "session_id", "signature", "timestamp", "type", "user_id"]);
  const items = signPacket("items");
  assert.deepEqual(Object.keys(items).sort(), ["request", "security"]);
  assert.deepEqual(Object.keys(items.security).sort(), ["consumer_key", "domain", "expires", "signature", "timestamp", "user_id"]);
  assert.equal(typeof items.request.session_id, "string");
});

test("L0176 is compared field by field: a re-signed present equals the compile, for both SDK shapes, under PROG and bare init", () => {
  assert.deepEqual(INTERPRETED_PROFILES["0176"], { signs: true });
  const activity = { type: "questions", data: PAYLOAD };
  const modelled = answer(200, { model: { lang: "0176", kind: "plan" }, errors: [] });
  const env = data => answer(200, { data, errors: [], cache: false });
  for (const service of ["questions", "items"]) {
    // PROG: the activity with its signed request; a bare init: the signed packet itself.
    for (const [form, shape] of [["PROG", packet => ({ ...activity, request: packet })], ["bare init", packet => packet]]) {
      const compiled = env(shape(signPacket(service)));
      const present = env(shape(signPacket(service)));
      const label = `${service} ${form}`;
      // Two signatures differ in their fresh fields only.
      assert.notDeepEqual(JSON.parse(compiled.text), JSON.parse(present.text), label);
      assert.equal(compareInterpreted(compiled, modelled, { present }, { signs: true }), "identical", label);
      // Without the profile they differ.
      assert.equal(compareInterpreted(compiled, modelled, { present }), "different", label);
      // Everything but the fresh fields is compared: the consumer, the domain, the content.
      for (const [what, other] of [
        ["consumer", signPacket(service, { consumer: "another0consumer" })],
        ["domain", signPacket(service, { domain: "example.com" })],
        ["content", signPacket(service, { payload: { ...PAYLOAD, questions: [{ type: "mcq", response_id: "r2" }] } })],
        ["id", signPacket(service, { payload: { ...PAYLOAD, id: "graffiticode-ffffffffffffffff" } })],
      ]) {
        if (what === "domain" && service === "questions") continue; // the questions packet carries no domain
        assert.equal(compareInterpreted(compiled, modelled, { present: env(shape(other)) }, { signs: true }), "different", `${label}: ${what}`);
      }
    }
  }
  // The activity beside a PROG request is compared: a kept session id, another id.
  const compiled = env({ ...activity, request: signPacket("questions") });
  for (const data of [{ ...PAYLOAD, session_id: "old" }, { ...PAYLOAD, id: "graffiticode-ffffffffffffffff" }]) {
    assert.equal(compareInterpreted(compiled, modelled, { present: env({ ...activity, data, request: signPacket("questions") }) }, { signs: true }), "different");
  }
  // Present without cache: false differs from the compile.
  const uncached = answer(200, { data: { ...activity, request: signPacket("questions") }, errors: [] });
  assert.equal(compareInterpreted(compiled, modelled, { present: uncached }, { signs: true }), "different");
});

test("L0176's evaluate is the compile unsigned, without cache: false, with a save skipped for evaluate", () => {
  const save = { skipped: "no-connection", fn: "save-to-itembank", occurrence: "SAVE_TO_ITEMBANK:21" };
  const activity = { type: "questions", data: { id: "t", questions: [], itemBank: save } };
  const compileBody = { data: { ...activity, signing: { unsigned: "gateway-only", message: "m" } }, errors: [], cache: false };
  assert.deepEqual(evaluated(compileBody), { data: { ...activity, data: { ...activity.data, itemBank: { ...save, skipped: "evaluate" } } }, errors: [] });
  const compiled = answer(200, compileBody);
  const modelled = answer(200, { model: { lang: "0176", kind: "plan" }, errors: [] });
  const evaluate = answer(200, { data: { ...activity, data: { ...activity.data, itemBank: { ...save, skipped: "evaluate" } } }, errors: [] });
  assert.equal(compareInterpreted(compiled, modelled, { evaluate, present: compiled }, { signs: true }), "identical");
  // An evaluate answer that signs, or says cache: false, or still says no-connection, differs.
  for (const body of [
    { ...JSON.parse(evaluate.text), data: { ...JSON.parse(evaluate.text).data, request: {} } },
    { ...JSON.parse(evaluate.text), cache: false },
    { data: activity, errors: [] },
  ]) {
    assert.equal(compareInterpreted(compiled, modelled, { evaluate: answer(200, body), present: compiled }, { signs: true }), "different");
  }
  // A program with no model fails as it compiles; a signing language's failed compile is
  // cache: false, which only its profile accepts.
  const noModel = answer(200, { model: null, errors: [{ message: "bad" }] });
  const failedCompile = answer(200, { data: null, errors: [{ message: "bad" }], cache: false });
  assert.equal(compareInterpreted(failedCompile, noModel, null, { signs: true }), "identical");
  assert.equal(compareInterpreted(failedCompile, noModel, null), "different");
  // A class instead of cache: false is metadata, which the metadata check refuses.
  assert.match(signingMetadataProblem(answer(200, { data: null, errors: [{ message: "bad" }], cache: "immutable" }), "compile"), /isn't cache: false/);
  // Errors: the same errors, cache: false only where it belongs.
  const failed = answer(200, { data: null, errors: [{ message: "bad" }], cache: false });
  assert.equal(compareInterpreted(failed, modelled, { evaluate: answer(200, { data: null, errors: [{ message: "bad" }] }), present: failed }, { signs: true }), "identical");
});

test("L0176's metadata: compile and present always cache: false, evaluate never cache", () => {
  assert.equal(signingMetadataProblem(answer(200, { data: 1, errors: [], cache: false }), "compile"), null);
  assert.equal(signingMetadataProblem(answer(200, { data: null, errors: [{ message: "x" }], cache: false }), "present"), null);
  assert.match(signingMetadataProblem(answer(200, { data: null, errors: [{ message: "x" }] }), "compile"), /isn't cache: false/);
  assert.match(signingMetadataProblem(answer(200, { data: 1, errors: [], cache: "immutable" }), "present"), /isn't cache: false/);
  assert.equal(signingMetadataProblem(answer(200, { data: 1, errors: [] }), "evaluate"), null);
  assert.match(signingMetadataProblem(answer(200, { data: 1, errors: [], cache: false }), "evaluate"), /evaluate carries cache/);
});

test("maskSigned masks only each signature's fresh fields", () => {
  const questions = signPacket("questions");
  const masked = maskSigned({ data: { type: "questions", data: PAYLOAD, request: questions }, errors: [] });
  for (const field of ["user_id", "expires", "timestamp", "signature", "session_id"]) assert.equal(masked.data.request[field], "<signed>", field);
  assert.equal(masked.data.request.consumer_key, questions.consumer_key);
  assert.deepEqual(masked.data.request.questions, PAYLOAD.questions);
  assert.deepEqual(masked.data.request.meta, questions.meta);
  assert.deepEqual(masked.data.data, PAYLOAD);
  const items = signPacket("items");
  const bare = maskSigned({ data: items, errors: [] }).data;
  for (const field of ["user_id", "expires", "timestamp", "signature"]) assert.equal(bare.security[field], "<signed>", field);
  assert.equal(bare.security.consumer_key, items.security.consumer_key);
  assert.equal(bare.security.domain, items.security.domain);
  assert.equal(bare.request.session_id, "<signed>");
  assert.equal(bare.request.id, PAYLOAD.id);
  // Not a packet: unchanged, whatever its field names.
  const plain = { data: { type: "questions", data: { ...PAYLOAD, user_id: "u", session_id: "s" } }, errors: [] };
  assert.deepEqual(maskSigned(plain), plain);
  assert.deepEqual(maskSigned({ data: 1 }), { data: 1 });
});
