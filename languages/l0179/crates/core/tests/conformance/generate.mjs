// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0179 is tested against, from the TypeScript L0179 in
// this directory (packages/core):
//
//   programs.json                     programs the TypeScript never answers, parsed only
//   cases.json                        programs parsed with L0179's lexicon and compiled by
//                                     @graffiticode/l0179 against an upstream `data`, with the
//                                     AST and the result
//   ../../src/lexicon-additions.json  the words L0179 adds to the base lexicon
//   ../../src/attributes.json         the attribute table and the containers' legal words, from
//                                     packages/core/src/attributes.ts
//
// Most of the corpus is generated from the attribute table: every attribute in every container
// (the ones that take it and the ones that do not), once with each kind of value its type
// accepts and once with each kind it rejects, and every program-level attribute in the `sheets`
// slot. Then the spec's programs, the TypeScript suite's, parameter expansion, validation, and
// hand-written cases. Each program is compiled against an empty upstream; a subset also against
// bare upstream data (spread over the output; `params` and `limit` read from it) and against a
// `{data, errors}` envelope (a deliberate difference; see tests/conformance.rs).
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
const { attributeFields, validAttributes, tagValue } = await load(
  "packages/core/dist/attributes.js",
);
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

// attributes.ts is the single source of truth for the vocabulary. Its coercions and validators
// are code, so each is written out by name; an unrecognized one stops the build rather than
// reaching the Rust as something it would silently treat as a pass-through.
const coercions = new Map([
  [tagValue, "tag-value"],
  ['(v) => tagValue(v) || ""', "as-tag"],
  ["(v) => tagValue(v)?.toLowerCase() || v", "lowercase"],
  ['(v) => (v ? "instant" : "check")', "feedback"],
]);
const coercion = (fn) => {
  if (!fn) return undefined;
  const name = coercions.get(fn) ?? coercions.get(String(fn));
  if (!name) throw new Error(`unknown coercion: ${String(fn)}`);
  return name;
};
const validators = { cssSize: "css-size" };
const attributes = Object.fromEntries(
  Object.entries(attributeFields).map(([name, meta]) => {
    const validate = meta.validate && validators[meta.validate.name];
    if (meta.validate && !validate) throw new Error(`unknown validator: ${meta.validate.name}`);
    return [
      name,
      {
        field: meta.field,
        shape: meta.shape,
        expects: meta.expects,
        chaining: meta.chaining || undefined,
        coerce: coercion(meta.coerce),
        validate,
      },
    ];
  }),
);
writeFileSync(
  join(root, "crates/core/src/attributes.json"),
  JSON.stringify({ attributes, containers: validAttributes }, null, 2) + "\n",
);

// ── The corpus ─────────────────────────────────────────────────────────────

const word = (name) => name.toLowerCase().replace(/_/g, "-");
const sheet = (body, tail = "") => `sheets [ sheet "s1" [ ${body} ] ] ${tail} {}..`;
const inCell = (attrs) => sheet(`cells [ cell A1 [text "x" ${attrs}] ] {}`);
const inColumn = (attrs) =>
  sheet(`columns [ column A [${attrs}] ] {} cells [ cell A1 [text "x"] ] {}`);
const inRow = (attrs) => sheet(`rows [ row "*" [${attrs}] ] {} cells [ cell A1 [text "x"] ] {}`);
const inSheet = (attrs) => sheet(`${attrs} cells [ cell A1 [text "x"] ] {}`);
const inAssess = (attrs) => inCell(`assess [${attrs}]`);

// Values of each kind, as source: what each type accepts and what it refuses.
const values = {
  string: {
    good: ['"red"', "red", '"Center"', '"  x  "'],
    bad: ["5", "true", '""', "[1 2]", "{a: 1}", "null", '[text "x"]'],
  },
  number: {
    good: ["100", "0", "2.5", "1e3"],
    bad: ['"100"', "true", "-3", "[1]", "{n: 1}", "null", "12345678901234567890123"],
  },
  boolean: { good: ["true", "false"], bad: ['"true"', "1", "0", "null", "[true]"] },
  any: { good: ['"10"', '"=A1*2"', "5", "true", "[1 2]", "{a: 1}", "A1"], bad: [] },
};
const extra = {
  FONT_SIZE: [
    '"14px"',
    '"16"',
    '"big"',
    '"LARGE"',
    '" 1.5EM "',
    '".5rem"',
    '"-1px"',
    '"1.px"',
    '"1.2.3px"',
    '"10 px"',
    '"120%"',
    "inherit",
  ],
  METHOD: ['"Value"', "FORMULA", '"ÉQUAL"'],
  ALIGN: ["center", '"right"'],
  POINTS: ["-0", "0.5", "-0.5"],
  WIDTH: ["-1"],
  INSTANT_FEEDBACK: ["true", "false"],
};

const containers = { CELL: inCell, COLUMN: inColumn, ROW: inRow, SHEET: inSheet, ASSESS: inAssess };
const generated = [];
for (const [name, meta] of Object.entries(attributeFields)) {
  const kind = values[meta.expects || "any"];
  const samples =
    meta.shape === "object"
      ? ['[method "value" expected "1" points 2]', "[]", "[points 1]", '"x"', "[5]", "{a: 1}"]
      : [...kind.good, ...kind.bad, ...(extra[name] || [])];
  if (meta.chaining) {
    // The `sheets` configuration slot, alone and chained with the others, and inside a list,
    // where an arity-2 word swallows what follows it.
    for (const v of samples) {
      generated.push(sheet(`cells [ cell A1 [text "x"] ] {}`, `${word(name)} ${v}`));
      generated.push(
        sheet(`cells [ cell A1 [text "x"] ] {}`, `title "T" ${word(name)} ${v} params {"A1": "1"}`),
      );
    }
    generated.push(inCell(`${word(name)} "x"`));
    generated.push(inSheet(`${word(name)} true`));
    continue;
  }
  for (const [container, wrap] of Object.entries(containers)) {
    const legal = (validAttributes[container] || []).includes(word(name));
    for (const v of legal || container === "CELL" ? samples : samples.slice(0, 1)) {
      generated.push(wrap(`${word(name)} ${v}`));
    }
  }
  // Last in a list, after good attributes: the Checker-vs-Transformer trap.
  generated.push(inCell(`color "red" font-weight "bold" ${word(name)} ${samples.at(-1)}`));
  // In the `sheets` slot, where only program-level words belong.
  generated.push(sheet(`cells [ cell A1 [text "x"] ] {}`, `${word(name)} ${samples[0]}`));
}
// Two misplaced words at once, and words that belong nowhere.
generated.push(inCell('method "value" points 2'));
generated.push(inColumn('text "x" name "n"'));
generated.push(inRow("width 10"));
generated.push(inAssess('text "x" color "red"'));
generated.push(inSheet('text "x"'));

// Points inheritance and validation, as the containers build them.
const grading = [
  sheet(`
    columns [ column A [assess [points 3]] column B [assess [points 0]] ] {}
    rows [ row "*" [assess [points 5]] row "2..3" [assess [points 7]] row 4 [align "left"] ] {}
    cells [
      cell A1 [text "" assess [method "value" expected "1"]]
      cell A2 [text "" assess [method "value" expected "2"]]
      cell B2 [text "" assess [method "value" expected "3" points 1]]
      cell B3 [text "" assess [method "formula" expected "=A1"]]
      cell C4 [text "" assess [method "value" expected "4"]]
      cell D9 [text "plain"]
    ] {}`),
  sheet(`
    columns [ column A [assess [points 3]] column B [assess [points 0]] ] {}
    cells [
      cell A1 [text "" assess [method "value" expected "1"]]
      cell B1 [text "" assess [method "value" expected "2"]]
      cell C1 [text "" assess [method "value"]]
      cell A3 [text "x"]
      cell A2 [text "y"]
    ] {}`),
  sheet(`
    rows [ row 2 [assess [points 2]] row "5..9" [assess [points 4]] ] {}
    cells [
      cell A1 [text "" assess [expected "1"]]
      cell A2 [text "" assess [expected "1"]]
      cell A6 [text "" assess [expected "1"]]
      cell Z9 [text "" assess [expected "1"]]
    ] {}`),
  sheet(`rows [ row 0 [align "left"] row "" [align "left"] ] {} cells [ cell A1 [text "x"] ] {}`),
  sheet(`rows [ row 1.5 [align "left"] ] {} cells [ cell A1 [text "x"] ] {}`),
  sheet(`rows [ row A1 [align "left"] ] {} cells [ cell A1 [text "x"] ] {}`),
  sheet(
    `columns [ column A1 [width 5] column "B" [width 6] column 3 [width 7] ] {} cells [ cell A1 [text "x"] ] {}`,
  ),
  sheet(`cells [ cell "A1" [text "a"] cell 5 [text "b"] cell "" [text "c"] ] {}`),
  sheet(`cells [ cell A1 [text "a"] cell A1 [text "b"] ] {}`),
  sheet(`cells [ cell A1 [text "a"] ] {} cells [ cell B1 [text "b"] ] {}`),
  sheet(`cells [ cell A1 [text "a"] ] {width: 5}`),
  sheet(`cells [ cell A1 [text "a"] ] {rows: 5}`),
  sheet(`cells [] {}`),
  sheet(``),
  sheet(`rows [ row 1 [font-weight "bold"] ] {}`),
  sheet(`cells [ cell A1 text "x" ] {}`),
  sheet(`cells [ cell A1 [5] ] {}`),
  sheet(`cells [ cell A1 [{text: "raw"}] ] {}`),
  sheet(`cells [ cell A1 [{nope: 1}] ] {}`),
  sheet(`cells [ cell A1 [[text "x"]] ] {}`),
  sheet(`cells [ cell A1 [null] ] {}`),
  sheet(`cells [ cell A1 [] ] {}`),
  sheet(`cells cell A1 [text "x"] {}`),
  sheet(`cells [ text "x" ] {}`),
  sheet(`cells [ cell A1 [text get-var "nope"] ] {}`),
  sheet(`cells [ cell A1 [name get-var "nope"] ] {}`),
  sheet(
    `cells [ cell A1 [text "x" assess [method "value" expected "1" points get-var "nope"]] ] {}`,
  ),
];

// Several sheets.
const two = (s1 = "", s2 = "", tail = "", id1 = '"s1"', id2 = '"s2"') => `sheets [
  sheet ${id1} [ ${s1} cells [ cell A1 [text "a"] ] {} ]
  sheet ${id2} [ ${s2} cells [ cell A1 [text "b"] ] {} ]
] ${tail} {}..`;
const sheets = [
  two(),
  two('name "One"', 'name "Two" hide-formulabar true'),
  two("", "", "", '""', '""'),
  two("", "", "", "A", "B"),
  two("", "", "", '"s2"', '""'),
  two("", "", "", '"dup"', '"dup"'),
  two("", "", "show-sheet-tabs false hide-sheet-menu true"),
  two("", "", "hide-sheet-menu true show-sheet-tabs false hide-headings true"),
  two("", "", 'title "T" instructions "I" instant-feedback false'),
  two("", "", 'params {"s2!A1": "7" "A1": "1..2"}'),
  two("", "", 'params {"s9!A1": "7" "s1!": "1" "s2!a1": "2" "!A1": "3" "s1!AB12": "4"}'),
  two("", "", 'params {"s2!A1!B2": "7"}'),
  two("columns [ column A [assess [points 9]] ] {}", 'rows [ row "*" [assess [points 2]] ] {}'),
  `sheets [
    sheet "s1" [ cells [ cell A1 [text "" assess [method "value" expected "1" points 6]] ] {} ]
    sheet "s2" [ cells [ cell A1 [text "" assess [method "value" expected "2" points 4]] ] {} ]
    sheet "s3" [ name "Third" cells [ cell B7 [text "" assess [expected "3"]] ] {} ]
  ] {}..`,
  'sheets [ sheet "s1" [ name "Revenue" cells [ cell A1 [text "a"] ] {} ] ] {}..',
  'sheets [ sheet "s1" [ cells [ cell A1 [text "a"] ] {} ] ] show-sheet-tabs false hide-sheet-menu true {}..',
  "sheets [] {}..",
  "sheets [null] {}..",
  'sheets [5 "x"] {}..',
  'sheets sheet "s1" [ cells [ cell A1 [text "a"] ] {} ] {}..',
  'sheets [ sheet "s1" [ cells [ cell A1 [text "a"] ] {} ] ] {nope: 1 title: "raw"}..',
  'sheets [ sheet "s1" [ cells [ cell A1 [text "a"] ] {} ] ] "ab"..',
  'sheets [ sheet "s1" [ cells [ cell A1 [text "a"] ] {} ] ] 5..',
  'sheets [ sheet "s1" [ cells [ cell A1 [text "a"] ] {} ] ] [1]..',
  'sheets [ sheet "s1" [ cells [] {} ] sheet "s1" [] ] {}..',
  'sheets [ {cells: {A1: {text: "raw"}} id: "r"} sheet "s2" [ cells [ cell A1 [text "b"] ] {} ] ] {}..',
];

// Parameter expansion: ranges, lists, characters, steps, several parameters, the array form,
// and the truncation to 249 records.
const params = [
  '{"A1": "10..50:10"}',
  '{"A1": "1..3" "B1": "x,y"}',
  '{"A1": "1..2:0.5" "B1": "a..c" "C1": "p, q ,r"}',
  '{"A1": "0.1..0.3:0.1"}',
  '{"A1": "1..10:3"}',
  '{"A1": "5..1"}',
  '{"A1": "3..3"}',
  '{"A1": "1.."}',
  '{"A1": "..5"}',
  '{"A1": "a..z:5"}',
  '{"A1": "ab..ad"}',
  '{"A1": "x..y:0.5"}',
  '{"A1": "1x..3"}',
  '{"A1": " 2 .. 4 "}',
  '{"A1": "1..3:x"}',
  '{"A1": "1..3:2:9"}',
  '{"A1": "1..4..9"}',
  '{"A1": "-2..2"}',
  '{"A1": "1e2..1e2"}',
  '{"A1": "99999999999999999999..100000000000000000001"}',
  '{"A1": "0.1..0.30000000000000004:0.1"}',
  '{"A1": "1..300"}',
  '{"A1": "1..20" "B1": "1..20"}',
  '{"A1": "1..3" "B1": "1..100" "C1": "a,b"}',
  '{"A1": "1,2,3" "B1": "1..249"}',
  '{" A1 ": "1" "2": "two" "1": "one"}',
  '{"A1": ""}',
  "{}",
  '[["A1" "B1"] ["1..2" "x"] ["3" "y,z"]]',
  '[["A1" " B1 "]]',
  '[["A1"] ["1"] ["2..3"]]',
  '[["A1" "B1"] ["1"]]',
  '"x"',
  "5",
  "true",
  "null",
  "A1",
];
const paramPrograms = params.map((p) =>
  sheet(`cells [ cell A1 [text "{{A1}}"] ] {}`, `params ${p}`),
);
paramPrograms.push(sheet(`cells [ cell A1 [text "x"] ] {}`, `params {"A1": "1"} title "after"`));
paramPrograms.push(sheet(`cells [ cell A1 [text "x"] ] {}`, `params {"A1": "1"} {v: "0.0.1"}`));
paramPrograms.push(sheet(`cells [ cell A1 [text "x"] ] {}`, `params {"A1": "1" limit: 1}`));
paramPrograms.push(sheet(`cells [ cell A1 [text "x"] ] {}`, `params {"A1": "=B1" "B1": "1,2"}`));
paramPrograms.push(sheet(`cells [ cell A1 [text "x"] ] {}`, `params {"B1": "1,2" "A1": "=B1"}`));
paramPrograms.push(sheet(`cells [ cell A1 [text "x"] ] {}`, `params {"A1": "x" "B1": "1..249"}`));

// A program whose value is a record, not a `sheets`: PROG and the validation passes read it as
// they find it.
const raw = [
  "42..",
  '"text"..',
  "[1 2]..",
  "{}..",
  "..",
  "null..",
  '{title: "T" instructions: 5 cells: {A1: {text: "x"}}}..',
  '{cells: {A1: {assess: "x"}} rows: {"1..3": {assess: {points: 2}}}}..',
  `{cells: {A1: {assess: {expected: "1"}} B2: {assess: {expected: "2"}} C3: {text: "t"} "1": {assess: {points: 4}} A0: {assess: {}} A: {assess: {points: 1}} "A1.5": {text: "f"} "A-2": {text: "n"} Ax: {text: "nan"} Ay: {text: "nan2"}}
    rows: {"*": {assess: {order: "actual" index: "A"}} "2..3": {assess: {order: "asc" points: 6}} "1": {assess: {index: "B"}}}
    columns: {C: {assess: {points: 8}}}}..`,
  '{cells: {A1: {assess: {expected: "1"}} A2: {assess: {expected: "2"}}} rows: {"*": {assess: {order: "actual"}}}}..',
  '{cells: {A3: {text: "a"} A1: {text: "b"}} rows: {"2..": {assess: {}} "..1": {}}}..',
  '{cells: {B5: {text: "x"}} rows: {"9": {assess: {}} "7..8": {}}}..',
  '{cells: "ab"}..',
  "{cells: [{assess: {}}]}..",
  "{cells: {A1: {assess: [1]}}}..",
  '{sheets: [{cells: {A1: {text: "a"}} id: "x"}] sheetIds: ["x"]}..',
  '{sheets: [{cells: {A1: {text: "a"}} id: 7} {cells: {} id: "y" hideMenu: false}] sheetIds: "xy"}..',
  '{sheets: "ab"}..',
  '{templateVariablesRecords: [{"s1!A1": "1"} null {"x!y": 2}] sheetIds: ["s1"]}..',
  '{templateVariablesRecords: [{"s1!A1": "1"}]}..',
  '{hideMenu: true showSheetTabs: false hideSheetMenu: true hideHeadings: false feedback: "instant" errors: [1]}..',
  "{feedback: null hideMenu: null}..",
];

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
]
  .flatMap(blocks)
  .map((block) => block.trim())
  .filter((src) => src.length > 0)
  .map((src) => (src.endsWith("..") ? src : `${src}..`));

// The string literals the TypeScript suite compiles, and its helpers' programs.
function testPrograms(path) {
  const source = readFileSync(join(root, path), "utf8");
  const found = [];
  for (const match of source.matchAll(/(?:compileSrc|expectError)\(\s*(['`])/g)) {
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
  return found;
}
const suite = [
  ...testPrograms("packages/core/src/attributes.test.ts"),
  ...["font-size 14", "font-family 12", 'width "wide"', "background-color 0"].map(inCell),
  ...['font-size "14px"', "width 100", 'background-color "#eee"', 'align "center"'].map(inCell),
  inCell('color "red" font-weight "bold" font-size 14'),
  ...["-1", "0"].map(
    (p) =>
      `sheets [ sheet "s" [ cells [ cell A1 [assess [method "value" expected "1" points ${p}]] ] {} ] ] {}..`,
  ),
  two("", "", 'title "T" instructions "I"'),
  two("", "", "show-sheet-tabs false hide-sheet-menu false"),
  two("", "", "hide-headings true"),
  two("", "", 'hide-headings "yes"'),
  ...["", "instant-feedback true", "instant-feedback false", 'instant-feedback "yes"'].map(
    (tail) =>
      `sheets [ sheet "s1" [ cells [ cell A1 [text "" assess [method "value" expected "4"]] ] {} ] ] ${tail} {}..`,
  ),
  ...['{ "s2!A1": "7" }', '{ "s9!A1": "7" }', '{ "s2!nope": "7" }', '{ "A1": "7" }'].map((p) =>
    two("", "", `params ${p}`),
  ),
];

const handwritten = [
  readFileSync(join(root, "packages/core/spec/template.gc"), "utf8"),
  "nope..",
  'cell A1 [text "x"]..',
  'cells [ cell A1 [text "x"] ] {}..',
  'text "x"..',
  "assess [points 2]..",
  'title "T" {}..',
  'title "T" 5..',
  'row "1..2" [align "left"]..',
  'params {"A1": "1..3"} {}..',
  "params 5 {}..",
  'sheets [ sheet "s1" [ cells [ cell A1 [text concat "a" "b"] cell B1 [text add 1 2] ] {} ] ] {}..',
  'let x = "red".. sheets [ sheet "s1" [ cells [ cell A1 [text "a" color x] ] {} ] ] {}..',
  'sheets [ sheet "s1" [ cells [ cell A1 [text "a" font-size concat "14" "px"] ] {} ] ] {}..',
  'sheets [ sheet "s1" [ cells [ cell A1 [text 12345678901234567890123] cell B1 [text 0.1] ] {} ] ] {}..',
  'sheets [ sheet "s1" [ cells [ cell A1 [text "x" assess [expected 12345678901234567890 points 1]] ] {} ] ] {}..',
  'sheets [ sheet "s1" [ rows [ row -1 [align "left"] row 1e3 [align "left"] ] {} cells [ cell A1 [text "x"] ] {} ] ] {}..',
  'sheets [ sheet "s1" [ cells [ cell A1 [text "x"] ] {1: "one" "2": "two"} ] ] {}..',
  '{cells: {A1: {text: "a"}} 1: "one" title: tag T}..',
  'sheets [ sheet "s1" [ cells [ cell A1 [text <x: x>] ] {} ] ] {}..',
];

const programs = [
  ...generated,
  ...grading,
  ...sheets,
  ...paramPrograms,
  ...raw,
  ...fragments,
  ...suite,
  ...handwritten,
];

// Upstream inputs. Every program is compiled against `{}`; these against a sample.
const upstream = [
  { a: 1, title: "from data", errors: "dropped" },
  { params: { A1: "1..3", B1: "x,y" }, limit: 4 },
  { params: [["A1"], ["1..9"]], limit: "2" },
  { params: { A1: "1..500" } },
  { limit: 3, params: { A1: "a..e" } },
  { limit: true, params: { A1: "1..5" } },
  { limit: [2], params: { A1: "1..5" } },
  { limit: { n: 1 }, params: { A1: "1..5" } },
  { templateVariablesRecords: [{ A1: "9" }], interaction: { type: "edited" }, 2: "two" },
  [1, 2],
  "ab",
  7,
  // An envelope: the TypeScript spreads it whole; the Rust reads its `data` (see conformance.rs).
  { data: { a: 1, params: { A1: "1..2" } }, errors: [] },
];
const sampled = new Set([
  ...grading.slice(0, 2),
  sheets[0],
  sheets[9],
  ...paramPrograms.slice(0, 3),
  paramPrograms.at(-6),
  raw[6],
  raw[3],
  readFileSync(join(root, "packages/core/spec/template.gc"), "utf8"),
]);

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
for (const src of programs) {
  if (seen.has(src)) continue;
  seen.add(src);
  let ast;
  // The parser logs its syntax errors as it recovers from them.
  console.log = () => {};
  try {
    ast = await parser.parse(179, src, structuredClone(lexicon));
  } catch {
    console.warn(`skipped (no parse): ${src.slice(0, 100).replace(/\s+/g, " ")}`);
    continue;
  } finally {
    console.log = log;
  }
  for (const data of sampled.has(src) ? [{}, ...upstream] : [{}]) {
    let expect;
    console.log = () => {};
    try {
      expect = await run(structuredClone(ast), structuredClone(data));
    } catch {
      expect = null;
    } finally {
      console.log = log;
    }
    if (expect === null) {
      console.warn(`skipped: ${src.slice(0, 100).replace(/\s+/g, " ")} ${JSON.stringify(data)}`);
      continue;
    }
    cases.push({ src, data, ast, expect });
  }
}
writeFileSync(
  join(here, "cases.json"),
  "[\n" + cases.map((entry) => JSON.stringify(entry)).join(",\n") + "\n]\n",
);
console.log(
  `wrote ${cases.length} cases (${cases.filter((c) => c.expect.errors).length} with errors)`,
);

// Programs the TypeScript compiler never answers — an exception thrown out of its callbacks, or
// a range that never ends — parsed but not compiled (the last would never return). The Rust
// reports each as a compile error; tests/dialect.rs pins that.
const unanswered = [
  sheet(`cells [ cell A1 [text "x"] ] {}`, `params {"A1": 1}`),
  sheet(`cells [ cell A1 [text "x"] ] {}`, `params {"A1": "1..2:0"}`),
  sheet(`cells [ cell A1 [text "x"] ] {}`, `params {"A1": "1..Infinity"}`),
  sheet(`cells [ cell A1 [text "x"] ] {}`, `params {"B1": "1,2" "A1": "=B1"}`),
  sheet(`cells [ cell A1 [text "x"] ] {}`, `params [5]`),
  "{cells: null}..",
  "{rows: null cells: {A1: {assess: {}}}}..",
];
const parsed = {};
for (const src of unanswered) {
  parsed[src] = await parser.parse(179, src, structuredClone(lexicon));
}
writeFileSync(join(here, "programs.json"), JSON.stringify(parsed) + "\n");
process.exit(0);
