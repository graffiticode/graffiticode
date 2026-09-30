// SPDX-License-Identifier: MIT
// Compile every program in spec/ (and the template) into packages/view/embed/fixtures.json, so
// the view's dev page shows exactly what the compiler emits. Run: npx tsx tools/fixtures.ts
import { readFileSync, writeFileSync } from "fs";
import { compile } from "../src/harness.js";

const programs: { from: string; src: string }[] = [];
for (const f of ["spec/spec.md", "spec/instructions.md"]) {
  let cur: string[] | null = null;
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    if (l.trim().startsWith("```")) {
      if (cur) {
        const src = cur.join("\n");
        if (src.trim().endsWith("..")) programs.push({ from: f, src });
        cur = null;
      } else cur = [];
      continue;
    }
    if (cur) cur.push(l);
  }
}
programs.push({ from: "spec/template.gc", src: readFileSync("spec/template.gc", "utf-8") });
// Browser acceptance: a box plot's legend entry toggles its box and outliers together, and the
// outliers stay on their boxes through a resize, for vertical and horizontal boxes.
for (const [from, axes] of [
  ["acceptance: vertical boxes", `axis direction X categories ["A" "B"] {} axis direction Y {}`],
  ["acceptance: horizontal boxes", `axis direction X {} axis direction Y categories ["A" "B"] {}`],
]) {
  programs.push({
    from,
    src: `charts [ chart [ axes [ ${axes} ] {} plots [
  plot name "Minutes" kind BOXPLOT values [[12 15 14 30 13 16] [22 25 21 24 60 2]] {}
] {} legend show true {} ] {} ] {}..`,
  });
}
const out = [];
for (const p of programs) out.push({ from: p.from, src: p.src, data: await compile(p.src) });
writeFileSync("../view/embed/fixtures.json", JSON.stringify(out, null, 1));
console.log(`wrote ${out.length} fixtures`);
