// Clean build of every project in tsconfig.build.json: delete each project's
// resolved outDir, declarationDir and tsBuildInfoFile, then `tsc -b`. Stale
// build info outside an output directory would otherwise let tsc skip a
// project whose output was deleted, hiding a missing module.
//
//   node scripts/clean-build.js [--no-build]

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = args => spawnSync("npx", ["tsc", ...args], { cwd: ROOT, encoding: "utf8" });

const projects = JSON.parse(readFileSync(path.join(ROOT, "tsconfig.build.json"), "utf8")).references.map(r => r.path);
for (const project of projects) {
  const shown = tsc(["-p", project, "--showConfig"]);
  if (shown.status !== 0) throw new Error(`tsc --showConfig ${project} failed:\n${shown.stdout}${shown.stderr}`);
  const { compilerOptions = {} } = JSON.parse(shown.stdout);
  const dir = path.dirname(path.join(ROOT, project));
  const targets = [compilerOptions.outDir, compilerOptions.declarationDir, compilerOptions.tsBuildInfoFile]
    .filter(Boolean).map(p => path.resolve(dir, p));
  // Composite projects without tsBuildInfoFile keep it next to the config.
  targets.push(path.join(dir, `${path.basename(project, ".json")}.tsbuildinfo`));
  for (const target of targets) {
    if (!target.startsWith(path.join(ROOT, "packages") + path.sep)) throw new Error(`refusing to delete outside packages/: ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
  console.log(`cleaned ${project}`);
}
if (!process.argv.includes("--no-build")) {
  const build = spawnSync("npm", ["run", "build", "--silent"], { cwd: ROOT, stdio: "inherit" });
  process.exit(build.status ?? 1);
}
