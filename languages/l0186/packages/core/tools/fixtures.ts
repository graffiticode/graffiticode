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
// The fidelity board: every node type, every shape kind and every connector option, drawn by
// the plugin and by the view and compared side by side (see packages/view/fixtures/).
const kinds = ["SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN", "PARALLELOGRAM_RIGHT", "PARALLELOGRAM_LEFT", "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER", "TRAPEZOID", "PREDEFINED_PROCESS", "SHIELD", "DOCUMENT_SINGLE", "DOCUMENT_MULTIPLE", "MANUAL_INPUT", "HEXAGON", "CHEVRON", "PENTAGON", "OCTAGON", "STAR", "PLUS", "ARROW_LEFT", "ARROW_RIGHT", "SUMMING_JUNCTION", "OR", "SPEECH_BUBBLE", "INTERNAL_STORAGE"];
const shapes = kinds.map((k, i) => `shape kind ${k} id "${k}" text "${k.toLowerCase().replace(/_/g, " ")}" x ${(i % 6) * 260} y ${Math.floor(i / 6) * 260} {}`).join("\n    ");
const caps = ["NONE", "ARROW_LINES", "ARROW_EQUILATERAL", "TRIANGLE_FILLED", "CIRCLE_FILLED", "DIAMOND_FILLED"];
const capRows = caps.map((c, i) => `sticky id "c${i}a" text "${c.toLowerCase()}" x 0 y ${i * 300} {}
    sticky id "c${i}b" text "to" x 600 y ${i * 300} fill "blue" {}
    connector from "c${i}a" to "c${i}b" to-cap ${c} from-cap ${c} label "${c.toLowerCase()}" {}`).join("\n    ");
programs.push({
  from: "fidelity: shapes",
  src: `board [ page [
    ${shapes}
  ] name "Shapes" {} page [
    ${capRows}
    sticky id "s" text "Straight" x 1000 y 0 {} sticky id "e" text "Elbowed" x 1400 y 400 {} sticky id "c" text "Curved" x 1000 y 800 {}
    connector from "s" to "e" line-type STRAIGHT stroke "red" stroke-width THICK {}
    connector from "e" to "c" line-type ELBOWED line-style DASHED {}
    connector from "c" to "s" line-type CURVED from-side LEFT to-side LEFT {}
  ] name "Connectors" {} page [
    section [ sticky text "A" x 0 y 0 {} sticky text "B much longer text that has to wrap and shrink to fit inside the note" x 280 y 0 fill "pink" {} ] name "Section" x 0 y 0 {}
    textbox text "Small" font-size SMALL x 0 y -200 {} textbox text "Huge" font-size HUGE color "purple" x 200 y -260 {}
    stamp kind LIKE x 700 y 0 {} stamp kind LOVE x 760 y 0 {} stamp kind LAUGH x 820 y 0 {}
    stamp kind SURPRISED x 880 y 0 {} stamp kind CELEBRATE x 940 y 0 {} stamp kind HEART x 1000 y 0 {}
    shape kind ROUNDED_RECTANGLE text "Faded" x 700 y 100 opacity 40 fill "green" {}
  ] name "Nodes" background "#fafafa" {} ] title "Fidelity" {}..`,
});
const out = [];
for (const p of programs) out.push({ from: p.from, src: p.src, data: await compile(p.src) });
writeFileSync("../view/embed/fixtures.json", JSON.stringify(out, null, 1));
console.log(`wrote ${out.length} fixtures`);
