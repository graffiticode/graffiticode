// Emits L0000's public static assets into dist/static/ — the artifacts the language
// server exposes without auth: lexicon.json (the legacy lexicon.js request path is aliased to
// it by the API server), spec.html, instructions.md, usage-guide.md, language-info.json,
// scope.json, schema.json, template.gc.
//
// L0000 is the root language (no parent), so its lexicon/instructions are emitted as-is.
// Child languages will merge their parent's lexicon/instructions here (see Phase B).
import { createRequire } from "module";
import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { lexicon } from "../dist/lexicon.js";

const require = createRequire(import.meta.url);
const specMarkdown = require("spec-md");

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");
const specDir = join(pkgDir, "spec");
const outDir = join(pkgDir, "dist", "static");

mkdirSync(outDir, { recursive: true });

// 1. lexicon — emitted as plain JSON in lexicon.json. No lexicon.js is written: the
//    still-deployed console still requests lexicon.js, so the API server aliases that path to
//    this file (see app.ts). Drop the alias route once the console migrates (Stage 3).
writeFileSync(
  join(outDir, "lexicon.json"),
  `${JSON.stringify(lexicon, null, 2)}\n`,
);
// Remove any stale lexicon.js left by an earlier build — the asset is JSON-only now.
rmSync(join(outDir, "lexicon.js"), { force: true });

// 2. spec.html — rendered from spec.md via spec-md (html() may return a Promise).
const specHtml = await Promise.resolve(specMarkdown.html(join(specDir, "spec.md")));
writeFileSync(join(outDir, "spec.html"), specHtml);

// 3. Copy the verbatim spec assets.
for (const f of [
  "instructions.md",
  "usage-guide.md",
  "scope.json",
  "schema.json",
  "template.gc",
]) {
  const src = join(specDir, f);
  if (existsSync(src)) copyFileSync(src, join(outDir, f));
}

// 4. language-info.json — envelope enriched with the build-injected authoring_guide,
//    extracted from the usage guide's "## Overview" section (>= 100 chars, required).
const usageGuide = readFileSync(join(specDir, "usage-guide.md"), "utf-8");
const overviewMatch = usageGuide.match(/^##\s+Overview\s*\n([\s\S]*?)(?=^##\s)/m);
if (!overviewMatch) {
  console.error("build-static: spec/usage-guide.md is missing a '## Overview' section.");
  process.exit(1);
}
const authoringGuide = overviewMatch[1].trim();
if (authoringGuide.length < 100) {
  console.error(
    `build-static: extracted Overview is ${authoringGuide.length} chars (min 100). ` +
      "Expand the '## Overview' section of spec/usage-guide.md.",
  );
  process.exit(1);
}
const envelope = JSON.parse(readFileSync(join(specDir, "language-info.json"), "utf-8"));
if ("authoring_guide" in envelope) {
  console.error(
    "build-static: spec/language-info.json must not contain 'authoring_guide'; " +
      "it is build-injected from the usage guide's Overview.",
  );
  process.exit(1);
}
writeFileSync(
  join(outDir, "language-info.json"),
  JSON.stringify({ ...envelope, authoring_guide: authoringGuide }, null, 2) + "\n",
);

console.log(`build-static: wrote ${outDir}`);
