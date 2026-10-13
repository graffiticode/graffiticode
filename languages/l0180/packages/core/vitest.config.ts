// SPDX-License-Identifier: MIT
// Point the published subpath at source, so tests never require a build first. Without this
// `@graffiticode/l0180/matching` resolves to dist and every suite in this package — and in
// view, which imports the scorer across the boundary — would need `npm run build` to run.
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

export default defineConfig({
  resolve: {
    alias: {
      "@graffiticode/l0180/matching": fileURLToPath(new URL("src/matching.ts", import.meta.url)),
    },
  },
});
