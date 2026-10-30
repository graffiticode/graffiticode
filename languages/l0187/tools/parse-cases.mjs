// SPDX-License-Identifier: MIT
//
// Parses L0187's test programs with @graffiticode/parser and L0187's generated lexicon, so the
// Rust tests can compile them (there is no Rust parser; the API parses upstream the same way).
//
//   node tools/parse-cases.mjs          write crates/core/tests/cases.json
//   node tools/parse-cases.mjs --check  exit 1 if cases.json is not what the sources parse to
//
// Sources: crates/core/tests/programs/*.gc, one program per file, named for the case. A file
// whose name starts with `invalid-` is a program the compiler must reject.
//
// The lexicon is generated/lexicon.json (`npm run emit`), so cases.json is stale whenever the
// vocabulary or a program changes; --check catches both.
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parser } from "@graffiticode/parser";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const programs = join(root, "crates/core/tests/programs");
const out = join(root, "crates/core/tests/cases.json");
const lexicon = JSON.parse(readFileSync(join(root, "generated/lexicon.json"), "utf8"));

const cases = [];
for (const file of readdirSync(programs).filter((f) => f.endsWith(".gc")).sort()) {
  const src = readFileSync(join(programs, file), "utf8");
  const log = console.log;
  console.log = () => {};
  let ast;
  try {
    ast = await parser.parse(187, src, structuredClone(lexicon));
  } finally {
    console.log = log;
  }
  cases.push({ name: file.slice(0, -3), src, ast });
}
const text = "[\n" + cases.map((c) => JSON.stringify(c)).join(",\n") + "\n]\n";

if (process.argv.includes("--check")) {
  let current = null;
  try {
    current = readFileSync(out, "utf8");
  } catch {}
  if (current !== text) {
    console.error("crates/core/tests/cases.json is stale: run `npm run cases`");
    process.exit(1);
  }
  console.log(`cases.json is current (${cases.length} cases)`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${cases.length} cases`);
}
process.exit(0);
