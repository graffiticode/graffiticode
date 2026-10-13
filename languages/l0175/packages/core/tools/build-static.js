// Emits L0175's public static assets into dist/static/. As a child of L0000, L0175 merges
// inherited content from its parent:
//   - lexicon.json: the merged lexicon (base + L0175) — already merged in src/lexicon.ts.
//     (the legacy lexicon.js request path is aliased to it by the API server.)
//   - instructions.md: parent (L0000) instructions concatenated with L0175's.
// The rest (spec.html, language-info.json, scope.json, schema.json, template.gc,
// usage-guide.md, stems.md, targets.json, examples.md) are L0175's own.
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
import { TARGETS_DATA, STANDARD_FAMILIES, TARGETS_REVISED } from "../dist/targets.js";

// The per-target task-model → item-type table, generated from targets.ts (the single source of
// truth). Spliced into the spec `.md` files so a doc can never carry a table the compiler
// contradicts (the c1-t9 "tm3 = EBSR" drift came from a hand-maintained table going stale).
function renderTaskModelTable(targets) {
  const maxTm = Math.max(...Object.values(targets).map((t) => Object.keys(t.taskModels).length));
  const cols = Array.from({ length: maxTm }, (_, i) => `tm${i + 1}`);
  const header = `| Target | ${cols.join(" | ")} |`;
  const sep = `|--------|${cols.map(() => "-----|").join("")}`;
  const rows = Object.entries(targets).map(([id, t]) => {
    const cells = cols.map((c) => t.taskModels[c] || "—");
    return `| \`${id}\` — ${t.label} | ${cells.join(" | ")} |`;
  });
  return [header, sep, ...rows].join("\n");
}

// Replace the body between a pair of `<!-- GENERATED:<name> START … -->` / `… END -->` markers.
// Throws if the markers are missing so a doc that loses its generated block fails the build loudly.
function spliceGenerated(md, name, body) {
  const re = new RegExp(
    `(<!-- GENERATED:${name} START[^>]*-->)[\\s\\S]*?(<!-- GENERATED:${name} END -->)`,
  );
  if (!re.test(md)) {
    console.error(`build-static: missing GENERATED:${name} markers in a spec .md`);
    process.exit(1);
  }
  return md.replace(re, `$1\n${body}\n$2`);
}

const require = createRequire(import.meta.url);
const specMarkdown = require("spec-md");

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");
const specDir = join(pkgDir, "spec");
const outDir = join(pkgDir, "dist", "static");

mkdirSync(outDir, { recursive: true });

// 1. lexicon — merged (base + L0175) as plain JSON in lexicon.json. No lexicon.js is written:
//    the API server aliases the legacy lexicon.js request path to this file (see app.ts).
writeFileSync(
  join(outDir, "lexicon.json"),
  `${JSON.stringify(lexicon, null, 2)}\n`,
);
// Remove any stale lexicon.js left by an earlier build — the asset is JSON-only now.
rmSync(join(outDir, "lexicon.js"), { force: true });

// 2. spec.html via spec-md.
const specHtml = await Promise.resolve(specMarkdown.html(join(specDir, "spec.md")));
writeFileSync(join(outDir, "spec.html"), specHtml);

// 3. instructions.md — parent (L0000) instructions + L0175's. Resolve the parent's
//    instructions via its published "./spec/*" export (its package.json is not exported).
const parentInstructions = readFileSync(
  require.resolve("@graffiticode/l0000/spec/instructions.md"),
  "utf-8",
);
const taskModelTable = renderTaskModelTable(TARGETS_DATA);
const ownInstructions = spliceGenerated(
  readFileSync(join(specDir, "instructions.md"), "utf-8"),
  "task-models",
  taskModelTable,
);
writeFileSync(join(outDir, "instructions.md"), `${parentInstructions}\n\n${ownInstructions}`);

// 3b. targets.json — the served, machine-readable copy of the single source of truth (for the
//     console RAG pipeline and other non-TS consumers).
writeFileSync(
  join(outDir, "targets.json"),
  `${JSON.stringify({ revised: TARGETS_REVISED, standardFamilies: STANDARD_FAMILIES, targets: TARGETS_DATA }, null, 2)}\n`,
);

// 4. Copy L0175's own verbatim spec assets (stems.md gets its generated task-model table spliced
//    in first). unparse-hints.json (optional) maps node tags to /* */ annotations the console's
//    spec generator reads; absent ⇒ plain unparse.
writeFileSync(
  join(outDir, "stems.md"),
  spliceGenerated(readFileSync(join(specDir, "stems.md"), "utf-8"), "task-models", taskModelTable),
);
// examples.md is the prompt list the console's corpus pipeline generates from
// (create-items-from-prompts / extract-prompts / run-codegen). Serving it removes their
// `../l{lang}/packages/core/spec/examples.md` filesystem read, which only ever worked from a
// checkout with sibling repos beside it — never from Cloud Run.
for (const f of ["scope.json", "schema.json", "template.gc", "unparse-hints.json", "examples.md"]) {
  const src = join(specDir, f);
  if (existsSync(src)) copyFileSync(src, join(outDir, f));
}

// 5. usage-guide.md (agent-facing) gets the same generated task-model table spliced in, then is
//    served and mined for language-info's authoring_guide. language-info.json — envelope +
//    build-injected authoring_guide from "## Overview".
const usageGuide = spliceGenerated(
  readFileSync(join(specDir, "usage-guide.md"), "utf-8"),
  "task-models",
  taskModelTable,
);
writeFileSync(join(outDir, "usage-guide.md"), usageGuide);
const overviewMatch = usageGuide.match(/^##\s+Overview\s*\n([\s\S]*?)(?=^##\s)/m);
if (!overviewMatch) {
  console.error("build-static: spec/usage-guide.md is missing a '## Overview' section.");
  process.exit(1);
}
const authoringGuide = overviewMatch[1].trim();
if (authoringGuide.length < 100) {
  console.error(
    `build-static: extracted Overview is ${authoringGuide.length} chars (min 100).`,
  );
  process.exit(1);
}
const envelope = JSON.parse(readFileSync(join(specDir, "language-info.json"), "utf-8"));
delete envelope.authoring_guide;
writeFileSync(
  join(outDir, "language-info.json"),
  JSON.stringify({ ...envelope, authoring_guide: authoringGuide }, null, 2) + "\n",
);

console.log(`build-static: wrote ${outDir}`);
