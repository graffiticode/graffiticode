// Runs one group of jest targets from scripts/test-targets.json, one at a
// time, and checks each target's skips on its own (scripts/check-skips.js).
//
//   node scripts/run-jest-targets.js unit       no emulator needed
//   node scripts/run-jest-targets.js emulated   run inside ONE emulator session:
//     firebase emulators:exec "node scripts/run-jest-targets.js emulated"
//
// jest is invoked directly rather than through each package's `npm test`,
// because those scripts start their own emulator. Every target runs even if an
// earlier one fails; the exit code is non-zero if any target failed its tests
// or its skip check. Results are written to .jest-results/<target>.json.

import { spawnSync } from "child_process";
import { mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { checkSkips } from "./check-skips.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, ".jest-results");

const group = process.argv[2];
const groups = JSON.parse(readFileSync(resolve(ROOT, "scripts/test-targets.json"), "utf8"));
const targets = groups[group];
if (!targets) {
  console.error(`usage: node scripts/run-jest-targets.js <${Object.keys(groups).join("|")}>`);
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const failures = [];
for (const target of targets) {
  const output = resolve(OUT, `${target.name}.json`);
  console.log(`\n=== ${target.name} (${target.cwd})`);
  const run = spawnSync("npx", ["jest", "--runInBand", "--json", `--outputFile=${output}`, ...(target.args || [])], {
    cwd: resolve(ROOT, target.cwd),
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, "--experimental-vm-modules"].filter(Boolean).join(" ") },
  });
  if (run.status !== 0) failures.push(`${target.name}: jest exited ${run.status ?? run.signal}`);
  let results;
  try {
    results = JSON.parse(readFileSync(output, "utf8"));
  } catch {
    failures.push(`${target.name}: no jest results at ${output}`);
    continue;
  }
  for (const problem of checkSkips(results, target.allowSkips)) failures.push(`${target.name}: ${problem}`);
}

if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`\nall ${targets.length} ${group} targets passed their tests and skip checks`);
