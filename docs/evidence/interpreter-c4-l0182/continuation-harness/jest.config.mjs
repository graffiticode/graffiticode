// The continuation harness's own Jest configuration. It matches only
// `*.harness.mjs`, which no default Jest pattern (`*.spec.*`, `*.test.*`,
// `__tests__`) matches, so the root and package targets never discover these
// tests. Run it through its own emulated target in scripts/test-targets.json,
// inside `firebase emulators:exec` (src/stores.mjs refuses to run otherwise).

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default {
  rootDir: dirname(fileURLToPath(import.meta.url)),
  testMatch: ["<rootDir>/**/*.harness.mjs"],
  moduleFileExtensions: ["mjs", "js", "json"],
  transform: {},
  testEnvironment: "node",
  testTimeout: 60000,
};
