#!/usr/bin/env node
// Builds the pre-W4 production code for AT-12's rollback tests (capability
// plan W4, section G; scripts/test/at12-rollback.test.js): common, Policy and
// Broker as released in W3 (commit c6ae2ad, policy-rmux0jmj2 and
// broker-rmux0u0z2), in a detached git worktree at .at12-baseline/. The tests
// load those builds beside the current ones, so they exercise the actual old
// code, not a new build configured to imitate it.
//
//   node scripts/at12-baseline.js      build it, or reuse a build of the same commit
//
// Needs the commit in the local history (CI checks out with full history).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BASELINE_COMMIT = "c6ae2adb882631bc3e78d93d4e2010813042dbcb";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_DIR = path.join(ROOT, ".at12-baseline");
const MARKER = path.join(BASELINE_DIR, ".at12-built");

const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

const main = () => {
  if (existsSync(MARKER) && readFileSync(MARKER, "utf8").trim() === BASELINE_COMMIT) {
    console.log(`at12 baseline ${BASELINE_COMMIT.slice(0, 7)} already built at ${BASELINE_DIR}`);
    return;
  }
  if (existsSync(BASELINE_DIR)) run("git", ["worktree", "remove", "--force", BASELINE_DIR]);
  run("git", ["worktree", "add", "--detach", BASELINE_DIR, BASELINE_COMMIT]);
  run("npm", ["ci", "--no-audit", "--no-fund"], BASELINE_DIR);
  run("npm", ["run", "build"], BASELINE_DIR);
  writeFileSync(MARKER, `${BASELINE_COMMIT}\n`);
  console.log(`built at12 baseline ${BASELINE_COMMIT.slice(0, 7)} at ${BASELINE_DIR}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
