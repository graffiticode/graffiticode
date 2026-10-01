// Type-checks each workspace package with its own no-emit tsconfig and
// reports every package's result (it does not stop at the first failure).
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

const suppressions = dir => readdirSync(dir, { recursive: true })
  .filter(file => /\.[cm]?[jt]s$/.test(file))
  .reduce((n, file) => n + (readFileSync(path.join(dir, file), "utf8").match(/@ts-expect-error TS-MIGRATE:/g) || []).length, 0);

const failed = [];
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : PACKAGES) {
  const run = spawnSync("npx", ["tsc", "-p", `packages/${name}`, "--pretty", "false"], { cwd: ROOT, encoding: "utf8" });
  const errors = (run.stdout.match(/error TS\d+/g) || []).length;
  process.stdout.write(run.stdout);
  const used = suppressions(path.join(ROOT, "packages", name, "src"));
  const budget = BUDGET[name] ?? 0;
  const overBudget = used > budget;
  console.log(`=== ${name}: ${run.status === 0 ? "ok" : `${errors} error(s)`}, ${used}/${budget} TS-MIGRATE suppressions${overBudget ? " (OVER BUDGET)" : ""}`);
  if (run.status !== 0 || overBudget) failed.push(name);
}
if (failed.length) {
  console.error(`typecheck failed: ${failed.join(", ")}`);
  process.exit(1);
}
