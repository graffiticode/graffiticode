// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0176 is tested against, from the TypeScript L0176 in
// this directory (packages/core):
//
//   cases.json                        programs parsed with L0176's lexicon and compiled by
//                                     @graffiticode/l0176, with the AST and the result
//   ../../src/lexicon-additions.json  the words L0176 adds to the base lexicon
//
// The corpus is every program fragment in spec/spec.md and spec/instructions.md (the
// generator writes L0176 from those), each again with an id set, the programs in
// src/compiler.test.ts, and hand-written cases. Compiled with no policy client, as the
// TypeScript tests are: a preview comes back unsigned, `not-configured`, and a save is
// skipped. Ids and timestamps that differ on every compile are masked (see `mask`).
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

// New words, deprecated spellings, and any base word this dialect redefines.
const additions = Object.fromEntries(
  Object.entries(lexicon).filter(
    ([word, entry]) => JSON.stringify(base[word]) !== JSON.stringify(entry),
  ),
);
writeFileSync(
  join(root, "crates/core/src/lexicon-additions.json"),
  JSON.stringify(additions, null, 2) + "\n",
);
const redefined = Object.keys(additions).filter((word) => word in base);
console.log(`redefines base words: ${redefined.join(", ") || "none"}`);

// What changes on every compile: session and activity ids, and a dynamic-content table's
// timestamped references. The Rust test masks its output the same way.
export const mask = (text) =>
  text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/graffiticode-\d{4}-\d{2}-\d{2}T\d{9}Z/g, "graffiticode-<time>");

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
  .filter((src) => src && !src.includes("...") && !src.startsWith("{") && !src.startsWith("|"))
  .map((src) => (src.endsWith("..") ? src : `${src}..`));
const withId = (src) => (src.includes('"lrn-id"') ? src : `set-var "lrn-id" "t"\n${src}`);

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

const ITEM = "item [questions [mcq []] {}]";
const handwritten = [
  // an attribute given an undefined value (the Rust emits null; see tests/conformance.rs)
  'set-var "lrn-id" "t" questions [mcq [stimulus get-var "nope"]] {}..',
  'set-var "lrn-id" "t" items [item [questions [mcq []] {}]] {}..',
  'set-var "lrn-id" 42 items [item [questions [shorttext [validation [valid-response [score 1 value "x"]]]] {}], item [questions [mcq [] longtext []] {}]] {}..',
  `items [${ITEM}] {}..`,
  'set-var "lrn-id" "t" items [] {}..',
  'set-var "lrn-id" "t" items [params [{a: 1 b: 2} {a: 3 b: 4}] item [questions [mcq []] {}]] {}..',
  'set-var "lrn-id" "t" items [params "rows" item [questions [mcq []] {}]] {}..',
  'set-var "lrn-id" "t" items [item [metadata [tags {Difficulty: "easy" DOK: [2 3] "2": 1 none: null} notes "n" description "d" source "s" difficulty-level 0.5 acknowledgements "a"] questions [mcq []] {}]] {title: "T" "3": 4}..',
  'set-var "lrn-id" "t" items [item [stimulus "x" questions [mcq []] {}]] {}..',
  'set-var "lrn-id" "t" items [stimulus "x", item [questions [mcq []] {}]] {}..',
  'set-var "lrn-id" "t" items [item [metadata [notes "only"]]] {}..',
  'set-var "lrn-id" "t" items [save-to-itembank true, item [questions [mcq []] {}]] {}..',
  'set-var "lrn-id" "t" items [save-to-itembank false, item [questions [mcq []] {}]] {}..',
  'set-var "lrn-id" "t" questions [save-to-itembank true, mcq []] {}..',
  'set-var "lrn-id" "t" save-to-itembank items [item [questions [mcq []] {}]] {}..',
  'set-var "lrn-id" "t" save-to-itembank {type: "questions" data: {}}..',
  'set-var "lrn-id" "t" save-to-itembank true..',
  'set-var "lrn-id" "t" let a = items [item [questions [mcq []] {}]] {}.. save-to-itembank a..',
  'set-var "lrn-id" "t" questions [mcq [] shorttext [stimulus "{{x}} and {{response}}"]] {}..',
  "questions [mcq []] {}..",
  'set-var "lrn-id" "t" questions [mcq [stimulus "a" stimulus "b"]] {}..',
  'set-var "lrn-id" "t" questions [mcq [validation [scoring-type "nope" valid-response [score 1 value ["0"]]]]] {}..',
  'set-var "lrn-id" "t" questions [mcq [validation [scoring-type 5 valid-response [score 1 value ["0"]]]]] {}..',
  'set-var "lrn-id" "t" questions [mcq [validation [scoring-type "partialMatch"]]] {}..',
  'set-var "lrn-id" "t" questions [mcq [validation 5]] {}..',
  'set-var "lrn-id" "t" questions [mcq [valid-response [score 1 value ["0"]]]] {}..',
  'set-var "lrn-id" "t" questions [mcq [template "x" columns 3]] {}..',
  'set-var "lrn-id" "t" questions [mcq [validation [valid-response [score 1 value [score 1 value "x"]]]]] {}..',
  'set-var "lrn-id" "t" questions [mcq [validation [valid-response [score 1 value ["0"]] alt-responses [[score 1 value ["1"]] [score 0.5 value [score 1]]]]]] {}..',
  'set-var "lrn-id" "t" questions [mcq [validation [valid-response [score 1 value ["0"]] alt-responses 3]]] {}..',
  'set-var "lrn-id" "t" questions [mcq [ui-style 3]] {}..',
  'set-var "lrn-id" "t" questions [mcq [stimulus "x \\u00f7 y"]] {}..',
  'set-var "lrn-id" "t" questions [mcq [stimulus "<MATH><mi>x</mi></MATH>"]] {}..',
  'set-var "lrn-id" "t" questions [mcq [stimulus "a \\times b"]] {}..',
  'set-var "lrn-id" "t" questions [shorttext [stimulus-review "\\nu"]] {}..',
  'set-var "lrn-id" "t" questions [clozetext [stimulus "Fill {{response}}"]] {}..',
  'set-var "lrn-id" "t" questions [clozetext [template "no blank"]] {}..',
  'set-var "lrn-id" "t" questions [clozetext [stimulus "Solve \\\\(x + 3 =\\\\)." template "{{response}}"]] {}..',
  'set-var "lrn-id" "t" questions [clozetext [stimulus "A very long prompt that ends with an operator in its long tail x \\\\times" template "{{response}}"]] {}..',
  'set-var "lrn-id" "t" questions [clozetext [stimulus "What is <b>x</b> ?" template "{{response}}"]] {}..',
  'set-var "lrn-id" "t" questions [clozeformula [template "{{response}}" validation [valid-response [score 1 value [[[method "equivWhatever" value "1"]]]]]]] {}..',
  'set-var "lrn-id" "t" questions [clozeformula [template "{{response}}" validation [valid-response [score 1 value [[[method "equivSyntax" options [syntax "\\\\decimal 3"]]]]]]]] {}..',
  'set-var "lrn-id" "t" questions [clozeformula [template "{{response}}" validation [valid-response [score 1 value [[[method "equivSyntax" options [syntax "\\\\money"]]]]]]]] {}..',
  'set-var "lrn-id" "t" questions [clozeformula [template "{{response}}" validation [valid-response [score 1 value [[[method "equivValue" value "7" options [decimal-places 2 ignore-text true]]]]]]]] {}..',
  'set-var "lrn-id" "t" questions [custom [lang "0179" model {a: 1} stimulus "s"]] {}..',
  'set-var "lrn-id" "t" questions [custom []] {}..',
  'set-var "lrn-id" "t" questions [longtext [] plaintext [] orderlist [] choicematrix [] classification [] bowtie [] token-highlight [] hot-text [] clozeassociation [] clozedropdown [] clozeformula []] {}..',
  'set-var "lrn-id" "t" questions [mcq [options [label "a" value "0"]]] {}..',
  'set-var "lrn-id" "t" questions [mcq [options [[label "a" value "0"] [label "b"]]]] {}..',
  'set-var "lrn-id" "t" questions [mcq [options ["a" "b"]]] {}..',
  'set-var "lrn-id" "t" questions [mcq [options [[label "a" label "b"]]]] {}..',
  'set-var "lrn-id" "t" questions [mcq [5]] {}..',
  'set-var "lrn-id" "t" questions [mcq 5] {}..',
  'set-var "lrn-id" "t" init questions [mcq []] {}..',
  'set-var "lrn-id" "t" init {type: "author"}..',
  'init {type: "other"}..',
  '{type: "author" data: {}}..',
  '{type: "questions" data: {questions: []}}..',
  '{type: "questions" request: "already"}..',
  'hello "x"..',
  "42..",
  "nope..",
];

const programs = [
  ...fragments,
  ...fragments.map(withId),
  ...testPrograms("packages/core/src/compiler.test.ts"),
  ...handwritten,
];

// Programs the brokered-path tests (tests/brokered.rs) compile against a fake policy and
// broker, which the TypeScript compiler here has none of; only their ASTs are kept.
const brokered = [
  `set-var "lrn-id" "t" items [${ITEM}] {}..`,
  'set-var "lrn-id" "t" init questions [mcq []] {}..',
  `set-var "lrn-id" "t" set-var "learnosity-key" "own-key" set-var "learnosity-secret" "own-secret-0123456789" items [${ITEM}] {}..`,
  `set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`,
  `set-var "lrn-id" "t" init save-to-itembank items [${ITEM}] {}..`,
  `set-var "lrn-id" "t" items [save-to-itembank true, ${ITEM}] {}..`,
  `set-var "lrn-id" "t" [save-to-itembank items [${ITEM}] {} save-to-itembank items [${ITEM}] {}]..`,
  "data {}..",
  "init data {}..",
  "save-to-itembank data {}..",
];
const parsed = {};
for (const src of brokered) parsed[src] = await parser.parse(176, src, structuredClone(lexicon));
writeFileSync(join(here, "programs.json"), JSON.stringify(parsed, null, 1) + "\n");

function run(code) {
  const compiled = new Promise((resolve) =>
    compiler.compile(code, {}, {}, (err, val) => {
      const errors = (Array.isArray(err) ? err : err ? [err] : []).filter(Boolean);
      const messages = errors.map((e) => String(e.message ?? e).split("\n")[0]);
      if (errors.length > 0) resolve({ errors: messages });
      else resolve(val === undefined ? {} : { text: mask(JSON.stringify(val)) });
    }),
  );
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
  return Promise.race([compiled, timeout]);
}

process.on("uncaughtException", () => {});

const log = console.log;
const seen = new Set();
const cases = [];
let unparsed = 0;
for (const src of programs) {
  // `use` fetches a schema over the network; the fixture must not depend on it.
  if (seen.has(src) || src.includes('use "')) continue;
  seen.add(src);
  let ast;
  try {
    ast = await parser.parse(176, src, structuredClone(lexicon));
  } catch {
    unparsed++;
    continue;
  }
  console.log = () => {};
  let expect;
  try {
    expect = await run(ast);
  } finally {
    console.log = log;
  }
  if (expect === null) {
    console.warn(`skipped (never resumed): ${src.slice(0, 100).replace(/\s+/g, " ")}`);
    continue;
  }
  cases.push({ src, ast, expect });
}
writeFileSync(
  join(here, "cases.json"),
  "[\n" + cases.map((entry) => JSON.stringify(entry)).join(",\n") + "\n]\n",
);
console.log(
  `wrote ${cases.length} cases (${cases.filter((c) => c.expect.errors).length} with errors; ${unparsed} did not parse)`,
);
process.exit(0);
