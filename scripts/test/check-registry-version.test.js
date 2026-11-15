import test from "node:test";
import assert from "node:assert/strict";
import { SOURCES, findings, versionsIn } from "../check-registry-version.js";

const [REGISTRY, L0176_TS, L0176_RS, L0013_RS] = SOURCES.map(s => s.file);
const files = (ts, l0176ts, l0176rs, l0013rs = ts) => ({
  [REGISTRY]: `// header\nexport const REGISTRY_VERSION = ${ts};\n`,
  [L0176_TS]: `export const REGISTRY_VERSION = ${l0176ts};\n`,
  [L0176_RS]: `pub const REGISTRY_VERSION: u32 = ${l0176rs};\n`,
  [L0013_RS]: `pub mod crop;\n\npub const REGISTRY_VERSION: u32 = ${l0013rs};\n`,
});

test("checks the registry and both protected languages' compilers", () => {
  assert.deepEqual(SOURCES.map(s => s.file), [
    "packages/common/src/protected-registry.ts",
    "languages/l0176/packages/core/src/compiler.ts",
    "languages/l0176/crates/core/src/protection.rs",
    "languages/l0013/crates/core/src/lib.rs",
  ]);
});

test("agreeing declarations pass", () => {
  assert.deepEqual(findings(versionsIn(files(9, 9, 9, 9))), []);
});

test("a declaration that disagrees with the registry is reported", () => {
  assert.deepEqual(findings(versionsIn(files(9, 8, 9))), [`${L0176_TS}: REGISTRY_VERSION 8, but ${REGISTRY} has 9`]);
  assert.deepEqual(findings(versionsIn(files(9, 9, 8))), [`${L0176_RS}: REGISTRY_VERSION 8, but ${REGISTRY} has 9`]);
  assert.deepEqual(findings(versionsIn(files(9, 9, 9, 8))), [`${L0013_RS}: REGISTRY_VERSION 8, but ${REGISTRY} has 9`]);
});

test("a missing declaration is reported", () => {
  const f = files(9, 9, 9, 9);
  f[L0176_RS] = "pub const OTHER: u32 = 9;\n";
  f[L0013_RS] = "pub mod crop;\n";
  assert.deepEqual(findings(versionsIn(f)), [
    `${L0176_RS}: no REGISTRY_VERSION declaration found`,
    `${L0013_RS}: no REGISTRY_VERSION declaration found`,
  ]);
});
