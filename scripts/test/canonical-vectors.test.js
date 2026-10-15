// Canonical-digest agreement across components (spec AT-04, TOKEN-01): Policy,
// Broker and the gateway use @graffiticode/common's canonicalDigest, and
// L0000 keeps its own TypeScript and Rust copies, which can't import common.
// Each copy's tests must carry every one of common's vectors, so a vector added
// there and not to a copy fails here instead of going unchecked.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CANONICAL_VECTORS } from "@graffiticode/common/canonical";

const COPIES = [
  "languages/l0000/packages/core/src/canonical.test.ts",
  "languages/l0000/crates/core/src/canonical.rs",
];
const digestsIn = path => new Set(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").match(/\b[0-9a-f]{64}\b/g) || []);

test("every L0000 copy's tests carry every one of common's canonical vectors", () => {
  const shared = CANONICAL_VECTORS.map(([, , digest]) => digest);
  assert.ok(shared.length >= 6);
  for (const path of COPIES) {
    const found = digestsIn(path);
    assert.deepEqual(shared.filter(d => !found.has(d)), [], `${path} is missing vectors`);
  }
});
