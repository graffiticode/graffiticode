// SPDX-License-Identifier: MIT
// Scorer half of the custom question type. See vite.config.ts for why this is a second config.
import { defineConfig } from "vite";

import { cqtConfig } from "./vite.config.js";

export default defineConfig(cqtConfig("scorer"));
