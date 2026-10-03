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
// Browser acceptance: a large table (paging), a JSON tree, a single record, and an empty result.
programs.push({ from: "acceptance: large table", src: `fetch "https://l0185.graffiticode.org/data/photos.json" {}..` });
programs.push({ from: "acceptance: JSON tree", src: `fetch "https://l0185.graffiticode.org/data/nested.json" {}..` });
programs.push({ from: "acceptance: one record", src: `summarize {people: COUNT} fetch "https://l0185.graffiticode.org/data/people.json" {}..` });
programs.push({ from: "acceptance: no records", src: `where ["age" ABOVE 1000] fetch "https://l0185.graffiticode.org/data/people.json" {}..` });
const out = [];
for (const p of programs) out.push({ from: p.from, src: p.src, data: await compile(p.src) });
writeFileSync("../view/embed/fixtures.json", JSON.stringify(out, null, 1));
console.log(`wrote ${out.length} fixtures`);
