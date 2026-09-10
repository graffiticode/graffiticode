// SPDX-License-Identifier: MIT
/**
 * Regenerate spec/latex-to-latex.gc from the compiled rule set.
 *
 *   node tools/gen-latex-rules.mjs
 *
 * WHY THIS EXISTS AT ALL. The rule set TransLaTeX ships was compiled from an
 * L120 program on a host that is gone, and the program itself was never in any
 * repo — it lived in the Graffiticode item store behind gc.acx.ac. What
 * survives is the OUTPUT: `@graffiticode/translatex/src/rules.js`, which is
 * byte-identical to the `data.txt` inside artcompiler-translatex-0.15.0.tgz.
 * So the source is reconstructed from the output rather than found.
 *
 * The reconstruction is not a guess. Two independent things pin it:
 *
 *   1. Identity. src/rules.test.ts compiles what this writes and requires the
 *      result to equal the shipping rule set exactly, key order included —
 *      order is precedence, because translatex's match() takes the first hit in
 *      Object.keys order.
 *
 *   2. Structure. The section headings are not invented. github.com/artcompiler/L120
 *      carries real L120 source in tests/*.json, including an ANCESTOR of this
 *      very rule set (48/49 words, 69/80 rules). Its `|Sets`, `|Trig`,
 *      `|Relational` … headings are lifted from there and mapped onto the
 *      target's own order. That mapping produces ten contiguous runs in exactly
 *      the ancestor's section order with nothing left over — which is itself
 *      evidence the target's rule order IS the authored order, not an artifact
 *      of serialization.
 *
 * Eleven of the eighty rules are newer than the ancestor and have no heading of
 * their own; each inherits the heading of the rule above it, which is what a
 * contiguous section means. The mapping is committed as
 * src/fixtures/latex-to-latex.sections.json so this stays reproducible.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toSource } from "../dist/pretty.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");

const rules = JSON.parse(readFileSync(join(pkg, "src/fixtures/latex-to-latex.json"), "utf-8"));
const sections = JSON.parse(readFileSync(join(pkg, "src/fixtures/latex-to-latex.sections.json"), "utf-8"));

const header = [
  "LaTeX to LaTeX translator.",
  "",
  "The rule set @graffiticode/translatex ships as src/rules.js, as L0014 source.",
  "",
  "It is a RECONSTRUCTION. The original L120 program lived in the item store",
  "behind gc.acx.ac and did not survive; the compiled output did, identically,",
  "in two places — the shipping src/rules.js and the data.txt inside",
  "artcompiler-translatex-0.15.0.tgz. src/rules.test.ts compiles this file and",
  "requires the result to match that output exactly, key order included, so an",
  "edit here that changes the rule set fails the build.",
  "",
  "Rule order is precedence: translatex's match() takes the first pattern that",
  "matches, which is why the catch-all \"?\" is last. Do not reorder.",
  "",
  "Section headings come from an ancestor of this rule set preserved in",
  "github.com/artcompiler/L120 (tests/*.json). Regenerate with",
  "tools/gen-latex-rules.mjs.",
  "",
  "Backslashes are DOUBLED here and were not in L120: the modern parser reads",
  '"\\times" as TAB + "imes". See src/pretty.ts.',
].join("\n");

const out = join(pkg, "spec/latex-to-latex.gc");
writeFileSync(out, toSource({ options: rules, tests: [] }, { header, sections }));
console.log(`gen-latex-rules: wrote ${out}`);
