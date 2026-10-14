// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0181 is tested against, from the TypeScript L0181 in
// this directory (packages/core):
//
//   cases.json                        programs parsed with L0181's lexicon and compiled by
//                                     @graffiticode/l0181, with the AST, the upstream data
//                                     (when not {}) and the result
//   ../../src/lexicon-additions.json  the words L0181 adds to the base lexicon
//
// Most of the corpus is generated: every word given a value of every kind, in every position
// the chain allows (and some it does not), decks of every shape, and upstream data of every
// kind merged over a deck. Then the spec's programs, the TypeScript suite's, and hand-written
// cases.
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

// A value of every kind, as source.
const VALUES = [
  '"Spanish Vocab"',
  '""',
  '"dark"',
  '"日本語 — ünïcode ✓"',
  "3",
  "0",
  "-1.50",
  "1e21",
  "0.000001",
  "12345678901234567890",
  "true",
  "false",
  "null",
  "DARK",
  "LIGHT",
  "NOPE",
  "[]",
  '["a" "b"]',
  "{}",
  '{a: "b"}',
  'get-var "nope"',
  "<x: x>",
  "(DARK)",
  'concat ["a" "b"]',
  "add 1 2",
  'title "t" {}',
];

// Rests a word can be handed instead of a record.
const RESTS = [
  "{}",
  '{extra: "x" 2: "two" title: "old"}',
  '{theme: "old" cards: 1}',
  "[]",
  '["x" "y"]',
  '"ab"',
  '""',
  "5",
  "0",
  "true",
  "null",
  "DARK",
  'get-var "nope"',
  "<x: x>",
];

const DECKS = [
  '[["a" "b"]]',
  '[["a" "b"] ["c" "d"] ["e" "f"]]',
  '[["https://example.com/dog.png" "dog"]]',
  '[["$x^2$" "$2x$"]]',
  '[["" ""]]',
  "[]",
  '[["a"]]',
  '[["a" "b" "c"]]',
  "[[]]",
  '[["a" "b"] ["c"]]',
  '[["a" "b"] "c"]',
  '[["a" 3]]',
  '[[3 "a"]]',
  "[[3 4]]",
  '[["a" true]]',
  '[["a" null]]',
  '[["a" DARK]]',
  '[["a" {}]]',
  '[["a" ["b"]]]',
  '[["a" 12345678901234567890]]',
  '[["a" get-var "nope"]]',
  '[["a" <x: x>]]',
  '[["a" "b"] 5]',
  '[["a" "b"] null]',
  '[["a" "b"] {}]',
  '[["a" "b"] get-var "nope"]',
  '["a"]',
  '[["a" "b"] ["c" "d" "e"] [1 2]]',
  '"hola"',
  '""',
  "3",
  "true",
  "null",
  "DARK",
  "{}",
  '{0: ["a" "b"]}',
  'get-var "nope"',
  "<x: x>",
  'concat [[["a" "b"]] [["c" "d"]]]',
];

const generated = [];
const deck = '[["a" "b"]]';
for (const word of ["title", "instructions", "theme"]) {
  for (const value of VALUES) {
    generated.push(`cards ${deck} ${word} ${value} {}..`);
  }
  for (const rest of RESTS) {
    generated.push(`cards ${deck} ${word} ${word === "theme" ? "DARK" : '"x"'} ${rest}..`);
    generated.push(`${word} ${word === "theme" ? "LIGHT" : '"x"'} ${rest}..`);
  }
  // A word on its own, outside a deck.
  generated.push(`${word} ${word === "theme" ? "DARK" : '"x"'} {}..`);
  // Repeated: the inner one sets the field first, the outer one overwrites it.
  generated.push(
    `cards ${deck} ${word} ${word === "theme" ? "DARK" : '"one"'} ${word} ${word === "theme" ? "LIGHT" : '"two"'} {}..`,
  );
}
for (const value of DECKS) {
  generated.push(`cards ${value} {}..`);
  generated.push(`cards ${value} title "T" theme DARK {}..`);
}
for (const rest of RESTS) {
  generated.push(`cards ${deck} ${rest}..`);
}
// Every order of the three attributes, and error combinations along the chain.
const attrs = ['title "T"', 'instructions "I"', "theme DARK"];
for (const a of attrs) {
  for (const b of attrs) {
    for (const c of attrs) {
      if (new Set([a, b, c]).size === 3) generated.push(`cards ${deck} ${a} ${b} ${c} {}..`);
    }
  }
}
for (const bad of ["title 1", "instructions 2", "theme 3", 'theme "x"']) {
  generated.push(`cards [] ${bad} title 4 theme "y" {}..`);
  generated.push(`cards ${deck} ${bad} instructions [] theme 5 {}..`);
  generated.push(`cards ${deck} theme 6 ${bad} {}..`);
}
// Positions the Checker does not walk: inside a list after its first element, inside a
// record, as a function body, as a theme's own argument.
for (const word of ["theme 5", 'theme "x"', "theme NOPE", "title 3"]) {
  generated.push(`[1 ${word} {}]..`);
  generated.push(`[${word} {}]..`);
  generated.push(`{a: ${word} {}}..`);
  generated.push(`cards ${deck} {a: ${word} {}}..`);
  generated.push(`cards [["a" "b"] ${word} {}] {}..`);
  generated.push(`<x: ${word} x> {}..`);
  generated.push(`theme (${word} {}) {}..`);
  generated.push(`add 1 ${word} {}..`);
  generated.push(`hd [${word} {}]..`);
  generated.push(`map (<x: ${word} x>) [{}]..`);
  generated.push(`if true then ${word} {} else {}..`);
  generated.push(`let t = ${word} {}.. t..`);
  generated.push(`${word} {}..`);
  generated.push(`cards ${deck} title "T" ${word} {}..`);
}

// Upstream data merged over the compiled value.
const DATA = [
  { response: { marks: { 0: "known" }, cardId: 1, stack: "practice" } },
  { title: "from data", cards: [] },
  { 10: "ten", 2: "two", b: "bee", a: "ay" },
  { tag: "x" },
  { nested: { tag: "y" }, list: [1, null, "z", { 3: 1, c: 2 }] },
  { n: 1.5, big: 1e21, small: 1e-7, neg: -0 },
  // An upstream compile's envelope (the Rust kernel unwraps it; see tests/conformance.rs).
  { data: { response: 1 }, errors: [] },
  ["x", "y"],
  "ab",
  "",
  5,
  true,
  null,
];
const withData = [];
for (const data of DATA) {
  withData.push([`cards ${deck} title "T" {}..`, data]);
  withData.push([`cards ${deck} {}..`, data]);
  withData.push([`{a: 1 title: "x"}..`, data]);
  withData.push(["DARK..", data]);
  withData.push(['"text"..', data]);
  withData.push(["[1 2]..", data]);
  withData.push(["42..", data]);
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
  "packages/core/spec/usage-guide.md",
  "packages/core/spec/README.md",
]
  .flatMap(blocks)
  .map((block) => block.trim())
  .filter((src) => src.startsWith("cards") && !src.includes("..."))
  .map((src) => (src.endsWith("..") ? src : `${src}..`));

// The string literals passed to compile(...)/errorOf(...) in the TypeScript suite, and its
// named programs. The suite's harness appends `..` when it is missing.
function testPrograms(path) {
  const source = readFileSync(join(root, path), "utf8");
  const found = [];
  for (const match of source.matchAll(/(?:compile|errorOf)\(\s*(['"`])/g)) {
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
  for (const match of source.matchAll(/const [A-Z_]+ = `([\s\S]*?)`;/g)) {
    if (!match[1].includes("${")) found.push(match[1]);
  }
  return found
    .filter((src) => src.trim().length > 0)
    .map((src) => (src.trim().endsWith("..") ? src : `${src}..`));
}

const handwritten = [
  readFileSync(join(root, "packages/core/spec/template.gc"), "utf8"),
  "42..",
  "12345678901234567890..",
  '"just text"..',
  "{}..",
  '{b: 1 2: "x" 1: "y"}..',
  "[]..",
  "DARK..",
  "nope..",
  "cards..",
  'cards [["a" "b"]]..',
  'cards [["a" "b"]] {}',
  'cards [["a" "b"]] {}.. cards [["c" "d"]] {}..',
  'let deck = [["a" "b"] ["c" "d"]].. cards deck title "Let" {}..',
  'let t = DARK.. cards [["a" "b"]] theme t {}..',
  'cards [["a" "b"]] theme get-var "t" {}..',
  'set-var "t" DARK.. cards [["a" "b"]] theme get-var "t" {}..',
  'set-var "d" [["x" "y"]].. cards get-var "d" {}..',
  'cards [["a" "b"]] title concat ["Spanish " "Vocab"] {}..',
  'cards [["a" "b"]] title str 5 {}..',
  'cards (map (<p: [p "back"]>) ["a" "b"]) {}..',
  'cards [["a" "b"]] theme DARK theme LIGHT title "T" {}..',
  'cards [["a" "b"]] title "T" title 5 {}..',
  'cards [["a" "b"]] instructions "I" instructions null {}..',
  'cards [["a\\"q" "b\\\\c"]] title "tab\\there" {}..',
  "cards [[1 2] [3 4]] theme 5 title 6 {}..",
  'theme 5 theme 6 cards [["a" "b"]] {}..',
  'theme DARK cards [["a" "b"]] {}..',
  'title "outer" cards [["a" "b"]] title "inner" {}..',
];

const programs = [
  ...generated.map((src) => [src, {}]),
  ...withData,
  ...fragments.map((src) => [src, {}]),
  ...testPrograms("packages/core/src/compiler.test.ts").map((src) => [src, {}]),
  ...testPrograms("packages/core/src/errors.test.ts").map((src) => [src, {}]),
  ...handwritten.map((src) => [src, {}]),
];

// Tags the lexicon cannot spell: the parser only makes TAG nodes for DARK and LIGHT, so a
// wrong tag is put into the parsed tree by hand.
const retag = (from, to) => (ast) => {
  for (const node of Object.values(ast)) {
    if (node?.tag === "TAG" && node.elts[0] === from) node.elts[0] = to;
  }
  return ast;
};
const edited = [
  ['cards [["a" "b"]] theme DARK {}..', retag("DARK", "BLUE")],
  ['cards [["a" "b"]] theme DARK {}..', retag("DARK", "dark")],
  ["theme LIGHT theme DARK {}..", retag("LIGHT", "Σ")],
  ["[1 theme DARK {}]..", retag("DARK", "ΣΑΣ")],
];

function run(code, data) {
  const compiled = new Promise((resolve) =>
    compiler.compile(code, data, {}, (err, val) => {
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
const corpus = [
  ...programs.map(([src, data]) => [src, data, (ast) => ast]),
  ...edited.map(([src, edit], i) => [src, {}, edit, i]),
];
for (const [src, data, edit, variant] of corpus) {
  const key = JSON.stringify([src, data, variant]);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log = () => {};
  let ast, expect;
  try {
    ast = edit(await parser.parse(181, src, structuredClone(lexicon)));
    expect = await run(ast, structuredClone(data));
  } catch {
    expect = null;
  } finally {
    console.log = log;
  }
  if (expect === null) {
    console.warn(`skipped: ${src.slice(0, 100).replace(/\s+/g, " ")}`);
    continue;
  }
  cases.push(JSON.stringify(data) !== "{}" ? { src, data, ast, expect } : { src, ast, expect });
}
writeFileSync(
  join(here, "cases.json"),
  "[\n" + cases.map((entry) => JSON.stringify(entry)).join(",\n") + "\n]\n",
);
console.log(
  `wrote ${cases.length} cases (${cases.filter((c) => c.expect.errors).length} with errors)`,
);
process.exit(0);
