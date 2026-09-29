// SPDX-License-Identifier: MIT
// Separate from vite.config.ts on purpose: that file builds the published library, and aliasing
// the subpath there would inline core's matching module into the bundle instead of importing it.
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

export default defineConfig({
  resolve: {
    alias: {
      "@graffiticode/l0180/matching": fileURLToPath(
        new URL("../core/src/matching.ts", import.meta.url),
      ),
    },
  },
});
