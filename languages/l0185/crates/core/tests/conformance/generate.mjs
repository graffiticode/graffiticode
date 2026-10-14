// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0185 is tested against, from the TypeScript L0185 in
// this directory (packages/core):
//
//   cases.json                        programs parsed with L0185's lexicon and compiled by
//                                     @graffiticode/l0185, with the AST and the result
//   fetches.json                      the bodies of the test-only URLs (https://example.org/t/…)
//   ../../src/lexicon-additions.json  the words L0185 adds to the base lexicon
//   ../../src/vocab.json              the words, from packages/core/src/attributes.ts
//
// Fetching is a fixture, never the network: https://example.org/<file> and
// https://l0185.graffiticode.org/data/<file> read packages/core/data/<file> (or fixtures/),
// as the TypeScript test harness does, and https://example.org/t/<name> the bodies below.
// tests/conformance.rs installs the same fetcher.
//
// Most of the corpus is generated: every field of every sample data set through every
// operator, aggregate, sort and format; every word given a value of each kind; CSV and JSON
// bodies with the edge cases Papa Parse and JSON.parse have. Then the spec's programs, the
// TypeScript suite's, and hand-written cases.
//
// Run with TZ=UTC (the server's zone); `npm run rust:fixtures` builds packages/core first.
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

process.env.TZ = "UTC";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const load = (path) => import(pathToFileURL(join(root, path)).href);

const { parser } = await load("node_modules/@graffiticode/parser/src/index.js");
const { compiler, lexicon, setFetcher, stepFields, TAGS } = await load(
  "packages/core/dist/index.js",
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
writeFileSync(
  join(root, "crates/core/src/vocab.json"),
  JSON.stringify({ stepFields, tags: TAGS }, null, 2) + "\n",
);

/* ------------------------------------------------------------------ fetcher */

const DATA = join(root, "packages/core/data/");
const FIXTURES = join(root, "packages/core/fixtures/");

// Test-only bodies: CSV and JSON edge cases, and pages that are not data.
const csv = (text) => ({ text, contentType: "text/csv" });
const plain = (text) => ({ text, contentType: "text/plain" });
const json = (text) => ({ text, contentType: "application/json" });
const SYNTH = {
  "crlf.csv": csv("a,b\r\n1,x\r\n2,y\r\n"),
  "cr.csv": csv("a,b\r1,x\r2,y"),
  "tabs.csv": csv("a\tb\tc\n1\t2\t3\n4\t5\t6\n"),
  "semi.csv": csv("a;b\n1,5;x\n2,5;y\n"),
  "pipe.csv": csv("a|b\n1|x\n2|y\n"),
  "quoted.csv": csv(
    'name,note\n"Smith, Jo","said ""hi"""\n"multi\nline",plain\n  "  spaced  "  ,x\n',
  ),
  "quoted-crlf.csv": csv('name,note\r\n"a\r\nb",1\r\n"c",2\r\n'),
  "dupes.csv": csv("a,a,a_1,b,a\n1,2,3,4,5\n"),
  "ragged.csv": csv("a,b,c\n1,2\n1,2,3,4,5\n\n7,8,9\n"),
  "empty.csv": csv(""),
  "blank.csv": csv("\n\n  \n"),
  "header-only.csv": csv("a,b\n"),
  "one-column.csv": csv("name\nAna\nBen\n"),
  "one-column-header.csv": csv("name\n"),
  "bom.csv": csv("﻿a,b\n1,2\n"),
  "typed.csv": csv(
    "s,n,b,d\n" +
      " 12 ,1.,TRUE,2024-01-02T03:04Z\n" +
      "-0,.5,false,2024-01-02T03:04:05.678+01:00\n" +
      "1e3,9007199254740993,True,2024-13-45T10:00:00Z\n" +
      "0x10,-1.5e-3,FALSE,2024-01-02\n" +
      "+5,1.2.3,yes,2024-01-02T25:00:00Z\n" +
      ",  ,null,2024-01-02T03:04:05Z\n",
  ),
  "unterminated.csv": csv('a,b\n1,"open\n2,3\n'),
  "unterminated-header.csv": csv('"a,b\n'),
  "malformed.csv": csv('a,b\n"x"y,2\n3,4\n'),
  "numeric-headers.csv": csv("name,2021,2020,10\nA,1,2,3\n"),
  "dates.csv": csv(
    "id,when\n1,2024-11-03\n2,Nov 3 2024\n3,2024/11/03 10:15\n4,11/03/2024\n5,3 November 2024 14:30 GMT\n" +
      "6,Sun Nov 03 2024 10:00:00 GMT+0200\n7,2024-11-03T10:15:30.123456Z\n8,hello 2\n9,soon\n10,12:30\n" +
      "11,2024-11-03 10:15 pm\n12,1700000000000\n13,1700000000\n14,-1\n15,2024-02-30\n16,Tue 2024\n",
  ),
  "sniff-json.txt": plain('[{"a": 1}, {"a": 2}]'),
  "sniff-csv.txt": plain("a,b\n1,2\n"),
  "sniff-space.txt": plain('  \n {"rows": [1, 2]}'),
  "keys.json": json('[{"b": 1, "10": 2, "a": 3, "2": 4, "01": 5}, {"b": 6, "a": 7, "x": 8}]'),
  "dup-keys.json": json('[{"a": 1, "b": 2, "a": 3}]'),
  "object.json": json('{"total": 2, "items": {"first": {"v": 1}}, "list": [1, 2, 3]}'),
  "scalar.json": json("42"),
  "numbers.json": json(
    '[{"n": 1.0, "big": 12345678901234567890, "tiny": 1e-7, "neg": -0, "exp": 1.5e300, "s": "10"}, {"n": 2.5, "big": 1, "tiny": 0.1, "neg": 3, "exp": 2, "s": "9"}]',
  ),
  "mixed.json": json(
    '[{"v": 10, "t": "b"}, {"v": "9", "t": "a"}, {"v": null, "t": "B"}, {"v": "x", "t": "á"}, {"t": "A"}, {"v": "Infinity", "t": "_"}, {"v": true, "t": "10"}, {"v": [1], "t": "2"}, {"v": {"k": 1}, "t": "a b"}]',
  ),
  "tags.json": json('[{"tag": "x", "n": 1}, {"tag": "y", "n": 2}, {"kind": {"tag": "z"}, "n": 3}]'),
  "scalars.json": json('[1, "two", null, true, [3], {"a": 4}]'),
  "bad.json": json('{"a": 1,}'),
  "bad-csv-labelled-json.json": json("a,b\n1,2\n"),
  "page.html": {
    text: "<!DOCTYPE html><html><body>hi</body></html>",
    contentType: "text/html; charset=utf-8",
  },
  "doctype.txt": plain("  <!doctype html><p>hi</p>"),
  "html-tag.txt": plain("<HTML><body></body></HTML>"),
  "html-csv.html": { text: "a,b\n<p>1</p>,2\n", contentType: "text/html" },
  "bom.json": json('﻿[{"a": 1}]'),
  "unicode.json": json(
    '[{"name": "Émile", "city": "Zürich"}, {"name": "émile", "city": "Ångström"}, {"name": "Zoë", "city": "zurich"}, {"name": "ana", "city": "Oslo"}, {"name": "Ana", "city": "oslo"}]',
  ),
  "wide.json": json(
    JSON.stringify([Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`field${i}`, i]))]),
  ),
  "rows-10001.json": json(JSON.stringify(Array.from({ length: 10001 }, (_, i) => i))),
  "rows-50001.json": json(JSON.stringify(Array.from({ length: 50001 }, () => 0))),
};
const ERRORS = {
  "boom.json": 'fetch: fetching "https://example.org/t/boom.json" timed out after 10 s.',
};
const fetches = {};
setFetcher(async (url) => {
  const synth = url.match(/^https:\/\/example\.org\/t\/(.+)$/);
  if (synth) {
    if (ERRORS[synth[1]]) {
      fetches[url] = { error: ERRORS[synth[1]] };
      throw new Error(ERRORS[synth[1]]);
    }
    if (SYNTH[synth[1]]) {
      fetches[url] = SYNTH[synth[1]];
      return SYNTH[synth[1]];
    }
  }
  const m = url.match(/^https:\/\/(?:example\.org|l0185\.graffiticode\.org\/data)\/(.+)$/);
  const file = !m ? "" : existsSync(`${DATA}${m[1]}`) ? `${DATA}${m[1]}` : `${FIXTURES}${m[1]}`;
  if (!m || synth || !existsSync(file))
    throw new Error(`fetch: fetching ${JSON.stringify(url)} failed: the server answered 404.`);
  const contentType = file.endsWith(".csv")
    ? "text/csv"
    : file.endsWith(".html")
      ? "text/html"
      : "application/json";
  return { text: readFileSync(file, "utf8"), contentType };
});

/* ------------------------------------------------------------------ corpus */

const E = (file) => `fetch "https://example.org/${file}"`;
const T = (name) => `fetch "https://example.org/t/${name}"`;
const lit = (v) => {
  if (Array.isArray(v)) return `[${v.map(lit).join(" ")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .map(([k, x]) => `${JSON.stringify(k)}: ${lit(x)}`)
      .join(" ")}}`;
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
};
const safe = (v) =>
  v !== undefined &&
  (typeof v !== "string" || !/[\\\n\r"`{}$]/.test(v)) &&
  (typeof v !== "number" || (Number.isFinite(v) && Math.abs(v) < 1e15));

// The sample data sets, each a source expression and its records.
const readData = (file) => readFileSync(join(DATA, file), "utf8");
const DATASETS = [
  { src: `${E("people.json")} {}`, rows: JSON.parse(readData("people.json")) },
  { src: `${E("sales.csv")} {}`, csv: "sales.csv" },
  { src: `${E("iris.csv")} {}`, csv: "iris.csv" },
  {
    src: `${E("earthquakes.json")} at "features" {}`,
    rows: JSON.parse(readData("earthquakes.json")).features,
  },
  {
    src: `${E("products.json")} at "products" {}`,
    rows: JSON.parse(readData("products.json")).products,
  },
  {
    src: `${E("nested.json")} at "results.users" {}`,
    rows: JSON.parse(readData("nested.json")).results.users,
  },
  { src: `${E("users.json")} {}`, rows: JSON.parse(readData("users.json")) },
  { src: `${E("todos.json")} {}`, rows: JSON.parse(readData("todos.json")) },
  {
    src: `${E("stats.json")} at "top_scorers" {}`,
    rows: JSON.parse(readData("stats.json")).top_scorers,
  },
  { src: `${T("mixed.json")} {}`, rows: JSON.parse(SYNTH["mixed.json"].text) },
  { src: `${T("unicode.json")} {}`, rows: JSON.parse(SYNTH["unicode.json"].text) },
  { src: `${T("dates.csv")} {}`, csv: "dates" },
];
const csvRows = (text) => {
  const [head, ...lines] = text.trim().split("\n");
  const fields = head.split(",");
  return lines.map((l) =>
    Object.fromEntries(l.split(",").map((v, i) => [fields[i], isNaN(Number(v)) ? v : Number(v)])),
  );
};
for (const d of DATASETS) {
  if (d.csv === "dates") d.rows = csvRows(SYNTH["dates.csv"].text);
  else if (d.csv) d.rows = csvRows(readData(d.csv));
}

const paths = (row, prefix = "", depth = 2) =>
  Object.entries(row).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v) && depth > 0
      ? [p, ...paths(v, p, depth - 1)]
      : [p];
  });
const at = (row, p) => p.split(".").reduce((c, k) => (c == null ? undefined : c[k]), row);

const OPS = [
  "EQUALS",
  "NOT-EQUALS",
  "ABOVE",
  "AT-LEAST",
  "BELOW",
  "AT-MOST",
  "IN",
  "NOT-IN",
  "CONTAINS",
  "STARTS-WITH",
  "ENDS-WITH",
  "MISSING",
  "PRESENT",
];
const AGGS = ["COUNT", "SUM", "AVERAGE", "MEDIAN", "MIN", "MAX", "COUNT-DISTINCT"];

const generated = [];
for (const { src, rows } of DATASETS) {
  const fields = [...new Set(rows.slice(0, 3).flatMap((r) => paths(r)))].slice(0, 10);
  generated.push(`limit 3 ${src}`, `summarize {n: COUNT} ${src}`);
  for (const f of fields) {
    const sample = rows
      .map((r) => at(r, f))
      .find((v) => v !== undefined && v !== null && typeof v !== "object");
    const q = JSON.stringify(f);
    generated.push(`limit 5 pick [${q}] sort-by [${q}] ${src}`);
    generated.push(`limit 5 pick [${q}] sort-by [${q} DESC] ${src}`);
    generated.push(`limit 4 pick [${q}] distinct [${q}] ${src}`);
    generated.push(`limit 4 summarize {n: COUNT} group-by [${q}] ${src}`);
    generated.push(`summarize {${AGGS.map((a, i) => `a${i}: [${a} ${q}]`).join(" ")}} ${src}`);
    for (const a of ["SUM", "AVERAGE", "MEDIAN", "MIN", "MAX"])
      generated.push(`summarize {x: [${a} ${q}]} ${src}`);
    generated.push(`limit 3 pick [${q}] format {${q}: "#,##0.0"} ${src}`);
    generated.push(`limit 3 pick [${q}] format {${q}: "yyyy-mm-dd hh:mm:ss"} ${src}`);
    generated.push(`limit 3 omit [${q}] ${src}`);
    generated.push(`limit 3 rename {${q}: "renamed"} ${src}`);
    generated.push(`limit 3 fill {${q}: "filled"} ${src}`);
    generated.push(`limit 3 spread ${q} ${src}`);
    generated.push(`limit 6 unnest ${q} ${src}`);
    if (!safe(sample)) continue;
    for (const op of OPS) {
      const value =
        op === "IN" || op === "NOT-IN"
          ? `[${lit(sample)} "zzz"]`
          : op === "MISSING" || op === "PRESENT"
            ? ""
            : lit(sample);
      generated.push(`summarize {n: COUNT} where [${q} ${op} ${value}] ${src}`.replace("  ", " "));
    }
    for (const value of [5, '"m"', "true", "null"]) {
      generated.push(`summarize {n: COUNT} where [${q} ABOVE ${value}] ${src}`);
      generated.push(`summarize {n: COUNT} where [${q} EQUALS ${value}] ${src}`);
    }
  }
  generated.push(`pick ["nope"] ${src}`, `where ["Nam" EQUALS 1] ${src}`);
}

// Every word given a value of each kind, with data to its right.
const KINDS = [
  "5",
  '"text"',
  "[]",
  '["name"]',
  "[1 2]",
  "{}",
  '{name: "x"}',
  "ABOVE",
  "(<row: true>)",
  "null",
  "true",
  "-1",
  "2.5",
];
for (const [name, meta] of Object.entries(stepFields)) {
  const word = name.toLowerCase().replace(/_/g, "-");
  for (const kind of KINDS) {
    if (meta.role === "step")
      generated.push(`${word} ${kind} ${E("people.json")} {}`, `${word} ${kind} {}`);
    else if (meta.role === "option")
      generated.push(
        `${meta.of} ${meta.of === "fetch" ? '"https://example.org/people.json"' : meta.of === "rows" ? '[["a" 1]]' : "x"} ${word} ${kind} {}`,
      );
    else generated.push(`${word} ${kind} {}`, `${word} ${kind} ${E("people.json")} {}`);
  }
  generated.push(
    `${word} ${meta.role === "step" ? '["name"]' : '"x"'} 5..`,
    `${word} ${meta.role === "step" ? '["name"]' : '"x"'} {a: 1}..`,
  );
  generated.push(meta.example);
}

// Bodies: every test-only URL, as data, through a few steps, and with each parse.
for (const name of [...Object.keys(SYNTH), ...Object.keys(ERRORS)]) {
  if (name.startsWith("rows-")) continue;
  generated.push(
    `${T(name)} {}`,
    `${T(name)} parse CSV {}`,
    `${T(name)} parse JSON {}`,
    `limit 2 skip 1 ${T(name)} {}`,
  );
}

// Formats: number and date patterns on numbers and strings.
const PATTERNS = [
  "0",
  "0.00",
  "#,##0",
  "$#,##0.00",
  "0%",
  "0.0E+00",
  "#,##0;(#,##0)",
  '#,##0;-#,##0;"zero"',
  "abc",
  "General",
  "@",
  "[Red]0",
  "yyyy-mm-dd",
  "yy/m/d",
  "d mmm yyyy",
  "dddd, mmmm d",
  "ddd mmmmm",
  "hh:mm:ss",
  "h:mm AM/PM",
  "h:mm am/pm",
  "mm:ss",
  "m/d/yyyy h:mm",
  'yyyy\\y "quoted y"',
  "\\d",
  '"unclosed',
  "yyyyy mmmmmm ddddd hhh sss",
  "s",
  "[h]:mm",
];
const VALUES = [
  0,
  1234.5,
  -1234.5,
  0.5,
  1790017733,
  1790017733706,
  -86400,
  1e16,
  '"2024-11-03"',
  '"2024-03-05T14:07:00Z"',
  '"soon"',
  '""',
  "true",
  "null",
  '"12"',
];
for (const p of PATTERNS)
  for (const v of VALUES) generated.push(`format {t: ${JSON.stringify(p)}} rows [{t: ${v}}] {}`);
generated.push(
  'format {when: "yyyy-mm-dd hh:mm"} limit 20 fetch "https://example.org/t/dates.csv" {}',
);
// What V8's Date.parse reads, and what it does not.
const DATE_STRINGS = [
  "2024-11-03T10:15:30",
  "2024-11-03T24:00",
  "2024-11-03T24:00:01",
  "2024-11-03T23:59:60",
  "+002024-11-03",
  "-000001-01-01T00:00:00Z",
  "-000000-01-01",
  "20241103",
  "2024-1-3",
  "2024-11",
  "2024",
  "Mon, 03 Nov 2024 10:15:00 GMT",
  "Nov 3, 2024 10:15:30.5 AM",
  "3/4/5",
  "12/31/99",
  "1/2/50",
  "2024-11-03T10:15+0530",
  "2024-11-03T10:15:00.1234Z",
  "2024-11-03T10:15:00.1Z",
  "Jan 2024",
  "May",
  "10:15",
  "Tuesday",
  "(comment) Nov 3 2024",
  "Nov 3 2024 (Coordinated Universal Time)",
  "Nov 3 2024 GMT+0530",
  "Nov 3 2024 UTC-5",
  "Nov 3 2024 EST",
  "Nov 3 2024 12:00 PM PST",
  "Nov 3 2024 12:30 am",
  "Nov 3 2024 13:00 PM",
  "2024-11-03T10:15:30.000-07:00",
  "0",
  "1",
  "  2024-11-03  ",
  "Nov 32 2024",
  "Feb 29 2023",
  "2024-02-29",
  "2024-11-03T10:15Z junk",
  "Nov 3 2024 10:15:30 +0100",
  "11-03-2024",
  "2024.11.03",
  "3 Nov",
  "Nov-3-2024",
  "Sept 3 2024",
  "Decembre 3 2024",
  "T10:15",
  "2024-11-03 T10:15",
  "99999-01-01",
  "Nov 3 275760",
  "Sat Sep 13 275760 00:00:00 GMT+0000",
  "12:30:45.123 Nov 3 2024",
  "Nov 3 2024 1:2:3",
  "Nov 3 2024 10::",
  "Nov 3 2024 25:00",
];
for (const s of DATE_STRINGS)
  generated.push(`format {t: "yyyy-mm-dd hh:mm:ss ddd"} rows [{t: ${JSON.stringify(s)}}] {}`);
generated.push(
  `sort-by ["s"] rows [${["a-b", "ab", "a b", "a_b", "A", "á", "Z", "1", "10", "2", "!", "ä", "ae", "æ", "Œ", "oe", "ß", "ss", "a.b", "a,b", "~", "", " ", "Ab", "aB", "résumé", "resume", "Résumé", "日本", "中文", "ǅ", "Ⅸ", "ⅸ"].map((s) => `{s: ${JSON.stringify(s)}}`).join(" ")}] {}`,
);
generated.push(
  'where ["age" DESC 1] fetch "https://example.org/people.json" {}',
  'where ["age" JSON] fetch "https://example.org/people.json" {}',
);
generated.push('format {d: "yyyy"} fetch "https://example.org/t/typed.csv" {}');

const handwritten = [
  readFileSync(join(root, "packages/core/spec/template.gc"), "utf8"),
  // Program shape.
  "42..",
  "{}..",
  '"x"..',
  "rows [] {}..",
  "rows [] {} rows [] {}..",
  "[rows [] {}]..",
  "nope..",
  "add 1 2..",
  "limit 1 {}..",
  "parse CSV {}..",
  'columns ["a"] {}..',
  'group-by ["a"] rows [{a: 1}] {}..',
  'summarize {n: COUNT} group-by ["a"] group-by ["a"] rows [{a: 1}] {}..',
  'where ["a" EQUALS 1] {} rows [{a: 1}] {}..',
  "{} rows [] {}..",
  "rows [{a: 1}] {} {}..",
  "let x = rows [{a: 1}] {}.. from x {}..",
  "let x = rows [{a: 1}] {}.. x..",
  "from [1 2] {}..",
  "from 5 {}..",
  "from {a: 1} {}..",
  'from (get-var "nope") {}..',
  "from nope {}..",
  'rows [{a: 1}] (get-var "nope")..',
  // Sources and options.
  'fetch "https://example.org/people.json" parse JSON parse JSON {}..',
  'fetch "https://example.org/people.json" at "x" at "y" {}..',
  "rows [{a: 1}] parse CSV {}..",
  'from [{a: 1}] columns ["a"] {}..',
  'rows [[1 2] {a: 1}] columns ["a" "b"] {}..',
  'rows [[1 2] [3]] columns ["a" "b"] {}..',
  'rows [[1 2] 5] columns ["a" "b"] {}..',
  'rows [[1 2]] columns ["a" "a"] {}..',
  'rows [1 "two" null] {}..',
  "rows [[]] columns [] {}..",
  'fetch "https://example.org/people.json" connection-id 5 {}..',
  'fetch "https://example.org/api.json" at "data.users.0.name" {}..',
  'fetch "https://example.org/api.json" at "" {}..',
  'fetch "https://example.org/people.json" at "0" {}..',
  'fetch "https://example.org/people.json" at "length" {}..',
  'fetch "https://example.org/t/scalar.json" at "x" {}..',
  'fetch "https://example.org/t/object.json" at "nope" {}..',
  'fetch "https://example.org/t/wide.json" at "nope" {}..',
  "fetch 5 {}..",
  'fetch "ftp://x" {}..',
  'fetch "https://example.org/t/rows-10001.json" {}..',
  'limit 3 fetch "https://example.org/t/rows-10001.json" {}..',
  'fetch "https://example.org/t/rows-50001.json" {}..',
  `[${Array.from({ length: 11 }, (_, i) => `fetch "https://example.org/t/x${i}.json" {}`).join(" ")}]..`,
  `[${Array.from({ length: 11 }, (_, i) => `limit 0 fetch "https://example.org/people.json?${i}" {}`).join(" ")}]..`,
  `let a = ${E("people.json")} {}.. let b = ${E("people.json")} {}.. join {with: b on: "name" prefix: "b-"} from a {}..`,
  'let a = fetch "https://example.org/missing.json" {}.. join {with: a on: "id"} from a {}..',
  // where.
  'where ["age" EQUALS "34"] fetch "https://example.org/people.json" {}..',
  'where ["age" EQUALS 34.0] fetch "https://example.org/people.json" {}..',
  'where ["age" IN ["34" 41]] fetch "https://example.org/people.json" {}..',
  'where ["tags" CONTAINS "dev"] fetch "https://example.org/people.json" {}..',
  'where ["address" CONTAINS "Object"] fetch "https://example.org/people.json" {}..',
  'where ["age" CONTAINS 4] fetch "https://example.org/people.json" {}..',
  'where ["name" ABOVE "B"] fetch "https://example.org/people.json" {}..',
  'where ["name" ABOVE 3] fetch "https://example.org/people.json" {}..',
  'where ["age" ABOVE "3e1"] fetch "https://example.org/people.json" {}..',
  'where ["age" NOPE 1] fetch "https://example.org/people.json" {}..',
  'where [5 ABOVE 1] fetch "https://example.org/people.json" {}..',
  'where ["age"] fetch "https://example.org/people.json" {}..',
  'where ["age" ABOVE 1 2] fetch "https://example.org/people.json" {}..',
  'where ["age" PRESENT] rows [] {}..',
  'where ["nope" PRESENT] rows [] {}..',
  'where ["a" EQUALS null] rows [{a: null} {a: 1}] {}..',
  'where ["a" NOT-EQUALS null] rows [{a: null} {a: 1}] {}..',
  'where ["a" STARTS-WITH ""] rows [{a: ""} {a: 1} {a: false}] {}..',
  'where ["a" ABOVE null] rows [{a: 1}] {}..',
  'where ["a" ABOVE [1]] rows [{a: 1}] {}..',
  'where ["a" ABOVE true] rows [{a: true}] {}..',
  'where ["a" BELOW "b"] rows [{a: "a"} {a: "B"} {a: "ä"}] {}..',
  'where ["a" EQUALS "x"] rows [1 2] {}..',
  'where ["0" EQUALS 1] rows [[1] [2]] {}..',
  'where ["length" ABOVE 1] rows [[1] [2 3]] {}..',
  // Functions of the record.
  'where (<row: gt (get "age" row) 30>) fetch "https://example.org/people.json" {}..',
  'where <row: gt (get "age" row) 30> fetch "https://example.org/people.json" {}..',
  "where ((<row: true>)) rows [{a: 1}] {}..",
  'where (<row: get "a" row>) rows [{a: 1}] {}..',
  'where (<row: get "a" row>) rows [{b: 1}] {}..',
  'where (<row: "yes">) rows [{a: 1}] {}..',
  "where (<row: [1]>) rows [{a: 1}] {}..",
  "where (<row: {}>) rows [{a: 1}] {}..",
  'where (<row: add "a" 1>) rows [{a: 1}] {}..',
  'where (<row: equiv (get "a" row) A>) rows [{a: A} {a: B}] {}..',
  'where (<row: fetch "https://example.org/people.json" {}>) rows [{a: 1}] {}..',
  "where (<row: rows [] {}>) rows [{a: 1}] {}..",
  "where (<row: true>) rows [] {}..",
  "where (<a b: true>) rows [{a: 1}] {}..",
  'where (<row: get "kind" row>) rows [{kind: A}] {}..',
  'derive {x: <row: get "a" row>} rows [{a: 1} {a: [2 3]} {a: {b: 4}} {a: null}] {}..',
  'derive {x: <row: get "nope" row>} rows [{a: 1}] {}..',
  'derive {x: <row: get "nope" row>} rows [] {}..',
  'derive {x: 5 y: "s" z: <row: add (get "x" row) 1>} rows [{a: 1}] {}..',
  'derive {a: <row: mul (get "a" row) 2>} rows [{a: 1 b: 2}] {}..',
  "derive {10: <row: 1> 2: <row: 2>} rows [{a: 1}] {}..",
  'derive {"x y": (<row: 1>)} rows [{a: 1}] {}..',
  "derive {x: <row: div 1 0>} rows [{a: 1}] {}..",
  "derive {x: <row: div 0 0>} rows [{a: 1}] {}..",
  "derive {x: <row: div 1 3>} rows [{a: 1}] {}..",
  "derive {x: <row: add 0.1 0.2>} rows [{a: 1}] {}..",
  "derive {x: <row: mul 12345678901234567890 1>} rows [{a: 1}] {}..",
  "derive {x: <row: A>} rows [{a: 1}] {}..",
  "derive {x: <row: <y: y>>} rows [{a: 1}] {}..",
  "derive {x: <row: row>} rows [{a: 1}] {}..",
  'derive {x: <row: fetch "https://example.org/people.json" {}>} rows [{a: 1}] {}..',
  'derive {x: <row: add "a" 1>} rows [{a: 1}] {}..',
  'derive {x: <row: get "when" row>} fetch "https://example.org/t/typed.csv" {}..',
  'derive {x: <row: concat (get "name" row) "!">} limit 2 fetch "https://example.org/people.json" {}..',
  "derive {} rows [{a: 1}] {}..",
  "derive [] rows [{a: 1}] {}..",
  'derive [["x" 1]] rows [{a: 1}] {}..',
  'derive ["xy"] rows [{a: 1}] {}..',
  "derive [5] rows [{a: 1}] {}..",
  "derive [null] rows [{a: 1}] {}..",
  "derive [{a: 1}] rows [{a: 1}] {}..",
  'derive [["x"]] rows [{a: 1}] {}..',
  "derive [5] rows [] {}..",
  "derive 5 rows [{a: 1}] {}..",
  'derive {x: 1} fetch "https://example.org/api.json" at "meta" {}..',
  'derive {x: <row: 1>} rows [5 "s" null [1]] {}..',
  // Field shaping.
  'pick ["a" "a"] rows [{a: 1}] {}..',
  'pick ["b" "a"] rows [{a: 1 b: null}] {}..',
  "pick [] rows [{a: 1}] {}..",
  'pick ["a"] rows [] {}..',
  'pick ["a"] rows [{a: 1} 5 "s"] {}..',
  'omit ["a"] rows [{a: 1 b: 2} [1 2] "ab" 5] {}..',
  'omit ["a"] rows [{a: 1} null] {}..',
  'omit ["a" "a"] rows [{a: 1 b: 2}] {}..',
  'rename {a: "b"} rows [{a: 1 b: 2}] {}..',
  'rename {a: "a"} rows [{a: 1}] {}..',
  'rename {a: "10"} rows [{a: 1 b: 2}] {}..',
  "rename {a: 5} rows [{a: 1}] {}..",
  "rename [] rows [{a: 1}] {}..",
  "rename {} rows [{a: 1}] {}..",
  'rename {"a.b": "c"} rows [{a: {b: 1} c: 2}] {}..',
  'rename {"a.b": "a"} rows [{a: {b: 1} c: 2}] {}..',
  'rename {"a.b": "c"} rows [{a: {x: 1}}] {}..',
  'rename {"a.b": "c"} rows [{"a.b": 1}] {}..',
  'rename {a: "b" b: "a"} rows [{a: 1 b: 2}] {}..',
  'rename {a: "b"} rows [{a: 1} null] {}..',
  "fill {a: 0} rows [{a: null} {b: 1} {a: false} {a: 2}] {}..",
  "fill {} rows [{a: 1}] {}..",
  "fill [1] rows [{a: 1}] {}..",
  'fill {a: 1 10: 2} rows [5 "s" null] {}..',
  'spread "a" rows [{x: 0 a: {b: 1 c: 2} z: 3} {a: 5} {a: [1]} {a: null}] {}..',
  'spread "a" rows [{a: {}} 5] {}..',
  'spread "a" rows [null] {}..',
  'unnest "a" rows [{x: 0 a: [1 {b: 2} [3]] z: 3} {a: []} {a: 5}] {}..',
  'unnest "a" rows [{a: "str"}] {}..',
  'unnest "a" rows [{a: [1]} null] {}..',
  'unnest "a.b" rows [{a: {b: [1 2]}}] {}..',
  'spread "a.b" rows [{a: {b: {c: 1}}}] {}..',
  // Summaries and order.
  "summarize {n: COUNT} rows [] {}..",
  'summarize {n: COUNT} group-by ["a"] rows [] {}..',
  'summarize {s: [SUM "a"]} rows [] {}..',
  'summarize {s: [SUM "a"] m: [MIN "a"] x: [MAX "a"] md: [MEDIAN "a"] av: [AVERAGE "a"]} rows [{a: 0.1} {a: 0.2} {a: "0.3"} {a: null} {b: 1}] {}..',
  'summarize {md: [MEDIAN "a"]} rows [{a: 3} {a: 1} {a: 2} {a: 10}] {}..',
  'summarize {md: [MEDIAN "a"]} rows [{a: 0.1} {a: 0.2}] {}..',
  'summarize {av: [AVERAGE "a"]} rows [{a: 1} {a: 1} {a: 2}] {}..',
  'summarize {s: [SUM "a"]} rows [{a: 1e308} {a: 1e308}] {}..',
  'summarize {s: [SUM "a"]} rows [{a: "Infinity"} {a: 1}] {}..',
  'summarize {d: [COUNT-DISTINCT "a"]} rows [{a: 1} {a: "1"} {a: [1]} {a: {b: 1}} {a: {b: 1}}] {}..',
  'summarize {n: [COUNT "a"]} rows [{a: 1} {a: null} {b: 2}] {}..',
  "summarize {n: [COUNT 5]} rows [{a: 1}] {}..",
  'summarize {n: [COUNT 5]} rows [{"5": 1}] {}..',
  "summarize {n: COUNT x: [SUM]} rows [{a: 1}] {}..",
  "summarize {n: NOPE} rows [{a: 1}] {}..",
  'summarize {n: [5 "a"]} rows [{a: 1}] {}..',
  'summarize {n: "COUNT"} rows [{a: 1}] {}..',
  "summarize {} rows [{a: 1}] {}..",
  "summarize [COUNT] rows [{a: 1}] {}..",
  'summarize {n: COUNT 3: [SUM "a"]} group-by ["b" "a"] rows [{a: 1 b: "x"} {a: 2 b: "y"} {a: 3 b: "x"} {b: "x"}] {}..',
  'summarize {n: COUNT} group-by ["a"] rows [{a: {z: 1 y: 2}} {a: [1]} {a: true} {a: "1"} {a: 1}] {}..',
  'summarize {m: [MIN "a"] x: [MAX "a"]} rows [{a: "b"} {a: 2} {a: "a"} {a: true}] {}..',
  'summarize {n: COUNT} group-by ["when"] fetch "https://example.org/t/typed.csv" {}..',
  'sort-by ["a"] rows [{a: 2} {a: "10"} {a: "b"} {a: null} {a: "B"} {a: 1} {} {a: "a"} {a: true} {a: "Infinity"} {a: "-Infinity"}] {}..',
  'sort-by ["a" DESC "b"] rows [{a: 1 b: 2} {a: 1 b: 1} {a: 2 b: 0}] {}..',
  'sort-by ["a" ASC DESC] rows [{a: 1} {a: 2}] {}..',
  'sort-by [DESC "a"] rows [{a: 1}] {}..',
  "sort-by [] rows [{a: 1}] {}..",
  'sort-by "a" rows [{a: 1}] {}..',
  'sort-by ["a" "b" NOPE] rows [{a: 1}] {}..',
  'sort-by ["name"] fetch "https://example.org/t/unicode.json" {}..',
  'sort-by ["city" DESC] fetch "https://example.org/t/unicode.json" {}..',
  "limit 0 rows [{a: 1}] {}..",
  "limit 1.5 rows [{a: 1}] {}..",
  "limit -1 rows [{a: 1}] {}..",
  "limit 99999999999 rows [{a: 1}] {}..",
  "skip 5 rows [{a: 1}] {}..",
  "skip 0 rows [{a: 1}] {}..",
  'limit 1 fetch "https://example.org/api.json" {}..',
  'distinct [] rows [{a: 1} {a: 1} {a: 2} 5 5 "5"] {}..',
  'distinct ["a"] rows [{a: 1} {a: "1"} {b: 1} {a: null}] {}..',
  "distinct [5] rows [{a: 1}] {}..",
  // join.
  'let c = rows [{id: 1 v: "a"} {id: 1 v: "b"} {id: 2 v: "c"}] {}.. join {with: c on: "id"} rows [{id: 1} {id: 3} {id: 2 v: "x"}] {}..',
  'let c = rows [{id: 1 v: "a"}] {}.. join {with: c on: "id" kind: INNER} rows [{id: 1} {id: 3}] {}..',
  'let c = rows [{id: 1 v: "a"}] {}.. join {with: c on: "id" kind: OUTER} rows [{id: 1}] {}..',
  'let c = rows [{id: 1 v: "a"}] {}.. join {with: c on: "id" kind: "LEFT"} rows [{id: 1}] {}..',
  'let c = rows [{id: 1 v: "a"}] {}.. join {with: c on: "id" prefix: 5} rows [{id: 1}] {}..',
  'let c = rows [{id: 1 v: "a"}] {}.. join {with: c on: "id" prefix: null} rows [{id: 1}] {}..',
  'let c = rows [{id: 1 v: "a"}] {}.. join {with: c on: ["id"]} rows [{id: 1}] {}..',
  'let c = rows [{id: 1 v: "a"}] {}.. join {with: c on: 5} rows [{id: 1}] {}..',
  'let c = rows [{id: 1 v: "a"}] {}.. join {with: c} rows [{id: 1}] {}..',
  'join {with: [{id: 1 w: 2}] on: "id"} rows [{id: 1}] {}..',
  'join {with: [{id: "1" w: 2}] on: "id"} rows [{id: 1}] {}..',
  'join {with: {id: 1} on: "id"} rows [{id: 1}] {}..',
  'join {with: 5 on: "id"} rows [{id: 1}] {}..',
  "join [] rows [{id: 1}] {}..",
  'join {with: [{id: null w: 2}] on: "id"} rows [{x: 1}] {}..',
  'join {with: [{id: 1 w: 2} 5 null] on: "id"} rows [{id: 1}] {}..',
  'join {with: [{id: 1 w: 2}] on: "id" nope: 1 also: 2} rows [{id: 1}] {}..',
  'let c = rows [{id: 1 v: "a"}] {}.. join {with: c on: "nope"} rows [{id: 1}] {}..',
  // Shadowed L0000 words, and L0000 inside programs.
  "take 2 rows [{a: 1}] {}..",
  "drop 1 rows [{a: 1}] {}..",
  "filter (<r: true>) rows [{a: 1}] {}..",
  "map (<r: r>) rows [{a: 1}] {}..",
  "last rows [{a: 1}] {}..",
  "take 2 [1 2 3]..",
  "last [1 2 3]..",
  "map (<x: add x 1>) [1 2]..",
  "take 1 {}..",
  "last {}..",
  "rows (take 2 [{a: 1} {a: 2} {a: 3}]) {}..",
  "rows (map (<x: {v: x}>) (range 1 4 1)) {}..",
  'rows [{a: add 1 2 b: concat "x" "y" c: [A B]}] {}..',
  "rows [{a: 12345678901234567890 b: 0.1 c: -0 d: 1e21 e: 1.5e-7}] {}..",
  "rows [{a: div 1 0 b: div 0 0}] {}..",
  'rows [{a: format-number "0.0" 1.25}] {}..',
  'rows [{a: format-number "bad" 1}] {}..',
  'rows [{a: get-var "nope"}] {}..',
  "rows (range 0 10001 1) {}..",
  "limit 2 rows (range 0 10001 1) {}..",
  "rows (range 0 50001 1) {}..",
  'rows [{"10": 1 "2": 2 b: 3 "01": 4}] {}..',
  'rows [{a: {"10": 1 "2": 2}}] {}..',
  'pick ["a"] rows [{a: A}] {}..',
  'where ["a" EQUALS A] rows [{a: A}] {}..',
  "rows [A] {}..",
  'rows [{tag: "x" n: 1}] {}..',
  'derive {w: <row: get "when" row>} fetch "https://example.org/t/typed.csv" {}..',
  "rows [{a: <x: x>}] {}..",
  "rows [{a: rows [{b: 1}] {}}] {}..",
  "let x = rows [{b: 1}] {}.. rows [{a: x}] {}..",
  "let x = rows [{b: 1}] {}.. rows [x] {}..",
  "let x = limit 1 rows [{b: 1}] {}.. from x {}..",
  'let x = group-by ["b"] rows [{b: 1}] {}.. from x {}..',
  'let x = group-by ["b"] rows [{b: 1}] {}.. summarize {n: COUNT} from x {}..',
  'let x = at "a" {}.. fetch "https://example.org/api.json" x..',
  "let x = rows [{b: 1}] {}.. limit 1 x..",
  "limit 1 (rows [{b: 1}] {})..",
  // Output limits.
  'let albums = fetch "https://example.org/albums.json" {}.. join {with: albums on: ["albumId" "id"] prefix: "album-"} fetch "https://example.org/photos.json" {}..',
  'fetch "https://example.org/photos.json" {}..',
  'pick ["id"] fetch "https://example.org/photos.json" {}..',
  'summarize {n: COUNT} fetch "https://example.org/comments.json" {}..',
];

// The string programs in the TypeScript suite, with its constants and helpers expanded.
function testPrograms(path) {
  const source = readFileSync(join(root, path), "utf8");
  const consts = {};
  for (const m of source.matchAll(/const ([A-Z_]+) = (['"`])((?:\\.|(?!\2).)*)\2;/g))
    consts[m[1]] = m[3].replace(/\\"/g, '"');
  const expand = (text) => text.replace(/\$\{([A-Z_]+)\}/g, (_, name) => consts[name] ?? "");
  const found = [];
  const strings = (re, wrap) => {
    for (const m of source.matchAll(re)) {
      const quote = m[1];
      let i = m.index + m[0].length;
      let text = "";
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") text += source[i++];
        text += source[i++];
      }
      const value = quote === "`" ? expand(text) : new Function(`return ${quote}${text}${quote}`)();
      if (!value.includes("${")) found.push(wrap(value));
    }
  };
  strings(/(?:compile|errorOf)\(\s*(['"`])/g, (s) => s);
  strings(/names\(\s*(['"`])/g, (cond) => `pick ["name"] where ${cond} ${consts.PEOPLE}`);
  for (const m of source.matchAll(/run\(("(?:[^"\\]|\\.)*"), ([^)]+)\)/g)) {
    found.push(`format {t: ${m[1]}} rows [{t: ${m[2]}}] {}`);
  }
  return found;
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
]
  .flatMap(blocks)
  .map((block) => block.trim())
  .filter((src) => src.includes("{}") && !src.includes("…"));

const programs = [
  ...fragments,
  ...testPrograms("packages/core/src/compiler.test.ts"),
  ...testPrograms("packages/core/src/errors.test.ts"),
  ...handwritten,
  ...generated,
].map((src) => (src.trim().endsWith("..") ? src : `${src}..`));

function run(code) {
  const compiled = new Promise((resolve) =>
    compiler.compile(code, {}, {}, (err, val) => {
      const errors = (Array.isArray(err) ? err : err ? [err] : []).filter(Boolean);
      if (errors.length > 0) resolve({ errors: errors.map((e) => String(e.message ?? e)) });
      else resolve(val === undefined ? {} : { text: JSON.stringify(val) });
    }),
  );
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
  return Promise.race([compiled, timeout]);
}

process.on("uncaughtException", () => {});

const MAX_TEXT = 120_000;
const log = console.log;
const warn = console.warn;
const seen = new Set();
const cases = [];
let skipped = 0;
for (const src of programs) {
  if (seen.has(src)) continue;
  seen.add(src);
  console.log = () => {};
  console.warn = () => {};
  let ast, expect;
  try {
    ast = await parser.parse(185, src, structuredClone(lexicon));
    expect = await run(ast);
  } catch {
    expect = null;
  } finally {
    console.log = log;
    console.warn = warn;
  }
  if (expect === null || (expect.text && expect.text.length > MAX_TEXT)) {
    skipped++;
    continue;
  }
  cases.push({ src, ast, expect });
}
writeFileSync(
  join(here, "cases.json"),
  "[\n" + cases.map((entry) => JSON.stringify(entry)).join(",\n") + "\n]\n",
);
const used = Object.fromEntries(Object.entries(fetches).sort(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(join(here, "fetches.json"), JSON.stringify(used, null, 1) + "\n");
console.log(
  `wrote ${cases.length} cases (${cases.filter((c) => c.expect.errors).length} with errors), skipped ${skipped}`,
);
process.exit(0);
