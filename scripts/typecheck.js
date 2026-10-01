// Type-checks each workspace package's sources (tsconfig.json) and tests
// (tsconfig.test.json), each no-emit, and reports every result (it does not
// stop at the first failure).
// Also fails a package whose `@ts-expect-error TS-MIGRATE:` suppressions
// exceed its budget in scripts/ts-migrate-budget.json, so they only go down.
//
//   node scripts/typecheck.js [package ...]   default: all packages below

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["common", "auth", "auth-client", "policy", "broker", "deploy", "api"];
const BUDGET = JSON.parse(readFileSync(path.join(ROOT, "scripts", "ts-migrate-budget.json"), "utf8"));

const SPEC = /\.(spec|test)\.[cm]?[jt]s$/;
// Suppressions in a package's sources (src/, specs excluded) or its tests
// (src/**/*.spec.js plus test/), counted against separate budgets.
const suppressions = (pkg, tests) => {
  const dirs = tests ? ["src", "test"] : ["src"];
  let n = 0;
  for (const dir of dirs.map(d => path.join(ROOT, "packages", pkg, d))) {
    let files;
    try { files = readdirSync(dir, { recursive: true }); } catch { continue; }
    for (const file of files) {
      if (!/\.[cm]?[jt]s$/.test(file)) continue;
      const isTest = SPEC.test(file) || dir.endsWith(`${path.sep}test`);
      if (isTest !== tests) continue;
      n += (readFileSync(path.join(dir, file), "utf8").match(/@ts-expect-error TS-MIGRATE:/g) || []).length;
    }
  }
  return n;
};

const failed = [];
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : PACKAGES) {
  for (const [config, key, tests] of [["tsconfig.json", name, false], ["tsconfig.test.json", `${name}:test`, true]]) {
    const run = spawnSync("npx", ["tsc", "-p", `packages/${name}/${config}`, "--pretty", "false"], { cwd: ROOT, encoding: "utf8" });
    const errors = (run.stdout.match(/error TS\d+/g) || []).length;
    process.stdout.write(run.stdout);
    const used = suppressions(name, tests);
    const budget = BUDGET[key] ?? 0;
    const overBudget = used > budget;
    console.log(`=== ${key}: ${run.status === 0 ? "ok" : `${errors} error(s)`}, ${used}/${budget} TS-MIGRATE suppressions${overBudget ? " (OVER BUDGET)" : ""}`);
    if (run.status !== 0 || overBudget) failed.push(key);
  }
}
if (failed.length) {
  console.error(`typecheck failed: ${failed.join(", ")}`);
  process.exit(1);
}
