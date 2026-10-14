// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0014 is tested against, from the TypeScript L0014 in
// this directory (packages/core):
//
//   cases.json                       programs parsed with L0014's lexicon and compiled by
//                                    @graffiticode/l0014, with the AST and the result
//   ../../src/lexicon-additions.json  the words L0014 adds to the base lexicon
//
// Needs `npm ci && npm run -w packages/core build` here; `npm run rust:fixtures` does the
// build. The TypeScript compiler runs TransLaTeX in-process, so the recorded `tests` are real
// translations. `cargo test` reads the committed output.
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const load = (path) => import(pathToFileURL(join(root, "..", path)).href);

const { parser } = await load("l0014/node_modules/@graffiticode/parser/src/index.js");
const { compiler, lexicon } = await load("l0014/packages/core/dist/index.js");
const { lexicon: base } = await load("l0014/node_modules/@graffiticode/l0000/dist/index.js");

const additions = Object.fromEntries(Object.entries(lexicon).filter(([word]) => !(word in base)));
writeFileSync(
  join(root, "crates/core/src/lexicon-additions.json"),
  JSON.stringify(additions, null, 2) + "\n",
);

import { readFileSync } from "fs";

const programs = [
  // each statement contributes one key of the rule set
  'words {"\\\\alpha": "\\\\alpha"}..',
  'rules {"?+?": "%1 + %2"}..',
  'types {"number": ["\\\\type{number}"]}..',
  'words {"x": "X"} rules {"?+?": "%1 plus %2", "?": "%1"} types {"n": ["1"]}..',
  // a bare expansion is wrapped in a list; a list is left alone; a nested rule set passes through
  'rules {"a": "A", "b": ["B1" "B2"], "c": {"x": "X"}, "d": [{"y": {"z": "Z"}}]}..',
  // statements may come in any order, and a repeated one wins
  'rules {"?": "%1"} words {"a": "A"}..',
  'words {"a": "A"} words {"b": "B"}..',
  // parser options, in whatever order they are written
  "rhs false parsing-integral-expr false allow-interval true..",
  'allow-thousands-separator true set-decimal-separator "," set-thousands-separator "."..',
  "ignore-text true ignore-coefficient-one true no-parens true end-root false..",
  // key kinds do not survive, and a later key of the same name stands in the earlier place
  'words {a: "tag", "b": "str", 0: "num"}..',
  'rules {"a": "first", b: "x", a: "second"}..',
  // the corpus: scored against the whole rule set, wherever `tests` is written
  'rules {"?+?": "%1 plus %2", "?": "%1"} tests [["1+2" "1 plus 2"] ["1+2" "wrong"] ["1+2" ""]]..',
  'tests [["1+2" "1 plus 2"]] rules {"?+?": "%1 plus %2", "?": "%1"}..',
  // the expected text is trimmed and collapsed; the actual is not
  'rules {"?+?": "%1 plus %2", "?": "%1"} tests [["1+2" "  1   plus\n 2 "]]..',
  // cases that are not pairs are skipped; a source that does not parse scores -1
  'rules {"?": "%1"} tests [["1" "1"] "not a case" ["\\\\frac{" "x"] []]..',
  "tests []..",
  'tests "not a list"..',
  'rules {"?": "%1"} tests [[12 "12"]]..',
  // words and types in translation
  'words {"\\\\alpha": "alpha"} rules {"?+?": "%1 and %2", "?": "%1"} tests [["\\\\alpha+\\\\beta" "alpha and \\\\beta"]]..',
  // every program is a rule set, even one that says nothing about rules
  "42..",
  "add 1 2..",
  "{x: 1}..",
  // translate runs against an empty rule set
  'translate "1+2"..',
  // parse errors
  "words..",
  "nope 1..",
];

const inputs = [{}];

const identity = readFileSync(join(root, "packages/core/spec/latex-to-latex.gc"), "utf8");
programs.push(identity);

function run(code, data) {
  const compiled = new Promise((resolve) =>
    compiler.compile(code, data, {}, (err, val) => {
      const errors = (Array.isArray(err) ? err : []).filter(Boolean);
      // A thrown error arrives as its stack trace; the first line is the message.
      const messages = errors.map((e) => String(e.message ?? e).split("\n")[0]);
      // Key order is part of the contract, so the exact JSON text is kept beside the value.
      resolve(errors.length > 0 ? { errors: messages } : { data: val, text: JSON.stringify(val) });
    }),
  );
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 2000));
  return Promise.race([compiled, timeout]);
}

// The TypeScript compiler can throw from a timer; such a case times out and is skipped.
process.on("uncaughtException", () => {});

const log = console.log;
const cases = [];
for (const src of programs) {
  for (const data of inputs) {
    console.log = () => {};
    let ast, expect;
    try {
      ast = await parser.parse(0, src, structuredClone(lexicon));
      expect = await run(ast, data);
    } finally {
      console.log = log;
    }
    if (expect === null) {
      console.warn(`skipped (never resumed): ${src} ${JSON.stringify(data)}`);
      continue;
    }
    cases.push({ src, data, ast, expect });
  }
}
writeFileSync(join(here, "cases.json"), JSON.stringify(cases, null, 1) + "\n");
console.log(`wrote ${cases.length} cases`);
