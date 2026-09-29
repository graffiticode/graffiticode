// Emits L0182's public static assets into dist/static/. As a child of L0000, L0182 merges
// inherited content from its parent:
//   - lexicon.json: the merged lexicon (base + L0182) — already merged in src/lexicon.ts.
//     (the legacy lexicon.js request path is aliased to it by the API server.)
//   - instructions.md: parent (L0000) instructions concatenated with L0182's.
// The rest (spec.html, language-info.json, scope.json, schema.json, template.gc,
// usage-guide.md) are L0182's own.
import { createRequire } from "module";
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { lexicon } from "../dist/lexicon.js";

const require = createRequire(import.meta.url);
const specMarkdown = require("spec-md");

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");
const specDir = join(pkgDir, "spec");
const outDir = join(pkgDir, "dist", "static");

// Wipe and repopulate, exactly as `npm run assemble` does for packages/api/static: a stale file
// cannot survive, which is the point. Without this, an asset that stops being emitted lingers in
// dist/static and `assemble` faithfully copies it forward — which is how a sample dataset kept
// being served long after it stopped being emitted, and why the line below used to delete a
// stale `lexicon.js` by name.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. lexicon — merged (base + L0182) as plain JSON in lexicon.json. No lexicon.js is written:
//    the API server aliases the legacy lexicon.js request path to this file (see app.ts).
writeFileSync(join(outDir, "lexicon.json"), `${JSON.stringify(lexicon, null, 2)}\n`);

// 2. spec.html via spec-md.
const specHtml = await Promise.resolve(specMarkdown.html(join(specDir, "spec.md")));
writeFileSync(join(outDir, "spec.html"), specHtml);

// 3. instructions.md — parent (L0000) instructions + L0182's. Resolve the parent's
//    instructions via its published "./spec/*" export (its package.json is not exported).
const parentInstructions = readFileSync(
  require.resolve("@graffiticode/l0000/spec/instructions.md"),
  "utf-8",
);
const ownInstructions = readFileSync(join(specDir, "instructions.md"), "utf-8");
writeFileSync(join(outDir, "instructions.md"), `${parentInstructions}\n\n${ownInstructions}`);

// 4. Copy L0182's own verbatim spec assets.
//
// The surveys in `data/` are deliberately NOT among them, which is why they live beside `spec/`
// rather than inside it. They are what the compiler reads when a program names a survey, and
// serving them would let whoever takes a survey read it — or a client render it — ahead of
// taking it. `app.test.ts` asserts the 404.
for (const f of ["usage-guide.md", "scope.json", "schema.json", "template.gc"]) {
  const src = join(specDir, f);
  if (existsSync(src)) copyFileSync(src, join(outDir, f));
}

// 5. language-info.json — envelope + build-injected authoring_guide from "## Overview".
const usageGuide = readFileSync(join(specDir, "usage-guide.md"), "utf-8");
const overviewMatch = usageGuide.match(/^##\s+Overview\s*\n([\s\S]*?)(?=^##\s)/m);
if (!overviewMatch) {
  console.error("build-static: spec/usage-guide.md is missing a '## Overview' section.");
  process.exit(1);
}
const authoringGuide = overviewMatch[1].trim();
if (authoringGuide.length < 100) {
  console.error(`build-static: extracted Overview is ${authoringGuide.length} chars (min 100).`);
  process.exit(1);
}
const envelope = JSON.parse(readFileSync(join(specDir, "language-info.json"), "utf-8"));
delete envelope.authoring_guide;
writeFileSync(
  join(outDir, "language-info.json"),
  JSON.stringify({ ...envelope, authoring_guide: authoringGuide }, null, 2) + "\n",
);

console.log(`build-static: wrote ${outDir}`);
