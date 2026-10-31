// SPDX-License-Identifier: MIT
//
// Assembles ./static, the directory the Rust language server serves. Node-only: it never runs
// cargo. Its inputs:
//
//   generated/        lexicon.json and schema.json, committed, written by `npm run emit` from
//                     crates/core/src/vocab.rs (the image build checks they are current, with
//                     `emit --check`, in its Rust stage)
//   spec/             the canonical, hand-written docs
//   packages/view     the /form bundle (dist-embed: index.html and assets)
//
// It writes: lexicon.json, schema.json (copied); spec.html (spec-md); instructions.md (L0000's,
// then L0187's); usage-guide.md, scope.json, template.gc, examples.md (copied);
// language-info.json (the envelope plus an authoring_guide taken from the usage guide's
// Overview); and the /form bundle.
//
//   node tools/assemble-static.mjs [--skip-install] [--skip-view-build]
import { execFileSync } from "child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "static");
const spec = join(root, "spec");
const npm = (...args) => execFileSync("npm", args, { cwd: root, stdio: "inherit" });

if (!process.argv.includes("--skip-install") && !existsSync(join(root, "node_modules"))) {
  npm("ci");
}
if (!process.argv.includes("--skip-view-build")) {
  npm("run", "-w", "packages/view", "build:embed");
}

// Wipe and repopulate: a file that stops being emitted cannot linger.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of ["lexicon.json", "schema.json"]) {
  const src = join(root, "generated", f);
  if (!existsSync(src)) {
    console.error(`assemble-static: generated/${f} is missing; run \`npm run emit\`.`);
    process.exit(1);
  }
  copyFileSync(src, join(out, f));
}

const specMarkdown = require("spec-md");
writeFileSync(join(out, "spec.html"), await Promise.resolve(specMarkdown.html(join(spec, "spec.md"))));

const parent = readFileSync(require.resolve("@graffiticode/l0000/spec/instructions.md"), "utf-8");
const own = readFileSync(join(spec, "instructions.md"), "utf-8");
writeFileSync(join(out, "instructions.md"), `${parent}\n\n${own}`);

for (const f of ["usage-guide.md", "scope.json", "template.gc", "examples.md"]) {
  copyFileSync(join(spec, f), join(out, f));
}

const guide = readFileSync(join(spec, "usage-guide.md"), "utf-8");
const overview = guide.match(/^##\s+Overview\s*\n([\s\S]*?)(?=^##\s)/m);
if (!overview || overview[1].trim().length < 100) {
  console.error("assemble-static: spec/usage-guide.md needs a '## Overview' of at least 100 characters.");
  process.exit(1);
}
const envelope = JSON.parse(readFileSync(join(spec, "language-info.json"), "utf-8"));
delete envelope.authoring_guide;
writeFileSync(
  join(out, "language-info.json"),
  JSON.stringify({ ...envelope, authoring_guide: overview[1].trim() }, null, 2) + "\n",
);

const embed = join(root, "packages/view/dist-embed");
if (!existsSync(join(embed, "index.html"))) {
  console.error("assemble-static: packages/view/dist-embed is missing; run `npm run -w packages/view build:embed`.");
  process.exit(1);
}
cpSync(embed, out, { recursive: true });
console.log(`assemble-static: wrote ${out}`);
