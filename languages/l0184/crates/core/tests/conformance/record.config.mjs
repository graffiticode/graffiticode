// SPDX-License-Identifier: MIT
//
// The TypeScript core's vitest configuration plus record.setup.mjs, for generate.mjs.
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));

export default {
  root: join(here, "..", "..", "..", "..", "packages", "core"),
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: [join(here, "record.setup.mjs")],
  },
};
