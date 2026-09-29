// SPDX-License-Identifier: MIT
/**
 * Integrity gate for a generated corpus batch.
 *
 * Runs between `create-items-from-prompts` and the download/embed steps, because those two
 * publish whatever they are given: a bad program that reaches training_examples is retrieved by
 * every later generation and teaches the mistake. The corpus is the one artifact where a defect
 * compounds instead of staying put.
 *
 * Checks each entry in a codegen mapping file:
 *   1. the pipeline says it compiled, with a taskId and an item
 *   2. it PARSES AND COMPILES here, against this repo's compiler — not merely that the pipeline
 *      said so. Asserting on compiled behaviour rather than a status flag is the rule that keeps
 *      being re-learned on this stack.
 *   3. the compiled output has the shape the renderer reads (interaction.type === "table")
 *   4. it is written in L0179's surface, with no L0166 chained-attribute syntax
 *
 * Exit 0 = safe to publish; exit 1 = do not embed this batch.
 *
 * Usage: node tools/check-corpus.mjs <mapping.json> [--quiet]
 */
import { readFileSync } from "fs";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "../dist/index.js";

const file = process.argv[2];
const quiet = process.argv.includes("--quiet");
if (!file) {
  console.error("usage: node tools/check-corpus.mjs <mapping.json>");
  process.exit(2);
}

const raw = JSON.parse(readFileSync(file, "utf-8"));
const rows = Array.isArray(raw) ? raw : (raw.examples || raw.entries || raw.results || []);
if (!rows.length) {
  console.error(`[integrity] ${file}: no entries — refusing to pass a vacuous check`);
  process.exit(1);
}

// L0166's chained form: `cell A1 text "x"` — an address followed directly by an attribute word
// rather than by a bracket list. If this appears, the generator wrote the OLD language.
const CHAINED = /\b(cell\s+[A-Z][0-9]+|column\s+[A-Z]|row\s+\d+)\s+(?!\[)[a-z-]+\s/;

function compileSrc(src) {
  return (async () => {
    const code = await parser.parse(179, src, lexicon);
    const bad = Object.values(code).find((n) => n && n.tag === "ERROR");
    if (bad) throw new Error(`parse error ${JSON.stringify(bad.elts)}`);
    return await new Promise((res, rej) =>
      compiler.compile(code, {}, {}, (e, v) => {
        const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
        if (errs.length) rej(new Error(errs.map((x) => x.message || x).join("; ")));
        else res(v);
      }));
  })();
}

const failures = [];
let ok = 0;
let fixRounds = 0;

for (const r of rows) {
  const n = r.exampleNumber ?? r.exampleId ?? "?";
  const src = r.generatedCode || r.normalizedCode || r.code;
  const fail = (why) => failures.push(`example ${n}: ${why}`);

  if (!src) { fail("no generated code"); continue; }
  if (r.compiled === false) { fail(`pipeline reported not compiled${r.error ? ` — ${r.error}` : ""}`); continue; }
  if (!r.taskId) { fail("no taskId"); continue; }
  if (!r.firestoreItemId) { fail("no item created"); continue; }
  if (CHAINED.test(src)) { fail("L0166 chained syntax in the source"); continue; }
  if (!/^\s*sheets\s*\[/m.test(src)) { fail("does not open with a `sheets` list"); continue; }

  fixRounds += r.fixAttempts || 0;

  try {
    const out = await compileSrc(src);
    if (!out || typeof out !== "object") { fail("compiled to nothing"); continue; }
    if (out.interaction?.type !== "table") { fail(`interaction.type is ${JSON.stringify(out.interaction?.type)}, not "table"`); continue; }
    if (!out.interaction.cells || !Object.keys(out.interaction.cells).length) { fail("compiled with no cells"); continue; }
    ok++;
  } catch (e) {
    fail(`does not compile here: ${String(e.message || e).slice(0, 140)}`);
  }
}

const label = file.replace(/^.*\//, "");
if (failures.length) {
  console.error(`[integrity] ${label}: ${ok}/${rows.length} pass, ${failures.length} FAIL`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("[integrity] NOT publishing this batch to the corpus.");
  process.exit(1);
}
if (!quiet) {
  console.error(`[integrity] ${label}: ${ok}/${rows.length} pass (${fixRounds} repair round${fixRounds === 1 ? "" : "s"} used)`);
}
process.exit(0);
