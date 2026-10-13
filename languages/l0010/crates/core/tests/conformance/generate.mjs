// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0010 is tested against, from the TypeScript L0010 in
// this directory (packages/core):
//
//   cases.json                       programs parsed with L0010's lexicon and compiled by
//                                    @graffiticode/l0010, with the AST and the result
//   ../../src/lexicon-additions.json  the words L0010 adds to the base lexicon
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
const { compiler, lexicon } = await load("l0010/packages/core/dist/index.js");
const { lexicon: base } = await load("l0010/node_modules/@graffiticode/l0000/dist/index.js");

const additions = Object.fromEntries(Object.entries(lexicon).filter(([word]) => !(word in base)));
writeFileSync(
  join(root, "crates/core/src/lexicon-additions.json"),
  JSON.stringify(additions, null, 2) + "\n",
);

const programs = [
  // plans
  'plan ["0158"]..',
  'plan ["0166"]..',
  'plan ["0158" "0166"]..',
  'plan ["0158" "0159"]..',
  'plan ["0158" "0166" "0159" "0169"]..',
  'plan ["158"]..',
  'plan ["01580"]..',
  "plan []..",
  'let p = ["0158" "0166"].. plan p..',
  'let a = "0158".. plan [a "0166"]..',
  '[plan ["0158"] plan ["0166"]]..',
  'get "langs" (plan ["0158" "0166"])..',
  'length (get "langs" (plan ["0158" "0166"]))..',
  'map (<x: plan ["0158"]>) [1 2]..',
  // the base language still works
  "42..",
  "add 1 2..",
  "[1 2 3]..",
  "{x: 1}..",
  // rejected plans
  'plan ["0158" "0158"]..',
  'plan ["0158" "0166" "0158"]..',
  'plan ["abc"]..',
  'plan ["12"]..',
  'plan ["123456"]..',
  'plan [""]..',
  "plan [158]..",
  'plan ["0158" 166]..',
  'plan ["0158" ["0166"]]..',
  'plan ["0001" "0002" "0003" "0004" "0005"]..',
  'plan ["bad" "0158" "0158" 7]..',
  'plan "0158"..',
  "plan 158..",
  'plan (["0158"])..',
  'plan concat ["0158"] ["0166"]..',
  "plan..",
  "nope 1..",
];

const inputs = [{}, { langs: ["9999"], extra: 1 }];

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
