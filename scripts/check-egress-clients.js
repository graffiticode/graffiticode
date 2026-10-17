#!/usr/bin/env node
// ISOLATE-01: every language server's outbound HTTP must be able to go through
// the egress proxy. Three checks over languages/:
//
//   Rust: no reqwest client is built anywhere but the kernel's egress helper
//   (languages/l0000/crates/core/src/egress.rs), apart from the reviewed
//   exceptions below, whether by its full path (reqwest::Client::new) or by a
//   name a `use reqwest::...` brings in (Client::builder, or an alias). Tests
//   are exempt.
//
//   Chrome: a headless browser reads neither the proxy variables nor the
//   dispatcher, so any file that launches one must also call the launch helper
//   that adds the proxy and the CA: chrome_egress (Rust, l0013 capture's
//   egress.rs) or prepareChromeEgress (Node, l0013 core's chrome-egress.ts).
//   The rule is per file: a launch in a file that never calls the helper fails.
//
//   Node: every language server's src/main.ts (and L0014's TransLaTeX worker)
//   imports "@graffiticode/l0000/egress" before anything else. Until
//   @graffiticode/l0000 0.11 is published (rollout step 2), a language that
//   can't install it yet is reported as pending, not failed; REQUIRED lists
//   the ones that must pass now. After the publish, every entry is required.
//
//   node scripts/check-egress-clients.js [--json]

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const LANGUAGES = path.join(ROOT, "languages");

export const HELPER = "languages/l0000/crates/core/src/egress.rs";

// Reviewed places that build their own reqwest client, and why.
export const RUST_EXCEPTIONS = {
  "languages/l0185/crates/core/src/fetch.rs":
    "L0185's guarded fetcher (D2): direct mode keeps its own resolver; proxy mode builds from egress::client_builder_with",
};

// Languages whose bootstrap must already pass: they build against this
// repository's l0000 (or are l0000), so they don't wait on the publish.
export const REQUIRED = new Set(["l0000"]);

export const BOOTSTRAP = "import \"@graffiticode/l0000/egress\";";

const CLIENT = /\breqwest::(blocking::)?(Client::(new|builder|default)|ClientBuilder::new)\s*\(/;

// What `use reqwest::...;` statements bring in: the local names of Client (and
// blocking::Client) and of ClientBuilder.
export function importedClientNames(source) {
  const client = new Set();
  const builder = new Set();
  for (const [, body] of source.matchAll(/\buse\s+reqwest::([^;]+);/g)) {
    const trimmed = body.trim();
    const items = trimmed.startsWith("{") ? trimmed.slice(1, -1).split(",") : [trimmed];
    for (const item of items) {
      const m = item.trim().match(/^(?:blocking::)?(Client|ClientBuilder)(?:\s+as\s+(\w+))?$/);
      if (!m) continue;
      (m[1] === "Client" ? client : builder).add(m[2] ?? m[1]);
    }
  }
  return { client, builder };
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A call that builds a client through an imported name (not a path ending in it).
function importedClientCall(names) {
  const alternatives = [
    ...[...names.client].map(n => `${escape(n)}::(new|builder|default)`),
    ...[...names.builder].map(n => `${escape(n)}::(new|default)`),
  ];
  return alternatives.length ? new RegExp(`(?<![\\w:])(${alternatives.join("|")})\\s*\\(`) : null;
}

// Launching a browser, and the helper that must accompany it, per runtime.
export const CHROME = {
  rust: {
    launch: /\bBrowser::launch\s*\(|\bBrowserConfig::builder\s*\(|\bLaunchOptions(::default_builder|\s*\{)|\bCommand::new\(\s*"[^"]*chrom/i,
    helper: /\bchrome_egress\s*\(/,
    name: "chrome_egress",
  },
  node: {
    launch: /\b(puppeteer|chromium)\.launch\s*\(|\b(spawn|execFile)\(\s*["'`][^"'`]*chrom/i,
    helper: /\bprepareChromeEgress\s*\(/,
    name: "prepareChromeEgress",
  },
};

const isTest = file => /\/tests?\//.test(file) || /\/benches\//.test(file) || /\.(test|spec)\.[cm]?[jt]s$/.test(file);

const code = line => !line.trim().startsWith("//") && !line.trim().startsWith("*");

// Files that launch a browser without calling the runtime's egress helper.
export function chromeFindings(files) {
  const findings = [];
  for (const { file, source } of files) {
    if (isTest(file)) continue;
    const kind = file.endsWith(".rs") ? CHROME.rust : CHROME.node;
    const lines = (file.endsWith(".rs") ? withoutTestModules(source) : source).split("\n");
    if (lines.some(l => code(l) && kind.helper.test(l))) continue;
    lines.forEach((line, i) => {
      if (code(line) && kind.launch.test(line)) findings.push({ file, line: i + 1, text: line.trim(), helper: kind.name });
    });
  }
  return findings;
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (["target", "node_modules", "dist", "static", ".git"].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = file => path.relative(ROOT, file).split(path.sep).join("/");

// Strips `#[cfg(test)] mod ... { ... }` blocks so unit tests may build clients.
export function withoutTestModules(source) {
  let out = source;
  for (let i = out.indexOf("#[cfg(test)]"); i !== -1; i = out.indexOf("#[cfg(test)]")) {
    const open = out.indexOf("{", i);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (; end < out.length; end++) {
      if (out[end] === "{") depth++;
      else if (out[end] === "}" && --depth === 0) break;
    }
    out = out.slice(0, i) + out.slice(end + 1);
  }
  return out;
}

export function rustFindings(files) {
  const findings = [];
  for (const { file, source } of files) {
    if (file === HELPER || file in RUST_EXCEPTIONS) continue;
    if (/\/tests\//.test(file) || /\/benches\//.test(file)) continue;
    const body = withoutTestModules(source);
    const imported = importedClientCall(importedClientNames(body));
    body.split("\n").forEach((line, i) => {
      if (!code(line)) return;
      if (CLIENT.test(line) || imported?.test(line)) findings.push({ file, line: i + 1, text: line.trim() });
    });
  }
  return findings;
}

// The first import statement must be the egress bootstrap. Comments and blank
// lines before it are fine.
export function bootstrapState(source) {
  const first = source
    .split("\n")
    .map(l => l.trim())
    .find(l => l && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*") && !l.startsWith("#!"));
  return first === BOOTSTRAP ? "ok" : "missing";
}

export function nodeFindings(entries) {
  return entries.map(({ lang, file, source }) => {
    const state = bootstrapState(source);
    return { lang, file, state: state === "ok" ? "ok" : REQUIRED.has(lang) ? "fail" : "pending" };
  });
}

async function collect() {
  const langs = (await readdir(LANGUAGES, { withFileTypes: true })).filter(d => d.isDirectory() && /^l\d{4}$/.test(d.name)).map(d => d.name);
  const rust = [];
  const node = [];
  const scripts = [];
  for (const lang of langs) {
    for (const file of (await walk(path.join(LANGUAGES, lang, "crates"))).filter(f => f.endsWith(".rs"))) {
      rust.push({ file: rel(file), source: await readFile(file, "utf8") });
    }
    for (const dir of ["packages", "tools"]) {
      for (const file of (await walk(path.join(LANGUAGES, lang, dir))).filter(f => /\.(ts|js|mjs|cjs)$/.test(f) && !f.endsWith(".d.ts"))) {
        scripts.push({ file: rel(file), source: await readFile(file, "utf8") });
      }
    }
    for (const entry of [path.join(LANGUAGES, lang, "packages/api/src/main.ts"), path.join(LANGUAGES, lang, "tools/translatex-worker.mjs")]) {
      try {
        node.push({ lang, file: rel(entry), source: await readFile(entry, "utf8") });
      } catch {}
    }
  }
  return { rust, node, scripts };
}

async function main() {
  const { rust, node, scripts } = await collect();
  const clients = rustFindings(rust);
  const browsers = chromeFindings([...rust, ...scripts]);
  const bootstraps = nodeFindings(node);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ clients, browsers, bootstraps }, null, 2));
  } else {
    for (const f of clients) console.log(`FAIL ${f.file}:${f.line} builds its own reqwest client (use egress::client_builder): ${f.text}`);
    for (const f of browsers) console.log(`FAIL ${f.file}:${f.line} launches a browser without ${f.helper} (the egress proxy and its CA): ${f.text}`);
    for (const b of bootstraps) if (b.state !== "ok") console.log(`${b.state === "fail" ? "FAIL" : "pending"} ${b.file} does not import "@graffiticode/l0000/egress" first`);
    const ok = bootstraps.filter(b => b.state === "ok").length;
    const pending = bootstraps.filter(b => b.state === "pending").length;
    console.log(`egress: ${clients.length} stray Rust clients; ${browsers.length} browser launches without the proxy; Node bootstrap ${ok} ok, ${pending} pending the l0000 publish, ${bootstraps.filter(b => b.state === "fail").length} failing`);
  }
  if (clients.length || browsers.length || bootstraps.some(b => b.state === "fail")) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
