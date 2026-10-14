// SPDX-License-Identifier: MIT
//
// Assembles ./static, the directory the Rust language server serves: L0183's public spec
// assets, the /form View bundle, and the Learnosity custom question's question.js, scorer.js
// and question.css (a published contract: L0176's `custom [lang "0183" …]` loads them from this
// server). All are built by the npm packages in this directory (packages/core, packages/view and
// packages/integrations/learnosity); this runs those builds and copies their output, as the
// root `build` and `assemble` scripts do for the TypeScript server.
//
// The TypeScript server has its own copy of the same assets in packages/api/static, assembled
// by `npm run build`.
//
//   node tools/assemble-static.mjs [--skip-install]
import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "static");

const npm = (...args) => execFileSync("npm", args, { cwd: root, stdio: "inherit" });

if (!process.argv.includes("--skip-install") && !existsSync(join(root, "node_modules"))) {
  npm("ci");
}
npm("run", "-w", "packages/core", "build");
npm("run", "-w", "packages/core", "build-static");
npm("run", "-w", "packages/view", "build");
npm("run", "-w", "packages/view", "build:embed");
npm("run", "-w", "packages/integrations/learnosity", "build");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "packages/core/dist/static"), out, { recursive: true });
cpSync(join(root, "packages/view/dist-embed"), out, { recursive: true });
cpSync(join(root, "packages/integrations/learnosity/dist"), out, { recursive: true });
console.log(`assemble-static: wrote ${out}`);
