// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0003 is tested against, from the TypeScript L0003 in
// this directory (packages/core):
//
//   cases.json                       programs parsed with L0003's lexicon and compiled by
//                                    @graffiticode/l0003, with the AST and the result
//   ../../src/lexicon-additions.json  the words L0003 adds to the base lexicon
//
// Needs `npm ci && npm run -w packages/core build` here, and ../l0000 installed for the
// parser; `npm run rust:fixtures` does the build. `cargo test` reads the committed output.
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const load = (path) => import(pathToFileURL(join(root, "..", path)).href);

const { parser } = await load("l0000/node_modules/@graffiticode/parser/src/index.js");
const { compiler, lexicon } = await load("l0003/packages/core/dist/index.js");
const { lexicon: base } = await load("l0003/node_modules/@graffiticode/l0000/dist/index.js");

const additions = Object.fromEntries(Object.entries(lexicon).filter(([word]) => !(word in base)));
writeFileSync(
  join(root, "crates/core/src/lexicon-additions.json"),
  JSON.stringify(additions, null, 2) + "\n",
);

const programs = [
  // the dialect's own words
  'hello "world"..',
  "hello 42..",
  'hello concat "wor" "ld"..',
  'image "https://example.test/cat.png"..',
  'theme DARK hello "world"..',
  'theme LIGHT hello "world"..',
  'theme DARK image "https://example.test/cat.png"..',
  "theme DARK 42..",
  "theme LIGHT [1 2 3]..",
  'theme DARK "plain"..',
  'id "greeting" hello "world"..',
  'id "answer" 42..',
  'id "list" [1 2]..',
  'id "g" theme DARK hello "world"..',
  'theme DARK id "g" hello "world"..',
  'print hello "world"..',
  'let name = "Ada".. hello name..',
  'map (<x: hello x>) ["a" "b"]..',
  '[hello "a" image "b"]..',
  'if true then hello "yes" else hello "no"..',
  // records and tags as bodies and results
  "{x: 1}..",
  "theme DARK {x: 1}..",
  'id "r" {x: 1 y: [2]}..',
  "tag red..",
  "theme DARK tag red..",
  "theme DARK null..",
  // the base language still works
  "42..",
  "add 1 2..",
  '"text"..',
  "[1 2 3]..",
  "true..",
  "null..",
  "map (<x: add x 1>) [1 2 3]..",
  'concat "a" "b"..',
  'case 2 of 1: "one" 2: "two" end..',
  // errors
  'theme BLUE hello "world"..',
  'theme "dark" hello "world"..',
  'id 5 hello "world"..',
  "hello..",
  "nope 1..",
];

const inputs = [{}, { hello: "edited" }, { extra: 1, theme: "light" }];

function run(code, data) {
  const compiled = new Promise((resolve) =>
    compiler.compile(code, data, {}, (err, val) => {
      const errors = (Array.isArray(err) ? err : []).filter(Boolean);
      // A thrown error arrives as its stack trace; the first line is the message.
      const messages = errors.map((e) => String(e.message ?? e).split("\n")[0]);
      resolve(errors.length > 0 ? { errors: messages } : { data: val });
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
