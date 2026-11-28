// The shared public-error vectors (error handling proposal, step 2; PR 2a):
// packages/common/fixtures/public-errors.json. common's built toPublicError
// must reproduce every case, every case must name only registered reasons,
// the five categories and known recovery actions, and every copy in an
// implementation that can't import common (the Rust kernel, from PR 2c) must
// carry every case by name, as canonical-vectors.test.js does for digests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toPublicError, PUBLIC_ERROR_VERSION } from "@graffiticode/common/public-error";
import { FAILURE_CATEGORIES, RECOVERY_ACTIONS, REASON_CATEGORIES, underlyingReason } from "@graffiticode/common/failures";

const FIXTURES = JSON.parse(readFileSync(new URL("../../packages/common/fixtures/public-errors.json", import.meta.url), "utf8"));
// Files that must carry every case's name. None yet: PR 2c adds the kernel's.
const COPIES = [];

test("the fixtures are this contract version's", () => {
  assert.equal(FIXTURES.version, PUBLIC_ERROR_VERSION);
  assert.ok(FIXTURES.cases.length >= 10);
  const names = FIXTURES.cases.map(c => c.name);
  assert.equal(new Set(names).size, names.length, "case names must be distinct");
});

test("every expected value uses only registered reasons, the five categories and known actions", () => {
  for (const { name, expected } of FIXTURES.cases) {
    if (expected.reason !== null) assert.ok(REASON_CATEGORIES[underlyingReason(expected.reason)], `${name}: ${expected.reason} isn't registered`);
    assert.ok(FAILURE_CATEGORIES.includes(expected.category), `${name}: ${expected.category}`);
    assert.ok(RECOVERY_ACTIONS.includes(expected.recovery.action), `${name}: ${expected.recovery.action}`);
    assert.equal(expected.retryable, expected.recovery.action === "retry-same-key", `${name}: retryable is derived from the action`);
  }
});

test("common's built toPublicError reproduces every case", () => {
  for (const { name, error, options, expected } of FIXTURES.cases) {
    assert.deepEqual(toPublicError(error, options), expected, name);
  }
});

test("every copy carries every case", () => {
  for (const path of COPIES) {
    const text = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    assert.deepEqual(FIXTURES.cases.map(c => c.name).filter(n => !text.includes(n)), [], `${path} is missing cases`);
  }
});
