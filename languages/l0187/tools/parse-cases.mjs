// SPDX-License-Identifier: MIT
//
// Parses L0187's test programs with @graffiticode/parser and L0187's generated lexicon, so the
// Rust tests can compile them (there is no Rust parser; the API parses upstream the same way).
//
//   node tools/parse-cases.mjs          write crates/core/tests/cases.json
//   node tools/parse-cases.mjs --check  exit 1 if cases.json is not what the sources parse to
//
// Sources: crates/core/tests/programs/*.gc, one program per file, named for the case (a file
// whose name starts with `invalid-` is a program the compiler must reject), into cases.json; and
// every program in the published docs (spec/*.md ```gc blocks, spec/template.gc) into
// doc-cases.json.
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

async function parse(src) {
  const log = console.log;
  console.log = () => {};
  try {
    return await parser.parse(187, src, structuredClone(lexicon));
  } finally {
    console.log = log;
  }
}

const cases = [];
for (const file of readdirSync(programs).filter((f) => f.endsWith(".gc")).sort()) {
  const src = readFileSync(join(programs, file), "utf8");
  cases.push({ name: file.slice(0, -3), src, ast: await parse(src) });
}

// Every program in the published documentation: each ```gc block in spec/*.md, and the starter
// template. A block fenced ```gc-invalid <code> is a program the compiler must reject with an
// error of that code.
const specDir = join(root, "spec");
const docs = [];
for (const file of readdirSync(specDir).filter((f) => f.endsWith(".md")).sort()) {
  const text = readFileSync(join(specDir, file), "utf8");
  const blocks = [...text.matchAll(/^```(gc(?:-invalid\s+([a-z-]+))?)\n([\s\S]*?)^```$/gm)];
  blocks.forEach((m, i) => {
    docs.push({ name: `${file}#${i + 1}`, expect: m[2] ?? "valid", src: m[3] });
  });
}
docs.push({ name: "template.gc", expect: "valid", src: readFileSync(join(specDir, "template.gc"), "utf8") });
for (const d of docs) {
  d.ast = await parse(d.src);
}

const outputs = [
  [out, "[\n" + cases.map((c) => JSON.stringify(c)).join(",\n") + "\n]\n", cases.length],
  [join(root, "crates/core/tests/doc-cases.json"), "[\n" + docs.map((c) => JSON.stringify(c)).join(",\n") + "\n]\n", docs.length],
];

if (process.argv.includes("--check")) {
  for (const [path, text, n] of outputs) {
    let current = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {}
    if (current !== text) {
      console.error(`${path.slice(root.length + 1)} is stale: run \`npm run cases\``);
      process.exit(1);
    }
    console.log(`${path.slice(root.length + 1)} is current (${n} cases)`);
  }
} else {
  for (const [path, text, n] of outputs) {
    writeFileSync(path, text);
    console.log(`wrote ${n} cases to ${path.slice(root.length + 1)}`);
  }
}
process.exit(0);
