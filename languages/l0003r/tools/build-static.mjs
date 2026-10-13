// SPDX-License-Identifier: MIT
//
// Assembles ./static, the directory the server serves: L0003's public spec assets and the
// /form View bundle. Both are built by the sibling TypeScript project, languages/l0003, which
// owns the spec documents and the React View; this only runs its builds and copies the output.
//
//   node tools/build-static.mjs [--skip-install]
import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const typescript = join(root, "..", "l0003");
const out = join(root, "static");

const npm = (...args) => execFileSync("npm", args, { cwd: typescript, stdio: "inherit" });

if (!process.argv.includes("--skip-install") && !existsSync(join(typescript, "node_modules"))) {
  npm("ci");
}
npm("run", "-w", "packages/core", "build");
npm("run", "-w", "packages/core", "build-static");
npm("run", "-w", "packages/view", "build");
npm("run", "-w", "packages/view", "build:embed");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(typescript, "packages/core/dist/static"), out, { recursive: true });
cpSync(join(typescript, "packages/view/dist-embed"), out, { recursive: true });
console.log(`build-static: wrote ${out}`);
