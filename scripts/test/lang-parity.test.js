import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compareCase, compareLexicon, compareProbe, comparable, corpusBlock, isEnvelope, ruleProblems, sendable } from "../lang-parity.js";

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
    "0001[0]: kind must be one of error-text, error-presentation, lexicon-superset, upstream-envelope, case, header",
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
  assert.equal(compareCase(answer(200, { data: 1, errors: [] }), answer(400, { data: 1, errors: [] })), "different");
  assert.equal(compareCase({ status: 500, text: "boom" }, { status: 500, text: "boom" }), "identical");
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
  assert.deepEqual(compareProbe("/", { status: 200, headers: {} }, { status: 404, headers: {} }), [{ path: "/", what: "status", ts: 200, rust: 404 }]);
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
  assert.equal(compareCase(ts, answer(400, { data: null, errors: [{ message: "e" }] }), { rules }), "different");
  assert.equal(compareCase(ts, answer(200, { data: null, errors: [{ message: "e" }], cache: false }), { rules }), "different");
  assert.equal(compareCase(ts, answer(200, { data: null, errors: [] }), { rules }), "different");
});
