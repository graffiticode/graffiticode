// Upgrades every language in languages/ that depends on a shared package (@graffiticode/l0000,
// @graffiticode/l0000-view), then releases each one with the deploy CLI
// (`npm run deploy -- lNNNN`). The entry points in scripts/ name the package:
//
//   npm run upgrade-l0000-and-deploy [-- --lang 0177 0184] [--no-force] [--plan] [--verbose]
//   npm run upgrade-l0000-view-and-deploy [-- ...same flags]
//
//   --lang 0177 0184   only these languages
//   --no-force         don't redeploy languages that were already up to date
//   --plan             upgrade nothing; run each deploy as `--plan` (no cloud calls)
//   --verbose          stream command output
//
// The languages share this one Git workspace, so the work runs in three phases:
//   1. upgrade + test each language in parallel (separate directories and lockfiles);
//   2. commit each passing upgrade one at a time (one Git index), then push once;
//   3. deploy in batches (the deploy CLI locks per service, so languages can run at once).
// A language whose upgrade fails its tests is reverted and neither committed nor deployed.

import { spawn } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const BATCH_SIZE = 5;
const FORCE_DEPLOY = !process.argv.includes("--no-force");
const PLAN = process.argv.includes("--plan");
const VERBOSE = process.argv.includes("--verbose");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LANGUAGES_DIR = resolve(ROOT, "languages");

function parseLangs() {
  const idx = process.argv.indexOf("--lang");
  if (idx === -1) return null;
  const langs = [];
  for (let i = idx + 1; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--")) break;
    langs.push(process.argv[i].replace(/^l/i, ""));
  }
  return langs.length > 0 ? langs : null;
}
const LANGS = parseLangs();

function run(cmd, cwd, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    // ALWAYS pipe, and tee to our own streams when verbose. `stdio: "inherit"` hands the
    // child our terminal directly, so nothing reaches the `data` handlers and the output
    // resolves as the empty string -- and callers branch on what they read back:
    // `git status --porcelain` returning "" reads as "clean".
    const child = spawn("bash", ["-c", cmd], { cwd, stdio: "pipe" });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Timed out")); }, timeoutMs);
    let output = "";
    child.stdout.on("data", d => { output += d; if (VERBOSE) process.stdout.write(d); });
    child.stderr.on("data", d => { output += d; if (VERBOSE) process.stderr.write(d); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(output.slice(-500) || `Exit code ${code}`));
      else resolve(output);
    });
  });
}

function findLanguages(services, { PKG_NAME, TARGET_PKG }) {
  return readdirSync(LANGUAGES_DIR)
    .filter(name => /^l\d{4}$/.test(name))
    .filter(name => !LANGS || LANGS.includes(name.slice(1)))
    .filter(name => {
      const core = resolve(LANGUAGES_DIR, name, TARGET_PKG, "package.json");
      if (!existsSync(core)) return false;
      const pkg = JSON.parse(readFileSync(core, "utf-8"));
      // Only languages that depend on PKG_NAME; skip the package itself.
      if (pkg.name === PKG_NAME || !pkg.dependencies?.[PKG_NAME]) return false;
      if (!services[name]) {
        console.log(`[${name}] No deploy.json entry, skipping`);
        return false;
      }
      if (services[name].blocked) {
        console.log(`[${name}] Blocked in deploy.json, skipping: ${services[name].blocked}`);
        return false;
      }
      return true;
    })
    .sort();
}

async function upgrade(name, version, { PKG_NAME, TARGET_PKG }) {
  const dir = resolve(LANGUAGES_DIR, name);
  try {
    console.log(`[${name}] Upgrading to ${PKG_NAME}@${version}...`);
    await run(`npm i ${PKG_NAME}@${version}`, resolve(dir, TARGET_PKG));
    const changed = Boolean((await run("git status --porcelain -- .", dir)).trim());
    if (changed) {
      // Gate locally so a breaking upgrade is never committed. Cloud Build runs the
      // language's tests again before anything is deployed.
      const scripts = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8")).scripts ?? {};
      const gate = scripts.test ? "test" : scripts.build ? "build" : null;
      if (gate) await run(`npm run ${gate}`, dir, 15 * 60 * 1000);
    }
    console.log(`[${name}] ${changed ? "Upgraded" : "Already up to date"}`);
    return { name, ok: true, changed };
  } catch (err) {
    console.error(`[${name}] Upgrade FAILED, reverting`);
    await run("git checkout -- . && git clean -fdq -- .", dir).catch(() => {});
    return { name, ok: false, error: (err.message || "").slice(-500) };
  }
}

async function deploy(name, service) {
  try {
    // The deploy CLI refuses a dirty workspace unless --allow-dirty. Uncommitted files
    // elsewhere in the repo never enter this language's snapshot, so allow them only once
    // the language's own snapshot paths are verified clean.
    const paths = service.include ?? [`languages/${name}`];
    const dirty = (await run(`git status --porcelain --untracked-files=all -- ${paths.join(" ")}`, ROOT)).trim();
    if (dirty && !PLAN) throw new Error(`Uncommitted changes in ${paths.join(", ")}:\n${dirty}`);
    console.log(`[${name}] ${PLAN ? "Planning" : "Deploying"}...`);
    await run(`npm run deploy -- ${name} --allow-dirty${PLAN ? " --plan" : ""}`, ROOT, 30 * 60 * 1000);
    console.log(`[${name}] Done`);
    return { name, ok: true };
  } catch (err) {
    console.error(`[${name}] Deploy FAILED`);
    return { name, ok: false, error: (err.message || "").slice(-500) };
  }
}

async function inBatches(names, fn) {
  const results = [];
  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const batch = names.slice(i, i + BATCH_SIZE);
    console.log(`--- Batch: ${batch.join(" ")} ---`);
    results.push(...await Promise.all(batch.map(fn)));
    console.log("");
  }
  return results;
}

// `pkg` is the package to upgrade; `targetPkg` is the workspace member, in each language,
// that depends on it. Installing there updates the language's one root package-lock.json,
// which is what its Dockerfile's `npm ci` installs from.
export async function upgradeAndDeploy({ pkg, targetPkg }) {
  const PKG_NAME = pkg;
  const TARGET_PKG = targetPkg;
  const SHORT_NAME = pkg.replace(/^@graffiticode\//, "");
  const services = JSON.parse(readFileSync(resolve(ROOT, "deploy.json"), "utf-8")).services;
  const langs = findLanguages(services, { PKG_NAME, TARGET_PKG });
  console.log(`Found ${langs.length} languages that depend on ${PKG_NAME}`);
  langs.forEach(l => console.log(`  ${l}`));
  console.log("");

  const failed = [];
  let toDeploy = langs;

  if (!PLAN) {
    const version = (await run(`npm view ${PKG_NAME} version`, ROOT)).trim();
    const upgraded = await inBatches(langs, l => upgrade(l, version, { PKG_NAME, TARGET_PKG }));
    failed.push(...upgraded.filter(r => !r.ok));

    const changed = upgraded.filter(r => r.ok && r.changed).map(r => r.name);
    for (const name of changed) {
      // Commit only this language's directory: the repo may hold unrelated work.
      await run(`git add -- languages/${name} && git commit -q -m "${name}: upgrade ${SHORT_NAME} to ${version}" -- languages/${name}`, ROOT);
    }
    if (changed.length > 0) {
      await run("git pull --rebase -q && git push -q", ROOT);
      console.log(`Committed and pushed: ${changed.join(" ")}\n`);
    }
    toDeploy = upgraded.filter(r => r.ok && (r.changed || FORCE_DEPLOY)).map(r => r.name);
  }

  const deployed = await inBatches(toDeploy, l => deploy(l, services[l]));
  failed.push(...deployed.filter(r => !r.ok));

  if (failed.length > 0) {
    console.error(`FAILED (${failed.length}):`);
    for (const f of failed) {
      console.error(`  ${f.name}`);
      if (f.error) console.error(`    ${f.error.split("\n").slice(-3).join("\n    ")}`);
    }
    process.exit(1);
  } else {
    console.log(`All ${toDeploy.length} languages ${PLAN ? "planned" : "upgraded and deployed"} successfully`);
  }
}
