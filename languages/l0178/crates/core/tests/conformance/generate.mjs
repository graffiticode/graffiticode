// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0178 is tested against, from the TypeScript L0178 in
// this directory (packages/core):
//
//   cases.json                        programs parsed with L0178's lexicon and compiled by
//                                     @graffiticode/l0178, with the AST and the result
//   ../../src/lexicon-additions.json  the words L0178 adds to the base lexicon
//   ../../src/vocab.json              the blocks and their fields, from packages/core/src/vocab.ts
//
// Most of the corpus is generated from the vocabulary: every field of every block, once
// with a value of its type and once with a wrong one, with and without a paging policy.
// Then the spec's programs, the TypeScript suite's, and hand-written cases.
//
// Needs `npm ci && npm run -w packages/core build` here; `npm run rust:fixtures` does the
// build. `cargo test` reads the committed output.
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const load = (path) => import(pathToFileURL(join(root, path)).href);

const { parser } = await load("node_modules/@graffiticode/parser/src/index.js");
const { compiler, lexicon } = await load("packages/core/dist/index.js");
const { BLOCKS, TOPLEVEL, PAGING_TAGS } = await load("packages/core/dist/vocab.js");
const { lexicon: base } = await load("node_modules/@graffiticode/l0000/dist/index.js");

const additions = Object.fromEntries(
  Object.entries(lexicon).filter(
    ([word, entry]) => JSON.stringify(base[word]) !== JSON.stringify(entry),
  ),
);
writeFileSync(
  join(root, "crates/core/src/lexicon-additions.json"),
  JSON.stringify(additions, null, 2) + "\n",
);
console.log(
  `redefines base words: ${
    Object.keys(additions)
      .filter((word) => word in base)
      .join(", ") || "none"
  }`,
);

// vocab.ts is the single source of truth for what each operation accepts.
writeFileSync(
  join(root, "crates/core/src/vocab.json"),
  JSON.stringify({ blocks: BLOCKS, toplevel: TOPLEVEL, pagingTags: PAGING_TAGS }, null, 2) + "\n",
);

const literal = (json) => {
  if (Array.isArray(json)) return `[${json.map(literal).join(" ")}]`;
  if (json && typeof json === "object")
    return `{${Object.entries(json)
      .map(([k, v]) => `${k}: ${literal(v)}`)
      .join(" ")}}`;
  return JSON.stringify(json);
};
// A plain value of a field's type, as JSON.
function sample([, type, c = {}], wrong) {
  switch (type) {
    case "string":
      return wrong ? (c.values ? "nope" : 5) : c.values ? c.values[0] : "s";
    case "number":
      return wrong ? "7" : c.max !== undefined ? c.max : 7;
    case "boolean":
      return wrong ? "yes" : true;
    case "strings":
      return wrong ? (c.values ? ["nope", 1] : "one") : c.values ? [c.values.at(-1)] : ["a", "b"];
    case "timestamp":
      return wrong ? [1] : "2026-01-01T00:00:00Z";
    case "tags":
      return wrong
        ? [{ name: "4" }, { type: "" }, { type: "G", name: 5 }, { type: "G", kind: "x" }, "plain"]
        : [{ type: "subject", name: "English" }, { type: "grade" }];
    case "records": {
      const entry = Object.fromEntries(
        Object.entries(c.schema).map(([k, f]) => [k, sample(f, false)]),
      );
      if (!wrong) return [entry];
      const [first] = Object.keys(c.schema);
      return [{ nope: 1, [first]: sample(c.schema[first], true) }, "x"];
    }
    case "unmodeled":
      return wrong ? 5 : { any: "content" };
    default:
      throw new Error(`no sample for ${type}`);
  }
}
const chain = (fields, wrong) =>
  Object.entries(fields)
    .map(([name, field]) => `${name} ${literal(sample(field, wrong))}`)
    .join(" ") + " {}";

const generated = [];
for (const [block, spec] of Object.entries(BLOCKS)) {
  for (const wrong of [false, true]) {
    generated.push(`data-job paging EXHAUSTIVE ${block} [ ${chain(spec.fields, wrong)} ] {}..`);
  }
  generated.push(`data-job ${block} [] {}..`);
  generated.push(`data-job paging SINGLE-PAGE ${block} [ limit 999 {} ] {}..`);
  // One field at a time, each in a job otherwise complete.
  for (const [name, field] of Object.entries(spec.fields)) {
    generated.push(
      `data-job paging EXHAUSTIVE ${block} [ ${name} ${literal(sample(field, false))} {} ] {}..`,
    );
  }
}

function blocks(path) {
  const out = [];
  let current = null;
  for (const line of readFileSync(join(root, path), "utf8").split("\n")) {
    if (line.trim().startsWith("```")) {
      if (current) {
        out.push(current.join("\n"));
        current = null;
      } else current = [];
      continue;
    }
    if (current) current.push(line);
  }
  return out;
}
const fragments = [
  "packages/core/spec/spec.md",
  "packages/core/spec/instructions.md",
  "packages/core/spec/examples.md",
]
  .flatMap(blocks)
  .map((block) => block.trim())
  .filter((src) => src.startsWith("data-job") && !src.includes("..."))
  .map((src) => (src.endsWith("..") ? src : `${src}..`));

// The string literals passed to compile(...) in the TypeScript suite, and its named programs.
function testPrograms(path) {
  const source = readFileSync(join(root, path), "utf8");
  const found = [];
  for (const match of source.matchAll(/compile\(\s*(['"`])/g)) {
    const quote = match[1];
    let at = match.index + match[0].length;
    let text = quote;
    while (at < source.length && source[at] !== quote) {
      if (source[at] === "\\") text += source[at++];
      text += source[at++];
    }
    text += quote;
    if (quote === "`" && text.includes("${")) continue;
    found.push(new Function(`return ${text}`)());
  }
  for (const match of source.matchAll(/const [A-Z_]+ = `(data-job[\s\S]*?)`;/g)) {
    if (!match[1].includes("${")) found.push(match[1]);
  }
  return found;
}

const handwritten = [
  readFileSync(join(root, "packages/core/spec/template.gc"), "utf8"),
  "data-job {}..",
  // a field given an undefined value (the Rust keeps null; see tests/conformance.rs)
  'data-job paging EXHAUSTIVE items-get [ item-pool-id get-var "nope" {} ] {}..',
  "data-job paging NOPE items-get [] {}..",
  "data-job paging EXHAUSTIVE paging NOPE items-get [] {}..",
  "data-job paging 5 items-get [] {}..",
  'data-job paging EXHAUSTIVE items-get [ advanced-tags-none [{type: "a"}] {} ] {}..',
  'data-job paging EXHAUSTIVE items-get [ authoring-workflow-states ["Approved"] {} ] {}..',
  'data-job paging EXHAUSTIVE items-get [ next "abc" {} ] {}..',
  "data-job paging EXHAUSTIVE items-get [ nope 1 {} ] {}..",
  'data-job paging EXHAUSTIVE items-get [ limit 10 {} status ["published"] {} ] {}..',
  'data-job paging EXHAUSTIVE items-get [ 5 "x" ] {}..',
  "data-job paging EXHAUSTIVE items-get {limit: 3} {}..",
  "data-job paging EXHAUSTIVE items-get [] {nope: 1}..",
  "data-job paging EXHAUSTIVE items-get [] {} jobs-get [] {}..",
  'data-job items-set [ items [{reference: "a"} {reference: "b" status: "published" new-reference: "c"}] {} ] {}..',
  "data-job items-set [ items [] {} ] {}..",
  "[data-job paging EXHAUSTIVE {} data-job items-get [ nope 1 {} ] {}]..",
  "items-get [ limit 10 {} ] {}..",
  "limit 10 {}..",
  "42..",
  "data-job..",
  "nope..",
];

const programs = [
  ...generated,
  ...fragments,
  ...testPrograms("packages/core/src/compiler.test.ts"),
  ...handwritten,
];

function run(code) {
  const compiled = new Promise((resolve) =>
    compiler.compile(code, {}, {}, (err, val) => {
      const errors = (Array.isArray(err) ? err : err ? [err] : []).filter(Boolean);
      const messages = errors.map((e) => String(e.message ?? e).split("\n")[0]);
      if (errors.length > 0) resolve({ errors: messages });
      else resolve(val === undefined ? {} : { text: JSON.stringify(val) });
    }),
  );
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
  return Promise.race([compiled, timeout]);
}

process.on("uncaughtException", () => {});

const log = console.log;
const seen = new Set();
const cases = [];
for (const src of programs) {
  if (seen.has(src)) continue;
  seen.add(src);
  console.log = () => {};
  let ast, expect;
  try {
    ast = await parser.parse(178, src, structuredClone(lexicon));
    expect = await run(ast);
  } catch {
    expect = null;
  } finally {
    console.log = log;
  }
  if (expect === null) {
    console.warn(`skipped: ${src.slice(0, 100).replace(/\s+/g, " ")}`);
    continue;
  }
  cases.push({ src, ast, expect });
}
writeFileSync(
  join(here, "cases.json"),
  "[\n" + cases.map((entry) => JSON.stringify(entry)).join(",\n") + "\n]\n",
);
console.log(
  `wrote ${cases.length} cases (${cases.filter((c) => c.expect.errors).length} with errors)`,
);
process.exit(0);
