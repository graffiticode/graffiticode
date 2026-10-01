// Compares two builds of packages/*/dist by normalized AST: each emitted .js
// is parsed with acorn and compared with locations, comments, raw literal
// text and source maps ignored, so only executable differences are reported.
//
//   node scripts/compare-emit.js <rootA> <rootB>   compare two checkouts' builds
//   node scripts/compare-emit.js --base <git-ref>  build <git-ref> in a fresh
//       worktree (npm ci + clean build, with its own committed settings) and
//       compare it with this checkout's current build (run build:clean first)
//
// Conversion PRs must report no differences. Build/config PRs list and
// explain each one. Exits 1 when the builds differ.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const emitted = root => {
  const files = new Map();
  const packages = path.join(root, "packages");
  for (const pkg of readdirSync(packages)) {
    const dist = path.join(packages, pkg, "dist");
    if (!existsSync(dist)) continue;
    for (const file of readdirSync(dist, { recursive: true })) {
      if (/\.[cm]?js$/.test(file)) files.set(path.join(pkg, "dist", file), path.join(dist, file));
    }
  }
  return files;
};

const DROP = new Set(["start", "end", "loc", "range"]);
const normalize = node => {
  if (Array.isArray(node)) return node.map(normalize);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROP.has(key)) continue;
    // Raw text only matters where the value cannot carry it.
    if (key === "raw" && node.type === "Literal" && !node.regex && node.bigint === undefined) continue;
    out[key] = normalize(value);
  }
  return out;
};

const ast = file => normalize(parse(readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "module" }));

const firstDifference = (a, b, at = "") => {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const found = firstDifference(a[key], b[key], `${at}.${key}`);
      if (found) return found;
    }
  }
  const show = v => JSON.stringify(v)?.slice(0, 160);
  return `${at || "<root>"}: ${show(a)} → ${show(b)}`;
};

export const compare = (rootA, rootB) => {
  const a = emitted(rootA);
  const b = emitted(rootB);
  const differences = [];
  for (const file of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!a.has(file)) differences.push(`only in B: ${file}`);
    else if (!b.has(file)) differences.push(`only in A: ${file}`);
    else {
      const found = firstDifference(ast(a.get(file)), ast(b.get(file)));
      if (found) differences.push(`differs: ${file}\n    ${found}`);
    }
  }
  return { files: new Set([...a.keys(), ...b.keys()]).size, differences };
};

const sh = (cmd, args, cwd) => {
  const run = spawnSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (run.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}`);
  return run.stdout;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let rootA;
  let rootB;
  let cleanup = () => {};
  if (args[0] === "--base" && args[1]) {
    const dir = mkdtempSync(path.join(tmpdir(), "compare-emit-"));
    rootA = path.join(dir, "base");
    rootB = ROOT;
    sh("git", ["worktree", "add", "--detach", rootA, args[1]], ROOT);
    cleanup = () => { spawnSync("git", ["worktree", "remove", "--force", rootA], { cwd: ROOT }); rmSync(dir, { recursive: true, force: true }); };
    try {
      console.error(`building ${args[1]} in ${rootA} (npm ci + clean build)…`);
      sh("npm", ["ci", "--silent"], rootA);
      sh("node", ["scripts/clean-build.js"], rootA);
    } catch (err) { cleanup(); throw err; }
  } else if (args.length === 2) {
    [rootA, rootB] = args.map(p => path.resolve(p));
  } else {
    console.error("usage: node scripts/compare-emit.js <rootA> <rootB> | --base <git-ref>");
    process.exit(2);
  }
  try {
    const { files, differences } = compare(rootA, rootB);
    for (const line of differences) console.log(line);
    console.log(`${files} emitted file(s) compared, ${differences.length} difference(s)`);
    process.exitCode = differences.length ? 1 : 0;
  } finally {
    cleanup();
  }
}
