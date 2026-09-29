// SPDX-License-Identifier: MIT
/**
 * Integrity gate for the corpus ABOUT TO BE EMBEDDED — the downloaded markdown, not a batch's
 * mapping file.
 *
 * The per-batch gate (check-corpus.mjs) has a hole: `create-items-from-prompts` writes its items
 * before the gate ever runs, so a batch that FAILS the gate still leaves those items in
 * Firestore, and the next `download-training-examples` sweeps them into the corpus regardless.
 * That happened here — a program with no cells and a numeric font-size reached the published
 * corpus from a batch that had already been rejected.
 *
 * Checking the downloaded file closes it, because this is the exact text that becomes
 * training_examples. Whatever produced an entry, it must compile.
 *
 * Usage: node tools/check-published.mjs <training-examples.md>
 */
import { readFileSync } from "fs";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "../dist/index.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/check-published.mjs <training-examples.md>");
  process.exit(2);
}

const md = readFileSync(file, "utf-8");
const entries = md
  .split(/\n### Example /)
  .slice(1)
  .map((chunk, i) => {
    const code = chunk.match(/#### Code\n\n```\n([\s\S]*?)\n```/);
    const prompt = chunk.match(/#### Prompt\n"?(.*?)"?\n/);
    return code ? { n: i + 1, src: code[1], prompt: prompt ? prompt[1] : "" } : null;
  })
  .filter(Boolean);

if (!entries.length) {
  console.error(`[published] ${file}: no examples parsed — refusing to pass a vacuous check`);
  process.exit(1);
}

const failures = [];
for (const e of entries) {
  try {
    const code = await parser.parse(179, e.src, lexicon);
    const bad = Object.values(code).find((n) => n && n.tag === "ERROR");
    if (bad) throw new Error(`parse error ${JSON.stringify(bad.elts)}`);
    const out = await new Promise((res, rej) =>
      compiler.compile(code, {}, {}, (err, v) => {
        const errs = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
        if (errs.length) rej(new Error(errs.map((x) => x.message || x).join("; ")));
        else res(v);
      }));
    if (out?.interaction?.type !== "table" || !Object.keys(out.interaction.cells || {}).length) {
      failures.push(`entry ${e.n} ("${e.prompt.slice(0, 50)}"): compiles to no usable grid`);
    }
  } catch (err) {
    failures.push(`entry ${e.n} ("${e.prompt.slice(0, 50)}"): ${String(err.message || err).slice(0, 120)}`);
  }
}

const label = file.replace(/^.*\//, "");
if (failures.length) {
  console.error(`[published] ${label}: ${entries.length - failures.length}/${entries.length} pass, ${failures.length} FAIL`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("[published] NOT embedding — a bad example here is retrieved by every later generation.");
  process.exit(1);
}
console.error(`[published] ${label}: all ${entries.length} compile ✓`);
process.exit(0);
