import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { answerProblem, compareCase, compareInterpreted, compareLexicon, compareProbe, comparable, corpusBlock, formAssets, formProblems, isEnvelope, ruleProblems, sendable } from "../lang-parity.js";

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
    "0001[0]: kind must be one of error-text, error-presentation, lexicon-superset, upstream-envelope, form-body, case, header",
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

test("--interpreted: a program with no model must fail exactly as it compiles", () => {
  const answer = body => ({ status: 200, text: JSON.stringify(body) });
  const errors = [{ message: "bad", from: 0, to: 1 }];
  const noModel = answer({ model: null, errors, revision: "r" });
  assert.equal(compareInterpreted(answer({ data: null, errors }), noModel, null), "identical");
  assert.equal(compareInterpreted(answer({ data: null, errors: [{ message: "other", from: 0, to: 1 }] }), noModel, null), "different");
  assert.equal(compareInterpreted(answer({ data: 1, errors: [] }), noModel, null), "different");
});
