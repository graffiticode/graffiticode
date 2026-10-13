// SPDX-License-Identifier: MIT
//
// Regenerates the conformance fixtures the Rust kernel is tested against:
//
//   cases.json            every program below, parsed by @graffiticode/parser and compiled
//                         by the TypeScript @graffiticode/l0000, with the AST and the result
//   programs.json         parsed programs for the toy dialect in ../kernel.rs
//   ../../src/lexicon.json  the base lexicon, copied from the TypeScript source of truth
//
// The TypeScript implementation is the sibling project languages/l0000. Build it first
// (`npm ci && npm run -w packages/core build` there), or run `npm run fixtures` here, which
// does. The Rust tests read the committed output, so `cargo test` needs no Node.
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const typescript = join(root, "..", "l0000");

const load = (path) => import(pathToFileURL(join(typescript, path)).href);
const { parser } = await load("node_modules/@graffiticode/parser/src/index.js");
const { Compiler, lexicon, setSchemaFetcher, clearSchemaCache } = await load(
  "packages/core/dist/index.js",
);

const SCHEMA = {
  $id: "conformance-0166",
  title: "L0166",
  type: "object",
  properties: { x: { type: "number" } },
  required: ["x"],
};

// Every program the TypeScript suite pins: any string literal ending in `..`.
const pinned = [];
const testSource = readFileSync(
  join(typescript, "packages/core/src/compiler.test.ts"),
  "utf8",
);
for (const m of testSource.matchAll(
  /'(?:[^'\\\n]|\\.)*\.\.'|"(?:[^"\\\n]|\\.)*\.\."/g,
)) {
  const src = (0, eval)(m[0]);
  if (!/\buse\b/.test(src)) pinned.push({ src });
}

const extra = [
  // arithmetic is decimal, not binary floating point
  "add 0.1 0.2..",
  "sub 0.3 0.1..",
  "mul 1.1 1.1..",
  "div 1 3..",
  "div 1 0..",
  "div 0 0..",
  "mod 7 3..",
  "mod -7 3..",
  "mod 7.5 2..",
  "pow 2 10..",
  "pow 2 -2..",
  "pow 2 0.5..",
  "pow 10 30..",
  "min 1 2..",
  "max 1 2..",
  "add -1 2..",
  'add "1" 2..',
  'eq "1" 1..',
  "le 1 1..",
  "ge 1 2..",
  "ne 1 2..",
  "ne 1 1..",
  "lt 2 1..",
  "mul 123456789 987654321..",
  "div 2 3..",
  "add 1e21 1..",
  "mul 1e200 1e200..",
  "range 0 5 1..",
  "range 5 0 -2..",
  "range 0 1 0.25..",
  "range 0 1 0..",
  "range 0 0 1..",
  // lists
  "hd []..",
  "tl []..",
  "last [1 2]..",
  "last []..",
  "isempty []..",
  "isempty [1]..",
  "append 3 [1 2]..",
  "drop 1 [1 2 3]..",
  "take 2 [1 2 3]..",
  "take 9 [1 2 3]..",
  "drop 9 [1 2 3]..",
  "take -1 [1 2 3]..",
  "drop -1 [1 2 3]..",
  "concat [1] [2 3]..",
  "nth 1 [10 20]..",
  "nth 5 [10 20]..",
  "get 1 [10 20 30]..",
  "hd 5..",
  "tl 5..",
  "cons 1 2..",
  "length 5..",
  'length "hello"..',
  "isempty 5..",
  "[1 [2 [3 []]]]..",
  "[]..",
  // records
  "{b: 1, a: {c: [1 {d: 2}]}}..",
  'set "a" 2 {a: 1}..',
  'set (tag a) 2 {"a": 1}..',
  'length {a: 1 "a": 2}..',
  'get "missing" {a: 1}..',
  '[1 (get "missing" {a: 1}) 3]..',
  '{a: get "missing" {}}..',
  'get "x" 5..',
  'set "x" 1 5..',
  "{1.5: 2}..",
  "get 1.5 {1.5: 2}..",
  "equiv [1 2] [1 2]..",
  "equiv {a: [1]} {a: [1]}..",
  "equiv 1 1..",
  'equiv "a" "a"..',
  "equiv 1 2..",
  "equiv null null..",
  'equiv 1 "1"..',
  // truthiness
  "not 0..",
  'not ""..',
  "not []..",
  "not null..",
  "not 1..",
  "if 0 then 1 else 2..",
  'if "" then 1 else 2..',
  "if [] then 1 else 2..",
  "if {} then 1 else 2..",
  "and 1 2..",
  "or 0 0..",
  'or 0 "x"..',
  "and 0 (hd [])..",
  "or 1 (hd [])..",
  // strings, json, print
  'concat "a" "b"..',
  'json "{\\"a\\": [1, 2.5, null, true]}"..',
  'json "[1"..',
  "print {a: 1}..",
  'print "hi"..',
  "str 1e21..",
  "str 1e-7..",
  "str 0.000001..",
  "str 123456789012345680000..",
  "str -0.5..",
  "str 100..",
  'str {"a-b": 1 "1x": 2 _c: 3}..',
  "str [[] {}]..",
  'length "héllo"..',
  // variables, sequences
  'set-var "v" 3.. get-var "v"..',
  'get-var "nope"..',
  "..",
  "1.. 2.. 3..",
  // patterns
  "case 2 of 1: 1 2: 2 end..",
  "case null of null: 1 _: 0 end..",
  'case "a" of "a": 1 _: 0 end..',
  "case [1 [2 3]] of [a [b c]]: add a add b c end..",
  "case {a: {b: 5}} of {a: {b}}: b end..",
  // errors
  "add 1..",
  "foo..",
  "add true 1..",
  'add "abc" 1..',
  "add null 1..",
  "sub [] 1..",
  'lt "a" 1..',
  "hd (tl [])..",
  "map (<x: add x true>) [1 2]..",
  'concat 1 "a"..',
  "[(hd []) (hd [])]..",
  // numbers keep their decimal value
  "sub 12345678901234567891 12345678901234567890..",
  "length (range 9007199254740993 9007199254740996 1)..",
  "range 9007199254740993 9007199254740996 1..",
  "equiv 12345678901234567890 12345678901234567891..",
  "equiv {a: 12345678901234567890} {a: 12345678901234567890}..",
  'case 12345678901234567891 of 12345678901234567890: "a" _: "b" end..',
  'get 12345678901234567891 {12345678901234567891: "b" 12345678901234567890: "a"}..',
  "str 12345678901234567890..",
  "{x: 12345678901234567890}..",
  "[12345678901234567890]..",
  "add 12345678901234567890 1..",
  "str (add 12345678901234567890 1)..",
  "1.50..",
  "12345678901234567168..",
  "str 12345678901234567168..",
  "str 1.00000000000000000001..",
  "str (mul 12345678901234567890 1000000)..",
  "str (div 12345678901234567890 3)..",
  "str (pow 3 40)..",
  "str (pow 12345678901234567890 2)..",
  "str (mod 12345678901234567891 10)..",
  "max 12345678901234567890 12345678901234567891..",
  "str (max 12345678901234567890 12345678901234567891)..",
  "lt 12345678901234567890 12345678901234567891..",
  "eq 12345678901234567890 12345678901234567890..",
  "nth 12345678901234567890 [1 2]..",
  "if 12345678901234567890 then 1 else 2..",
  'format-number "0.00" (div 1 3)..',
  'format-number "0" (div 1 0)..',
  'format-number "0.00" "x"..',
  'format-number "General" 12345678901234567890..',
  'format-number "0.000E+00" 0.000123456..',
  'format-number "#,##0.0#;[#,##0.0#]" 5..',
  'map (<x: format-number "#,##0.00" x>) [1 1234.5 -2]..',
  "take 12345678901234567890 [1 2 3]..",
  // functions that return functions
  "apply (<x: <y: add x y>>) [1]..",
  "map (<x: <y: x>>) [1 2]..",
  "map (<x: [x <y: y>]>) [1]..",
  "apply (<x: map (<y: add x y>) [1 2]>) [10]..",
  "(<x: x>) (<y: y>)..",
].map((src) => ({ src }));

const withData = [
  { src: "data {x: 0}..", data: { x: 42 } },
  { src: "data {}..", data: { data: { x: 1 }, errors: [] } },
  { src: "data {}..", data: { x: 1 } },
  { src: "data {fallback: 1}..", data: {} },
  {
    src: "data {fallback: 2}..",
    data: { data: null, errors: [{ message: "boom" }] },
  },
  {
    src: 'map (<x: mul 2 x>) (get "items" (data {}))..',
    data: { items: [1, 2, 3] },
  },
  {
    src: 'get "b" (get "a" (data {}))..',
    data: { a: { b: [1, { c: null }] } },
  },
  {
    src: 'get "c" (nth 1 (get "b" (get "a" (data {}))))..',
    data: { a: { b: [1, { c: 7 }] } },
  },
  { src: "str (data {})..", data: { a: { b: [1, "s"] }, "x y": true } },
  { src: "length (data {})..", data: { a: 1, b: 2 } },
  { src: 'length (get "a" (data {}))..', data: { a: { b: 1 } } },
  { src: 'data {a: 1 "b": 2}..', data: { b: 3, c: 4 } },
  {
    src: "case (data {}) of {kind: tag circle r}: r _: 0 end..",
    data: { kind: { tag: "circle" }, r: 3 },
  },
  {
    src: 'case (get "p" (data {})) of {a b}: add a b _: 0 end..',
    data: { p: { a: 1, b: 2 } },
  },
  { src: 'set "z" 1 (get "p" (data {}))..', data: { p: { a: 1 } } },
  { src: "data {}..", data: [1, 2] },
  { src: 'data use "0166"..', data: { x: 42 }, schema: true },
  { src: 'data use "0166"..', data: { y: "wrong" }, schema: true },
  { src: 'data use "0166"..', data: {}, schema: true },
  { src: 'data use "0166"..', data: { x: 1 }, schema: false },
  { src: 'use "0166"..', data: {}, schema: true },
  { src: 'use "abc"..', data: {}, schema: true },
];

function run(code, data) {
  const compiler = new Compiler({ langID: "0000", version: "v0" });
  const compiled = new Promise((resolve) =>
    compiler.compile(code, data, {}, (err, val) => {
      const errors = (Array.isArray(err) ? err : []).filter(Boolean);
      // A thrown error arrives as its stack trace; the first line is the message.
      const messages = errors.map((e) => String(e.message).split("\n")[0]);
      resolve(errors.length > 0 ? { errors: messages } : { data: val });
    }),
  );
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve(null), 2000),
  );
  return Promise.race([compiled, timeout]);
}

// The parser adds a program's `let` names to the lexicon it is given, so the lexicon is
// written out first and every parse gets its own copy.
writeFileSync(
  join(root, "crates/core/src/lexicon.json"),
  JSON.stringify(lexicon, null, 2) + "\n",
);

// The TypeScript compiler can throw from a timer (a `json` of invalid text does), which no
// compile callback ever reports. Such a case times out and is skipped; it must not end the run.
process.on("uncaughtException", () => {});

const log = console.log;
const cases = [];
const seen = new Set();
for (const { src, data = {}, schema } of [...pinned, ...extra, ...withData]) {
  const key = JSON.stringify([src, data, schema]);
  if (seen.has(key)) continue;
  seen.add(key);
  clearSchemaCache();
  setSchemaFetcher(async () =>
    schema
      ? { ok: true, json: async () => SCHEMA }
      : { ok: false, status: 404, json: async () => null },
  );
  console.log = () => {}; // the parser and compiler narrate to stdout
  let ast, expect;
  try {
    ast = await parser.parse(0, src, structuredClone(lexicon));
    expect = await run(ast, data);
  } finally {
    console.log = log;
  }
  if (expect === null) {
    console.warn(`skipped (never resumed): ${src}`);
    continue;
  }
  const entry = { src, data, ast, expect };
  if (schema !== undefined) entry.schema = schema ? SCHEMA : null;
  cases.push(entry);
}

writeFileSync(join(here, "cases.json"), JSON.stringify(cases, null, 1) + "\n");
// A toy dialect for the kernel's own tests: programs only, since the TypeScript kernel has
// no notion of what these words mean.
const toyLexicon = {
  ...lexicon,
  hello: { tk: 1, name: "HELLO", cls: "function", length: 1, arity: 1 },
  "save-it": { tk: 1, name: "SAVE_IT", cls: "function", length: 1, arity: 1 },
  "peek-it": { tk: 1, name: "PEEK_IT", cls: "function", length: 1, arity: 1 },
  "edit-it": { tk: 1, name: "EDIT_IT", cls: "function", length: 1, arity: 1 },
};
const programs = {};
for (const src of [
  'hello "world"..',
  "hello add 1 2..",
  "map (<x: hello x>) [1 2]..",
  "add 1 2..",
  "[1 2]..",
  "save-it 1..",
  "(save-it 1)..",
  "if true then save-it 1 else 2..",
  "if false then save-it 1 else 2..",
  "map (<x: save-it x>) [1 2]..",
  "reduce (<x acc: save-it x>) 0 [1 2]..",
  "let f = save-it..f 1..",
  "[peek-it 1 save-it 2]..",
  "[1 save-it 2]..",
  "save-it add 1 2..",
  "edit-it 1..",
  "1..",
  "[edit-it 1 <x: save-it x>]..",
  "[edit-it 1 edit-it 2]..",
  "[save-it 1 save-it 2]..",
  "peek-it 1..",
  'get-var "config"..',
  'get-var "data"..',
  'get-val-public "name"..',
  "[1 (hd [])]..",
]) {
  console.log = () => {};
  try {
    programs[src] = await parser.parse(0, src, structuredClone(toyLexicon));
  } finally {
    console.log = log;
  }
}
writeFileSync(
  join(here, "programs.json"),
  JSON.stringify(programs, null, 1) + "\n",
);

// Stage manifests as the TypeScript compiler computes them: the digests a plan pins, which
// both implementations must compute byte for byte.
const REVISION = {
  revision: "l0000-r1",
  imageDigest: `sha256:${"1".repeat(64)}`,
};
const manifests = [];
for (const [src, options] of [
  ["add 1 2..", undefined],
  ["add 0.1 0.2..", { a: 1 }],
  [
    '{b: 1, a: {c: [1 {d: "é quoted"}]}}..',
    { z: [1, 2.5, null], a: { nested: true } },
  ],
  ["12345678901234567890..", {}],
  ['`total: ${format-number "#,##0.00" 1234.5}`..', { theme: "dark" }],
]) {
  console.log = () => {};
  let code, out;
  try {
    code = await parser.parse(0, src, structuredClone(lexicon));
    out = await new Compiler({
      langID: "0000",
      revisionIdentity: () => REVISION,
    }).preflight(code, {
      stage: "s0",
      options,
    });
  } finally {
    console.log = log;
  }
  manifests.push({
    src,
    code,
    options: options ?? null,
    manifest: out.manifest,
  });
}
writeFileSync(
  join(here, "manifests.json"),
  JSON.stringify(manifests, null, 1) + "\n",
);

console.log(`wrote ${cases.length} cases`);
