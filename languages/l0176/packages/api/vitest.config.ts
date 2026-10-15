// The server's tests run against the core's sources (no build), as the core's own do.
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@graffiticode/l0176": path.join(here, "..", "core", "src", "index.ts") },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
