// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0174 is tested against, from the TypeScript L0174 in
// this directory (packages/core):
//
//   cases.json                       programs parsed with L0174's lexicon and compiled by
//                                    @graffiticode/l0174, with the AST and the result
//   ../../src/lexicon-additions.json  the words L0174 adds to the base lexicon
//
// Needs `npm ci && npm run -w packages/core build` here, and ../l0000 installed for the
// parser; `npm run rust:fixtures` does the build. `cargo test` reads the committed output.
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const load = (path) => import(pathToFileURL(join(root, "..", path)).href);

const { parser } = await load("l0174/node_modules/@graffiticode/parser/src/index.js");
const { compiler, lexicon } = await load("l0174/packages/core/dist/index.js");
const { lexicon: base } = await load("l0174/node_modules/@graffiticode/l0000/dist/index.js");

// New words, and base words this dialect redefines (`min` and `max`).
const additions = Object.fromEntries(
  Object.entries(lexicon).filter(
    ([word, entry]) => JSON.stringify(base[word]) !== JSON.stringify(entry),
  ),
);
writeFileSync(
  join(root, "crates/core/src/lexicon-additions.json"),
  JSON.stringify(additions, null, 2) + "\n",
);

const programs = [
  // field elements
  "fields [ text label 'Full name' required true {} ] {}..",
  "fields [ email label 'Email' name 'contact_email' {} ] {}..",
  "fields [ textarea label 'Message' required true minLength 20 {} ] {}..",
  "fields [ number label 'Guests' min 0 max 5 {} ] {}..",
  "fields [ select label 'Topic' options ['Sales' 'Support' 'Other'] {} ] {}..",
  "fields [ radio label 'Size' options ['S' 'M'] {} ] {}..",
  "fields [ checkbox label 'I agree' required true {} ] {}..",
  "fields [ date label 'When?' {}, tel label 'Phone' pattern '[0-9]+' {}, url label 'Site' placeholder 'https://' help 'Your home page' {} ] {}..",
  "fields [ text {} ] {}..",
  "fields [ text label '  E-mail address!  ' maxLength 80 {} ] {}..",
  "fields [ text label '___' {} ] {}..",
  "fields [ text label 42 {} ] {}..",
  "fields [ text name '' label 'Kept' {} ] {}..",
  "fields [ text label 'A' label 'B' {} ] {}..",
  'fields [ text {extra: 1 "quoted": 2} ] {}..',
  "fields [ text label 'Nested' metadata {a: {b: 1}} {} ] {}..",
  "fields [] {}..",
  "fields (text label 'Only' {}) {}..",
  // the top-level chain
  `title 'Get in touch'
   theme LIGHT
   fields [
     text  label 'Name'  required true {},
     email label 'Email' required true {}
   ]
   submit 'Send' {}..`,
  "theme DARK fields [ text label 'X' {} ] {}..",
  "title 'Only a title' {}..",
  "submit 'Go' {}..",
  "submit {label: 'Go' kind: 'primary'} {}..",
  "submit 5 {}..",
  "metadata {source: 'web' tags: ['a' 'b']} title 'T' {}..",
  "title 'Second' title 'First' {}..",
  // an element or attribute on its own is just a record
  "text label 'Alone' {}..",
  "label 'L' {}..",
  "min 1 max 9 {}..",
  "label 'L' 5..",
  // the base language still works, except the two overridden words
  "42..",
  "add 1 2..",
  "[1 2 3]..",
  "{x: 1}..",
  "tag red..",
  // validation errors
  "fields [ select label 'Topic' {} ] {}..",
  "fields [ radio name 'size' options [] {} ] {}..",
  "fields [ select {} ] {}..",
  "fields [ select label 'A' {}, radio label 'B' {} ] {}..",
  "theme 'blue' fields [ text label 'X' {} ] {}..",
  "theme 5 {}..",
  "theme tag PURPLE {}..",
  // parse errors
  "fields..",
  "text..",
  "nope 1..",
];

const inputs = [{}, { title: "edited", extra: 1 }];

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
