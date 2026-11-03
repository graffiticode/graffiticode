// SPDX-License-Identifier: MIT
//
// Emits L0174's public spec assets into a directory, from spec/ alone: no compiler is imported
// (interpreter plan A6: the Rust server's static assets don't depend on the TypeScript
// implementation). The Rust server serves /lexicon.json from the lexicon embedded in its binary,
// so no lexicon.json is written here.
//   - spec.html          spec/spec.md through spec-md
//   - instructions.md    L0000's instructions (the published @graffiticode/l0000 spec) + L0174's
//   - language-info.json spec/language-info.json with authoring_guide from usage-guide's Overview
//   - usage-guide.md, scope.json, schema.json, template.gc, verbatim
//
//   node tools/build-static.mjs <out dir>
import { createRequire } from "module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const specMarkdown = require("spec-md");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specDir = join(root, "spec");
const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node tools/build-static.mjs <out dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, "spec.html"), await Promise.resolve(specMarkdown.html(join(specDir, "spec.md"))));

const parentInstructions = readFileSync(require.resolve("@graffiticode/l0000/spec/instructions.md"), "utf-8");
const ownInstructions = readFileSync(join(specDir, "instructions.md"), "utf-8");
writeFileSync(join(outDir, "instructions.md"), `${parentInstructions}\n\n${ownInstructions}`);

for (const f of ["usage-guide.md", "scope.json", "schema.json", "template.gc"]) {
  const src = join(specDir, f);
  if (existsSync(src)) copyFileSync(src, join(outDir, f));
}

const usageGuide = readFileSync(join(specDir, "usage-guide.md"), "utf-8");
const overview = usageGuide.match(/^##\s+Overview\s*\n([\s\S]*?)(?=^##\s)/m);
if (!overview) {
  console.error("build-static: spec/usage-guide.md is missing a '## Overview' section.");
  process.exit(1);
}
const authoringGuide = overview[1].trim();
if (authoringGuide.length < 100) {
  console.error(`build-static: extracted Overview is ${authoringGuide.length} chars (min 100).`);
  process.exit(1);
}
const envelope = JSON.parse(readFileSync(join(specDir, "language-info.json"), "utf-8"));
delete envelope.authoring_guide;
writeFileSync(join(outDir, "language-info.json"), `${JSON.stringify({ ...envelope, authoring_guide: authoringGuide }, null, 2)}\n`);
console.log(`build-static: wrote ${outDir}`);
