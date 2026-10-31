// SPDX-License-Identifier: MIT
//
// L0187's corpus gate, run by the console's generate-embeddings-from-examples on the rows it is
// about to embed (graffiticode-app packages/console/scripts/lang-gate.ts finds it by this
// script's npm name, `check-corpus`):
//
//   npm run check-corpus -- <examples.json> [--quiet]
//
// <examples.json> is `[{n, code}]`. Each program is parsed with @graffiticode/parser and the
// committed lexicon (as the API parses it), then compiled by the Rust compiler
// (crates/core/examples/check_corpus.rs). Exit 1, and nothing is embedded, unless every
// program compiles to a board the validator accepted.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parser } from "@graffiticode/parser";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: npm run check-corpus -- <examples.json> [--quiet]");
  process.exit(2);
}
const lexicon = JSON.parse(readFileSync(join(root, "generated/lexicon.json"), "utf8"));
const examples = JSON.parse(readFileSync(file, "utf8"));
const parsed = [];
const log = console.log;
for (const { n, code } of examples) {
  console.log = () => {};
  try {
    parsed.push({ n, ast: await parser.parse(187, String(code), structuredClone(lexicon)) });
  } catch (e) {
    parsed.push({ n, parseError: String(e?.message ?? e) });
  } finally {
    console.log = log;
  }
}
const dir = mkdtempSync(join(tmpdir(), "l0187-gate-"));
const out = join(dir, "parsed.json");
writeFileSync(out, JSON.stringify(parsed));
try {
  execFileSync("cargo", ["run", "-q", "--release", "--example", "check_corpus", "--", out, ...args.filter((a) => a === "--quiet")], {
    cwd: root,
    stdio: "inherit",
  });
} catch (e) {
  process.exit(e.status ?? 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
