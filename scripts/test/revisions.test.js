import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "../revisions.js";

// The retirement flow itself is tested against the Firestore emulator
// (packages/policy/src/revisions.spec.ts); these are the operator's options.
test("retire takes a release and at most one mode; status takes a service", () => {
  assert.deepEqual(parse(["status", "l0176"]), { command: "status", service: "l0176", release: null, confirmUnrecoverable: false, resume: false, cancel: false });
  assert.equal(parse(["retire", "l0176", "--release", "rmux-1a2b3c"]).release, "rmux-1a2b3c");
  assert.equal(parse(["retire", "l0176", "--release", "r1", "--confirm-unrecoverable"]).confirmUnrecoverable, true);
  assert.equal(parse(["retire", "l0176", "--release", "r1", "--resume", "--confirm-unrecoverable"]).resume, true);
  assert.equal(parse(["retire", "l0176", "--release", "r1", "--cancel"]).cancel, true);
  assert.throws(() => parse(["retire", "l0176"]), /requires --release/);
  assert.throws(() => parse(["retire", "l0176", "--release", "r1", "--cancel", "--resume"]), /stands alone/);
  assert.throws(() => parse(["retire", "l0176", "--release", "R1!"]), /unknown or incomplete/);
  assert.throws(() => parse(["drop", "l0176"]), /usage/);
  assert.throws(() => parse(["retire"]), /usage/);
});
