// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0177 is tested against, from the TypeScript L0177 in
// this directory (packages/core):
//
//   cases.json                        programs parsed with L0177's lexicon and compiled by
//                                     @graffiticode/l0177, with the AST and the result
//   ../../src/lexicon-additions.json  the words L0177 adds to the base lexicon
//   ../../src/vocab.json              the views, members, sections and properties, from
//                                     packages/core/src/vocab.ts
//
// Most of the corpus is generated from the vocabulary itself: every field of every member,
// view and section, written once with a value of its type and once with a value of the wrong
// type, in a complete design and in one with holes. Then the spec's programs, the TypeScript
// suite's, and hand-written cases.
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
const vocab = await load("packages/core/dist/vocab.js");
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

// vocab.ts is the single source of truth for what each context accepts.
const { VIEWS, SECTIONS, TOPLEVEL, GROUP_TAGS, WIDGET_TAGS } = vocab;
writeFileSync(
  join(root, "crates/core/src/vocab.json"),
  JSON.stringify(
    {
      views: VIEWS,
      sections: SECTIONS,
      toplevel: TOPLEVEL,
      groupTags: GROUP_TAGS,
      widgetTags: WIDGET_TAGS,
    },
    null,
    2,
  ) + "\n",
);

// A value of a field's type, and values of the wrong type.
const good = ([, type, constraint]) =>
  ({
    boolean: "true",
    number: "7",
    string: Array.isArray(constraint) ? JSON.stringify(constraint[0]) : '"s"',
    strings: Array.isArray(constraint) ? `[${JSON.stringify(constraint.at(-1))}]` : '["a" "b"]',
    tags: '[{type: "Grade", name: "4"} {type: "Subject", name: ["Math" "Art"]} {type: "Any"}]',
    records: '[{organisation_id: 1 item_bank_name: "b" item_pool_id: "p"}]',
    widgets: "[MCQ FORMULA]",
    groups: "[MCQ CLOZE]",
  })[type];
const bad = ([, type, constraint]) =>
  ({
    boolean: '"yes"',
    number: '"7"',
    string: Array.isArray(constraint) ? '"nope"' : "5",
    strings: Array.isArray(constraint) ? '["nope" 1]' : '"one"',
    tags: '[{name: "4"} {type: ""} {type: "G" name: 5} {type: "G" kind: "x"} "plain"]',
    records: '[{organisation_id: "1" filter: {} nope: 2 item_bank_name: 5} "x"]',
    widgets: "[MCQ NOPE]",
    groups: "[NOPE]",
  })[type];
const chain = (fields, value) =>
  Object.entries(fields)
    .map(([name, field]) => `${name} ${value(field)}`)
    .join(" ") + " {}";

const DESIGN =
  'domain "lms.example.edu" user-id "u1" reference "r1" organisation-id 12 question-type-groups [MCQ]';
const generated = [];
for (const [view, spec] of Object.entries(VIEWS)) {
  for (const value of [good, bad]) {
    const members = Object.entries(spec.members).map(
      ([member, m]) => `${member} ${chain(m.fields, value)}`,
    );
    const viewLevel = Object.keys(spec.view).length ? [chain(spec.view, value)] : [];
    const body = [...viewLevel, ...members].join("\n  ");
    generated.push(`author-embed ${DESIGN}\n${view} [\n  ${body}\n] {}..`);
    generated.push(`author-embed ${view} [\n  ${body}\n] {}..`);
  }
  // Every member of every other view, which this one drops.
  const strangers = Object.entries(VIEWS)
    .filter(([other]) => other !== view)
    .flatMap(([, other]) => Object.keys(other.members))
    .filter((member) => !(member in spec.members));
  const unique = [...new Set(strangers)];
  generated.push(
    `author-embed ${DESIGN} ${view} [ ${unique.map((member) => `${member} {}`).join(" ")} ] {}..`,
  );
}
for (const [section, spec] of Object.entries(SECTIONS)) {
  generated.push(
    `author-embed ${DESIGN} item-edit [] {} ${section} ${chain(spec.fields, good)} {}..`,
  );
  generated.push(
    `author-embed ${DESIGN} activity-list [] {} ${section} ${chain(spec.fields, bad)} {}..`,
  );
}
const top = Object.fromEntries(
  Object.entries(TOPLEVEL).map(([name, [path, type]]) => [name, [path, type]]),
);
generated.push(`author-embed ${chain(top, good).replace(/ \{\}$/, "")} item-edit [] {}..`);
generated.push(`author-embed ${chain(top, bad).replace(/ \{\}$/, "")} activity-edit [] {}..`);

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
const fragments = ["packages/core/spec/spec.md", "packages/core/spec/instructions.md"]
  .flatMap(blocks)
  .map((block) => block.trim())
  .filter((src) => src.startsWith("author-embed") && !src.includes("..."))
  .map((src) => (src.endsWith("..") ? src : `${src}..`));

// The string literals passed to compile(...) in the TypeScript suite.
function testPrograms(path) {
  const source = readFileSync(join(root, path), "utf8");
  const found = [];
  for (const match of source.matchAll(/compile\(\s*(['"`])/g)) {
    const quote = match[1];
    let at = match.index + match[0].length;
    let literal = quote;
    while (at < source.length && source[at] !== quote) {
      if (source[at] === "\\") literal += source[at++];
      literal += source[at++];
    }
    literal += quote;
    if (quote === "`" && literal.includes("${")) continue;
    found.push(new Function(`return ${literal}`)());
  }
  return found;
}
const COMPLETE = readFileSync(join(root, "packages/core/src/compiler.test.ts"), "utf8").match(
  /const COMPLETE = `([\s\S]*?)`;/,
)[1];

const handwritten = [
  COMPLETE,
  readFileSync(join(root, "packages/core/spec/template.gc"), "utf8"),
  "author-embed {}..",
  // a property given an undefined value (the Rust emits null; see tests/conformance.rs)
  'author-embed domain get-var "nope" user-id "u" item-list [] {}..',
  'author-embed domain "  " user-id "" item-edit [] {}..',
  'author-embed domain "d" user-id "u" reference "r" item-edit [ item {} ] {}..',
  'author-embed domain "d" user-id "u" reference "r" allow-widgets [MCQ] item-edit [] {}..',
  'author-embed domain "d" user-id "u" activity-edit [] {}..',
  'author-embed domain "d" user-id "u" item-list [ limit 20 item status true {} ] {}..',
  'author-embed domain "d" user-id "u" item-list [ limit 20 {} item status true {} ] {}..',
  'author-embed domain "d" user-id "u" item-list [ item status true {} toolbar search-controls ["title" "x"] {} ] {}..',
  'author-embed domain "d" user-id "u" item-list [ 5 "x" [1 2] {} ] {}..',
  'author-embed domain "d" user-id "u" item-list {limit: 3} {}..',
  'author-embed domain "d" user-id "u" item-list [] {nope: 1}..',
  'author-embed domain "d" user-id "u" question-type-groups [] item-edit [] {}..',
  'author-embed domain "d" user-id "u" question-type-groups MCQ item-edit [] {}..',
  'author-embed domain "d" user-id "u" question-type-groups [MCQ MCQ OTHER 5] item-edit [] {}..',
  'author-embed domain "d" user-id "u" allow-widgets FORMULA item-list [] {}..',
  'author-embed domain "d" user-id "u" organisation-id "12" item-list [] {}..',
  'author-embed domain 5 user-id ["u"] reference true item-edit [] {}..',
  'author-embed domain "d" user-id "u" user-email "e" user-firstname "f" user-lastname "l" item-list [] {}..',
  'author-embed domain "d" user-id "u" item-list [] {} item-edit [] {}..',
  'author-embed domain "d" user-id "u" container height 600 {} container height 700 {} item-list [] {}..',
  'author-embed domain "d" user-id "u" item-edit [ item tags-show true tags-show false {} ] {}..',
  'author-embed domain "d" user-id "u" item-edit [ item save-restricted-tags-all {type: "Grade"} {} ] {}..',
  'author-embed domain "d" user-id "u" item-edit [ item save-restricted-tags-all "Grade" {} ] {}..',
  'author-embed domain "d" user-id "u" activity-edit [ item-search item-banks {organisation_id: 1} {} ] {}..',
  'author-embed domain "d" user-id "u" activity-edit [ item-search item-banks [] {} ] {}..',
  'author-embed domain "d" user-id "u" activity-list [ filter-restricted status ["published" "draft"] {} ] {}..',
  'author-embed domain "d" user-id "u" activity-list [ filter-restricted status "published" {} ] {}..',
  'author-embed domain "d" user-id "u" item-edit [ item mode-default "both" {} ] {}..',
  '[author-embed domain "d" {} author-embed user-id "u" item-list [ widget {} ] {}]..',
  "item-edit [ item back true {} ] {}..",
  "item back true {}..",
  "back true {}..",
  "42..",
  "author-embed..",
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
    ast = await parser.parse(177, src, structuredClone(lexicon));
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
