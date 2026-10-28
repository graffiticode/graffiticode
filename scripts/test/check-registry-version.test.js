import test from "node:test";
import assert from "node:assert/strict";
import { SOURCES, findings, versionsIn } from "../check-registry-version.js";

const [REGISTRY, L0176_TS, L0176_RS] = SOURCES.map(s => s.file);
const files = (ts, l0176ts, l0176rs) => ({
  [REGISTRY]: `// header\nexport const REGISTRY_VERSION = ${ts};\n`,
  [L0176_TS]: `export const REGISTRY_VERSION = ${l0176ts};\n`,
  [L0176_RS]: `pub const REGISTRY_VERSION: u32 = ${l0176rs};\n`,
});

test("three agreeing declarations pass", () => {
  assert.deepEqual(findings(versionsIn(files(8, 8, 8))), []);
});

test("a declaration that disagrees with the registry is reported", () => {
  assert.deepEqual(findings(versionsIn(files(9, 8, 9))), [`${L0176_TS}: REGISTRY_VERSION 8, but ${REGISTRY} has 9`]);
  assert.deepEqual(findings(versionsIn(files(9, 9, 8))), [`${L0176_RS}: REGISTRY_VERSION 8, but ${REGISTRY} has 9`]);
});

test("a missing declaration is reported", () => {
  const f = files(8, 8, 8);
  f[L0176_RS] = "pub const OTHER: u32 = 8;\n";
  assert.deepEqual(findings(versionsIn(f)), [`${L0176_RS}: no REGISTRY_VERSION declaration found`]);
});
