// SPDX-License-Identifier: MIT
//
// Writes packages/view/embed/fixtures.json for the view's dev page (/dev.html): every program in
// spec/ (and the template), with the data the compiler gave for it. The data comes from the
// trusted conformance fixture (crates/core/tests/conformance/cases.json), which records every
// spec program, so no compiler runs (interpreter plan A6).
//
//   node tools/view-fixtures.mjs
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(readFileSync(join(root, "crates/core/tests/conformance/cases.json"), "utf-8"));
const compiled = new Map(cases.filter((c) => !c.data && c.expect?.text).map((c) => [c.src, JSON.parse(c.expect.text)]));

const programs = [];
for (const f of ["spec/spec.md", "spec/instructions.md"]) {
  let cur = null;
  for (const l of readFileSync(join(root, f), "utf-8").split("\n")) {
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
programs.push({ from: "spec/template.gc", src: readFileSync(join(root, "spec/template.gc"), "utf-8") });

const out = [];
const missing = [];
for (const p of programs) {
  if (compiled.has(p.src)) out.push({ from: p.from, src: p.src, data: compiled.get(p.src) });
  else missing.push(p.from);
}
writeFileSync(join(root, "packages/view/embed/fixtures.json"), JSON.stringify(out, null, 1));
console.log(`wrote ${out.length} fixtures${missing.length ? `; not in the conformance fixture: ${missing.length} (${[...new Set(missing)].join(", ")})` : ""}`);
