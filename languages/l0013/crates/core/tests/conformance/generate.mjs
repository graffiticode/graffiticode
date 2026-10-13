// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0013 is tested against, from the TypeScript L0013 in
// this directory (packages/core):
//
//   cases.json                       programs parsed with L0013's lexicon and compiled by
//                                    @graffiticode/l0013, with the AST and the result
//   ../../src/lexicon-additions.json  the words L0013 adds to the base lexicon
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
const { compiler, lexicon } = await load("l0013/packages/core/dist/index.js");
const { lexicon: base } = await load("l0013/node_modules/@graffiticode/l0000/dist/index.js");

const additions = Object.fromEntries(Object.entries(lexicon).filter(([word]) => !(word in base)));
writeFileSync(
  join(root, "crates/core/src/lexicon-additions.json"),
  JSON.stringify(additions, null, 2) + "\n",
);

// Only programs that never reach a successful `snap`: that would launch a browser and upload
// to production storage. The modifiers are observable on their own, as are snap's refusals.
const programs = [
  // modifiers build the options record
  'item "abc123" {}..',
  'width 240 item "abc123" {}..',
  'height 100 width 240 item "abc123" {}..',
  'slice "4:1" item "abc123" {}..',
  'zoom 0.5 slice "4:1" item "abc123" {}..',
  'crop {x: 0 y: 0 width: 800 height: 600} item "abc123" {}..',
  'viewport {width: 800 height: 600} item "abc123" {}..',
  'item "second" item "first" {}..',
  "width 100 width 240 {}..",
  'item "abc123" {other: 1 "quoted": 2}..',
  "width 240 {}..",
  'let opts = item "abc123" {}.. width 240 opts..',
  'get "item" (width 240 item "abc123" {})..',
  "crop {x: 1} crop {y: 2} {}..",
  "item 42 {}..",
  // a modifier laid over something that is not a record starts from nothing
  'item "abc123" 5..',
  'item "abc123" null..',
  // snap refuses options with no item, before any browser is involved
  "snap {}..",
  "snap width 240 {}..",
  'snap item "" {}..',
  "snap 5..",
  'snap slice "4:1" {}..',
  // the base language still works
  "42..",
  "add 1 2..",
  "{x: 1}..",
  // parse errors
  "snap..",
  'item "abc123"..',
  "nope 1..",
];

const inputs = [{}, { item: "upstream", extra: 1 }];

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
