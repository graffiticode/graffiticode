// SPDX-License-Identifier: MIT
/**
 * Compile spec/latex-to-latex.gc and write it to translatex's src/rules.js.
 *
 *   node tools/emit-translatex-rules.mjs [--check] [--out <path>]
 *
 * This replaces the dead step in translatex's own build. `tools/build.js` there
 * used to fetch `http://graffiticode.com/data?id=0vgCM11vlfA` and write
 * `data.options` into src/rules.js. That URL now 404s, and because `curl` ran
 * without `-f` it exited 0 on the 404, so `JSON.parse` threw on the HTML error
 * page and aborted the build before it compiled anything. The rule set survived
 * only because the write never happened.
 *
 * WHY THE GENERATOR LIVES HERE AND NOT THERE. L0014 depends on translatex — it
 * runs a rule set's own test corpus through TransLaTeX. So translatex cannot
 * depend on L0014 to regenerate its rules without a cycle. The authoring
 * direction is L0014 -> translatex, and this script is that direction. It
 * reaches the sibling checkout by path, which is a build fixture rather than a
 * dependency — the same arrangement L0179's differential test uses to read
 * L0166.
 *
 * `--check` compares instead of writing, and exits non-zero on a difference.
 * That is the useful mode in CI: it catches src/rules.js being hand-edited out
 * of step with the source it is supposed to come from, which is exactly how the
 * rule sets drifted in the first place.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const outIdx = argv.indexOf("--out");
const out = resolve(outIdx >= 0
  ? argv[outIdx + 1]
  : join(pkg, "../../../translatex/src/rules.js"));

const src = readFileSync(join(pkg, "spec/latex-to-latex.gc"), "utf-8");
const code = await parser.parse(14, src, lexicon);
const compiled = await new Promise((res, rej) =>
  compiler.compile(code, {}, {}, (e, v) => {
    const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
    if (errs.length) rej(new Error(errs.map(String).join("; ")));
    else res(v);
  }));

// The exact shape translatex's build produced: the bare assignment, no trailing
// newline. Reproduced rather than tidied, so regenerating an untouched rule set
// is a zero-byte diff against the published artifact.
const body = `export const rules=${JSON.stringify(compiled.options)}`;

if (check) {
  if (!existsSync(out)) {
    console.error(`emit-translatex-rules: ${out} does not exist`);
    process.exit(1);
  }
  const current = readFileSync(out, "utf-8");
  // Compare the VALUE, not the file. A provenance header is a comment and must
  // not count as drift.
  const strip = (s) => s.slice(s.indexOf("export const rules="));
  if (strip(current) === body) {
    console.log(`emit-translatex-rules: ${out} matches spec/latex-to-latex.gc`);
  } else {
    console.error(`emit-translatex-rules: ${out} DIFFERS from spec/latex-to-latex.gc`);
    process.exit(1);
  }
} else {
  const header = [
    "// GENERATED — do not edit.",
    "//",
    "// Authored in L0014 as packages/core/spec/latex-to-latex.gc and written here by",
    "// its tools/emit-translatex-rules.mjs. L0014 is a port of L120, the language",
    "// this rule set was originally written in.",
    "//",
    "// Regenerate:  cd ../l0014 && node packages/core/tools/emit-translatex-rules.mjs",
    "// Verify:      cd ../l0014 && node packages/core/tools/emit-translatex-rules.mjs --check",
    "",
  ].join("\n");
  writeFileSync(out, header + body);
  console.log(`emit-translatex-rules: wrote ${out}`);
}
