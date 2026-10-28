#!/usr/bin/env node
// P1b (docs/graffiticode-interpreter-plan.md): the protected registry's
// version is written in three places, and they must agree in the source:
//
//   packages/common/src/protected-registry.ts   REGISTRY_VERSION (Policy, Broker, API)
//   languages/l0176/packages/core/src/compiler.ts   REGISTRY_VERSION (L0176, TypeScript)
//   languages/l0176/crates/core/src/protection.rs   REGISTRY_VERSION (L0176, Rust)
//
// A compiler reports its version in every preflight manifest, and Policy
// admits a plan only under a version it accepts, so a compiler left behind
// fails every admitted compile. Agreeing in the source does not make the
// deployed services agree: a bump is still rolled out across them under the
// window (REGISTRY_WINDOW), Policy and Broker first.
//
//   node scripts/check-registry-version.js [--json]

import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export const SOURCES = [
  { file: "packages/common/src/protected-registry.ts", pattern: /^export const REGISTRY_VERSION = (\d+);$/m },
  { file: "languages/l0176/packages/core/src/compiler.ts", pattern: /^export const REGISTRY_VERSION = (\d+);$/m },
  { file: "languages/l0176/crates/core/src/protection.rs", pattern: /^pub const REGISTRY_VERSION: u32 = (\d+);$/m },
];

// The version each source declares, or null when the declaration is missing.
export const versionsIn = files => SOURCES.map(({ file, pattern }) => {
  const match = pattern.exec(files[file] ?? "");
  return { file, version: match ? Number(match[1]) : null };
});

// Problems with a set of declared versions: a missing declaration, or any
// disagreement with the registry's own.
export const findings = versions => {
  const problems = versions.filter(v => v.version === null).map(v => `${v.file}: no REGISTRY_VERSION declaration found`);
  const [registry] = versions;
  if (registry.version !== null) {
    for (const v of versions.slice(1)) {
      if (v.version !== null && v.version !== registry.version) {
        problems.push(`${v.file}: REGISTRY_VERSION ${v.version}, but ${registry.file} has ${registry.version}`);
      }
    }
  }
  return problems;
};

const main = async () => {
  const files = Object.fromEntries(await Promise.all(SOURCES.map(async ({ file }) =>
    [file, await readFile(path.join(ROOT, file), "utf8").catch(() => "")])));
  const versions = versionsIn(files);
  const problems = findings(versions);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ versions, problems }, null, 2));
  } else {
    for (const v of versions) console.log(`${v.file}: ${v.version ?? "missing"}`);
    for (const p of problems) console.error(`ERROR ${p}`);
    if (!problems.length) console.log("registry versions agree");
  }
  process.exitCode = problems.length ? 1 : 0;
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
