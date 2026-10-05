import { defineConfig } from "vitest/config";

// Compose-engine tests live in packages/core/test and run against the built `dist`
// (the `test` script builds core first). See packages/core/test/compose.spec.ts.
// The view package also has pure-function unit tests (e.g. the Copy serializer in
// packages/view/src/components/form/copy.spec.ts).
export default defineConfig({
  test: {
    include: [
      "packages/core/test/**/*.spec.ts",
      "packages/view/src/**/*.spec.ts",
    ],
    environment: "node",
  },
});
