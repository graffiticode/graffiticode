// Validates published packages as the exact bytes npm would publish (TS
// migration phase 2c): packs each named package, checks the tarball's file
// list, installs all the tarballs TOGETHER in a temporary project outside the
// workspace with production dependencies only, and imports every library
// export in a fresh Node process.
//
//   node scripts/validate-tarball.js common [auth auth-client ...] [--types] [--keep]
//
//   --types  the tarballs are expected to ship declarations (phase 4); by
//            default any .d.ts / .d.ts.map in a tarball fails validation
//   --keep   keep the temporary project and tarballs, and print their path
//
// Executable exports (an entry that starts a server on import, e.g. auth's
// ".") are not imported here; the artifact gate starts them with readiness
// checks. The packed .tgz files can be published with `npm publish <file>`.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTABLE = { "@graffiticode/auth": ["."] };

const args = process.argv.slice(2);
const names = args.filter(a => !a.startsWith("--"));
const types = args.includes("--types");
const keep = args.includes("--keep");
if (!names.length) {
  console.error("usage: node scripts/validate-tarball.js <package> [...] [--types] [--keep]");
  process.exit(2);
}

const sh = (cmd, cmdArgs, cwd, { timeout } = {}) => {
  const run = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8", timeout });
  return { ok: run.status === 0, out: `${run.stdout ?? ""}${run.stderr ?? ""}`, stdout: run.stdout ?? "" };
};

const work = mkdtempSync(path.join(tmpdir(), "validate-tarball-"));
const problems = [];
try {
  const packed = [];
  for (const name of names) {
    const dir = path.join(ROOT, "packages", name);
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const pack = sh("npm", ["pack", "--json", "--pack-destination", work], dir);
    if (!pack.ok) throw new Error(`npm pack ${name} failed:\n${pack.out}`);
    const [info] = JSON.parse(pack.stdout);
    const files = info.files.map(f => f.path);
    console.log(`${manifest.name}@${manifest.version}: ${info.filename}, ${files.length} files`);
    const declarations = files.filter(f => /\.d\.ts(\.map)?$/.test(f));
    if (!types && declarations.length) problems.push(`${manifest.name}: ships declarations before phase 4: ${declarations.join(", ")}`);
    if (types && !declarations.length) problems.push(`${manifest.name}: --types given but the tarball has no declarations`);
    for (const f of files.filter(f => /(^|\/)src\/|\.tsbuildinfo$|\.spec\.js$/.test(f))) problems.push(`${manifest.name}: unexpected file in tarball: ${f}`);
    const exportsMap = typeof manifest.exports === "string" ? { ".": manifest.exports } : manifest.exports ?? {};
    for (const [subpath, target] of Object.entries(exportsMap)) {
      const file = (typeof target === "string" ? target : target.default).replace(/^\.\//, "");
      if (!files.includes(file)) problems.push(`${manifest.name}: export ${subpath} -> ${file} is not in the tarball`);
    }
    packed.push({ manifest, exportsMap, tgz: path.join(work, info.filename) });
  }

  // Install every tarball together, so a candidate set resolves its own
  // members (e.g. auth's exact common prerelease) rather than the registry's.
  const project = path.join(work, "consumer");
  sh("mkdir", ["-p", project], work);
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "tarball-consumer", private: true, type: "module" }));
  const install = sh("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", ...packed.map(p => p.tgz)], project);
  if (!install.ok) throw new Error(`installing the tarballs failed:\n${install.out}`);

  for (const { manifest, exportsMap } of packed) {
    const installed = JSON.parse(readFileSync(path.join(project, "node_modules", ...manifest.name.split("/"), "package.json"), "utf8"));
    if (installed.version !== manifest.version) problems.push(`${manifest.name}: installed ${installed.version}, expected ${manifest.version}`);
    for (const subpath of Object.keys(exportsMap)) {
      const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
      if ((EXECUTABLE[manifest.name] ?? []).includes(subpath)) {
        console.log(`  ${specifier}: executable export, checked by the artifact gate`);
        continue;
      }
      const run = sh("node", ["--input-type=module", "-e", `const m = await import(${JSON.stringify(specifier)}); console.log(Object.keys(m).length);`], project, { timeout: 20000 });
      if (run.ok) console.log(`  ${specifier}: imports (${run.stdout.trim()} exports)`);
      else problems.push(`${specifier}: import failed:\n${run.out.split("\n").slice(0, 8).join("\n")}`);
    }
  }
} catch (err) {
  problems.push(err.message);
} finally {
  if (keep) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("tarball validation passed");
