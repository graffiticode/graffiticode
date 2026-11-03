// SPDX-License-Identifier: MIT
//
// Assembles ./static, the directory the Rust language server serves: L0178's public spec
// assets, from spec/ by tools/build-static.mjs (no compiler involved), and the /form View
// bundle, built by packages/view. The Rust server serves /lexicon.json from its binary.
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
npm("run", "-w", "packages/view", "build");
npm("run", "-w", "packages/view", "build:embed");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync("node", [join(root, "tools/build-static.mjs"), out], { cwd: root, stdio: "inherit" });
cpSync(join(root, "packages/view/dist-embed"), out, { recursive: true });
console.log(`assemble-static: wrote ${out}`);
