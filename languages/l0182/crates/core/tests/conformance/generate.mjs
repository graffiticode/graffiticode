// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0182 is tested against, from the TypeScript L0182 in
// this directory (packages/core):
//
//   cases.json                        programs parsed with L0182's lexicon and compiled by
//                                     @graffiticode/l0182, with the AST, the survey data the
//                                     compile was served when it was not the real data/
//                                     directory (`fixture`), and the result
//   ../../src/lexicon-additions.json  the words L0182 adds to the base lexicon
//   ../../src/vocab.json              the attribute table, the containers' words, the scale
//                                     presets and the default wording, from packages/core/src
//
// The corpus:
//
// - every program the TypeScript suite parses, recorded by running that suite with
//   record.setup.mjs, each with the survey its fixture source was serving at the time;
// - the spec's programs and template.gc;
// - generated from the installed surveys: every survey and version taken bare and with a
//   session, and answered right and wrong in every notation, on every scale point;
// - generated from the attribute table: every word with a value of each kind, on its own and
//   inside each container;
// - every fixture survey the suite installs, taken bare and answered;
// - hand-written cases: survey data that breaks every rule, ids that are not ids, and the
//   degenerate programs.
//
// A draw is random in the TypeScript. Here every case starts with no draws taken and
// Math.random() always 0, so an id naming several versions takes the first untaken one; the
// Rust test does the same.
//
// Needs `npm ci && npm run -w packages/core build` here; `npm run rust:fixtures` does the
// build. `cargo test` reads the committed output.
import { readFileSync, rmSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const core = join(root, "packages/core");
const load = (path) => import(pathToFileURL(join(root, path)).href);

const { parser } = await load("node_modules/@graffiticode/parser/src/index.js");
const { compiler, lexicon, setSource, resetDraws, attributeFields, validAttributes, PRESETS } =
  await load("packages/core/dist/index.js");
const { DEFAULT_INSTRUCTIONS, DEFAULT_RATING_INSTRUCTIONS } = await load(
  "packages/core/dist/survey.js",
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

// attributes.ts and scales.ts are the single source of truth for the vocabulary and presets.
writeFileSync(
  join(root, "crates/core/src/vocab.json"),
  JSON.stringify(
    {
      attributes: Object.fromEntries(
        Object.entries(attributeFields).map(([name, { field, expects }]) => [
          name,
          { field, expects },
        ]),
      ),
      validAttributes,
      presets: PRESETS,
      defaultInstructions: DEFAULT_INSTRUCTIONS,
      defaultRatingInstructions: DEFAULT_RATING_INSTRUCTIONS,
    },
    null,
    2,
  ) + "\n",
);

/* ------------------------------------------------- programs the TS suite parses */

async function recordSuite() {
  const out = join(tmpdir(), `l0182-record-${process.pid}.jsonl`);
  rmSync(out, { force: true });
  process.env.L0182_RECORD = out;
  const { startVitest } = await import(
    pathToFileURL(join(root, "node_modules/vitest/dist/node.js")).href
  );
  const cwd = process.cwd();
  // docs.test.ts reads spec/ relative to the package, as the workspace script runs it.
  process.chdir(core);
  const vitest = await startVitest("test", [], {
    root: core,
    watch: false,
    reporters: ["dot"],
    setupFiles: [join(here, "record.setup.mjs")],
  });
  await vitest?.close();
  process.chdir(cwd);
  delete process.env.L0182_RECORD;
  const lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
  rmSync(out, { force: true });
  // The suite's files run in parallel, so the order they were recorded in is not stable.
  return lines.sort().map((line) => JSON.parse(line));
}

const recorded = await recordSuite();
console.log(`recorded ${recorded.length} programs from the TypeScript suite`);

/* ------------------------------------------------------------- the spec */

function fences(path) {
  const out = [];
  let current = null;
  for (const line of readFileSync(join(core, path), "utf8").split("\n")) {
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
const spec = ["spec/spec.md", "spec/instructions.md", "spec/usage-guide.md"]
  .flatMap(fences)
  .map((block) => block.trim())
  .filter((src) => src.endsWith(".."))
  .concat([readFileSync(join(core, "spec/template.gc"), "utf8")]);

/* ------------------------------------------------------------- compiling */

const values = { itemId: "item-7Kq2" };
const publicValues = (vals) => ({ GET_VAL_PUBLIC: (name) => vals[name] ?? "" });

function run(code) {
  const compiled = new Promise((resolve) =>
    compiler.compile(code, {}, {}, (err, val) => {
      const errors = (Array.isArray(err) ? err : err ? [err] : []).filter(Boolean);
      const messages = errors.map((e) => String(e.message ?? e));
      if (errors.length > 0) resolve({ errors: messages });
      else resolve(val === undefined ? {} : { text: JSON.stringify(val) });
    }),
  );
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
  return Promise.race([compiled, timeout]);
}

/**
 * Compile one program against the real surveys, or, given `fixture` (`{data}`), against that
 * survey served the way the suite serves one.
 */
async function compileCase(src, fixture, vals) {
  resetDraws();
  Math.random = () => 0;
  setSource(
    fixture === undefined
      ? undefined
      : async (id) => ({ instance: `${id}-1`, data: structuredClone(fixture.data) }),
  );
  const ast = await parser.parse(
    182,
    src,
    structuredClone(lexicon),
    vals ? publicValues(vals) : undefined,
  );
  const expect = await run(ast);
  setSource();
  return { ast, expect };
}

/** The compiled value of a program that must compile. */
async function value(src, fixture = undefined) {
  const { expect } = await compileCase(src, fixture, values);
  if (!expect?.text) throw new Error(`expected a value: ${src} ${JSON.stringify(expect)}`);
  return JSON.parse(expect.text);
}

/* --------------------------------------------- generated from the surveys */

const q = (s) => JSON.stringify(s);
const files = readdirSync(join(core, "data"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();
const surveyIds = [...new Set(files.map((f) => f.replace(/-\d+$/, "")))].sort();

const generated = []; // [src, fixture]
const take = (id, body = "") => `survey [ id ${q(id)} ${body} ]..`;
const respond = (id, body) => take(id, `response [ ${body} ]`);

for (const id of surveyIds) {
  generated.push([take(id), undefined]);
  generated.push([take(id, 'session-id "s-1"'), undefined]);
  generated.push([take(id, 'session-id get-val-public "itemId"'), undefined]);
  generated.push([take(id, 'session-id "  "'), undefined]);
}

/** Answers a ranked-choice survey every way, and wrongly every way. */
function rankedAnswers(id, survey) {
  const { options, minChoices, maxChoices } = survey;
  const out = [];
  const texts = options.map((o) => o.text);
  const choose = (refs) => respond(id, `choices [${refs.join(" ")}]`);
  for (const n of new Set([Math.max(minChoices - 1, 0), minChoices, maxChoices, maxChoices + 1])) {
    if (n === 0) continue;
    out.push(choose(texts.slice(0, n).map(q)));
    out.push(choose(options.slice(0, n).map((o) => q(o.id))));
    out.push(choose(options.slice(0, n).map((_, i) => String(n - 1 - i))));
  }
  out.push(choose([q(`  ${texts[0].toUpperCase().replace(/ /g, "   ")} `)]));
  out.push(choose([q(texts[0].slice(0, -2))]));
  out.push(choose([q(texts[0]), q(options[0].id)]));
  out.push(choose([String(options.length)]));
  out.push(choose(["-1"]));
  out.push(choose(["0", "0"]));
  out.push(respond(id, `choices [0] write-in "a brand new idea"`));
  out.push(respond(id, `write-in "a brand new idea"`));
  out.push(respond(id, `choices [0] write-in ${q(texts[1].toUpperCase())}`));
  out.push(respond(id, `choices [0] write-in "   "`));
  out.push(respond(id, `choices [0] comment "x"`));
  out.push(respond(id, `ratings [[item 0 rating 1]]`));
  out.push(respond(id, `ratings [[item 0 rating 1]] comment "x"`));
  return out;
}

/** Every way to say each point of an item's scale, and some ways that are not. */
function pointAnswers(item) {
  const out = [];
  const { points, optOut } = item.scale;
  for (const p of points) {
    out.push(String(p.value));
    out.push(q(String(p.value)));
    if (p.label) out.push(q(p.label), q(` ${p.label.toUpperCase()}  `));
  }
  if (item.anchors) out.push(q(item.anchors[0]), q(item.anchors[1].toUpperCase()));
  if (optOut) out.push(q(optOut), q(optOut.toLowerCase()));
  out.push(String(points[0].value - 1), String(points.at(-1).value + 1), "2.5");
  out.push('"nope"', '"-0"', '"0"', '"07"', '"1.0"', '" 3 "');
  return out;
}

/** Answers a rating survey every way, and wrongly every way. */
function ratingAnswers(id, survey) {
  const { items, comment } = survey;
  const out = [];
  const first = (item) => {
    const p = item.scale.points[0];
    return p.label ? q(p.label) : String(p.value);
  };
  const entry = (ref, rating) => `[item ${ref} rating ${rating}]`;
  const all = items.map((item) => entry(q(item.text), first(item)));
  const rate = (entries, rest = "") => respond(id, `ratings [${entries.join(" ")}] ${rest}`);
  out.push(rate(all));
  out.push(rate(items.map((item) => entry(q(item.id), first(item)))));
  out.push(rate(items.map((_, i) => entry(String(i), first(item(i))))));
  function item(i) {
    return items[i];
  }
  out.push(rate([...all].reverse()));
  out.push(rate(all, 'comment "More of this, please."'));
  out.push(rate(all, 'comment "  "'));
  out.push(rate(all.slice(1)));
  out.push(rate(all.slice(0, 1)));
  out.push(rate([...all, all[0]]));
  out.push(rate([...all, entry('"Something else entirely"', "1")]));
  out.push(rate([...all, entry(String(items.length), "1")]));
  out.push(rate(all, "choices [0]"));
  out.push(rate(all, 'write-in "x"'));
  out.push(respond(id, 'comment "only a comment"'));
  // Every way to answer an item, the others answered as usual: once per distinct scale (and
  // anchors) in the survey, which keeps the fixture small without losing a scale form.
  const shapes = new Set();
  items.forEach((it, i) => {
    const shape = JSON.stringify([it.scale, it.anchors]);
    if (shapes.has(shape)) return;
    shapes.add(shape);
    for (const answer of pointAnswers(it)) {
      const entries = [...all];
      entries[i] = entry(q(it.text), answer);
      out.push(rate(entries));
    }
  });
  if (!comment) out.push(rate(all, 'comment "x"'));
  return out;
}

for (const instance of files) {
  generated.push([take(instance), undefined]);
  const { survey } = await value(take(instance));
  const answers =
    survey.style === "rating" ? ratingAnswers(instance, survey) : rankedAnswers(instance, survey);
  for (const src of answers) generated.push([src, undefined]);
}

/* ------------------------------------------ generated from the attribute table */

const samples = [
  '"text"',
  '""',
  '"   "',
  "0",
  "2",
  "-1",
  "1.5",
  "true",
  "null",
  "[]",
  '["a" 1]',
  "[0 1]",
  '[""]',
  "[1.5]",
  "[true]",
  "[[]]",
  "[[item 0 rating 1]]",
  "[{a: 1}]",
  "{a: 1}",
  "{}",
  "tag red",
  "[tag red]",
  'get-var "nope"',
  '[get-var "nope"]',
  "12345678901234567890",
];
const wordOf = (name) => name.toLowerCase().replace(/_/g, "-");
const words = Object.keys(attributeFields).map(wordOf);
for (const word of words) {
  for (const sample of samples) {
    generated.push([`${word} ${sample}..`, undefined]);
    generated.push([`survey [ id "school-1" ${word} ${sample} ]..`, undefined]);
    generated.push([`survey [ id "school-1" response [ ${word} ${sample} ] ]..`, undefined]);
    generated.push([
      `survey [ id "course-feedback-1" response [ ratings [ [ ${word} ${sample} ] ] ] ]..`,
      undefined,
    ]);
  }
}
for (const container of ["survey", "response"]) {
  for (const sample of samples) generated.push([`${container} ${sample}..`, undefined]);
  generated.push([`${container} [ ${words.map((w) => `${w} "x"`).join(" ")} ]..`, undefined]);
}

/* ------------------------------------------------------- the suite's fixtures */

const fixtures = [];
const seenFixture = new Set();
for (const { fixture } of recorded) {
  const key = JSON.stringify(fixture);
  if (fixture !== null && !seenFixture.has(key)) {
    seenFixture.add(key);
    fixtures.push(fixture);
  }
}
// Survey data as JSON carries it, so the fixture in cases.json is exactly what was served.
const asFixture = (data) => ({ data: JSON.parse(JSON.stringify(data) ?? "null") });

/** Survey data that breaks one rule each, beyond what the suite installs. */
const R = (d) => ({ style: "rating", ...d });
const broken = [
  "just a string",
  42,
  null,
  true,
  [],
  ["a", "b"],
  ["a", "  "],
  ["a", null],
  ["a", ["b"]],
  ["a", { text: "b", id: "" }],
  ["a", { text: "b", id: 5 }],
  ["a", { text: "  " }],
  ["a", { text: 5 }],
  ["  a  ", { text: " b ", id: " x " }],
  { style: "poll", options: ["a", "b"] },
  { style: null, options: ["a", "b"] },
  { style: "ranked-choice" },
  { style: "ranked-choice", options: "a,b" },
  { style: "ranked-choice", options: ["a", "b"], minChoices: -1 },
  { style: "ranked-choice", options: ["a", "b"], minChoices: "1" },
  { style: "ranked-choice", options: ["a", "b"], minChoices: null },
  { style: "ranked-choice", options: ["a", "b"], maxChoices: 0 },
  { style: "ranked-choice", options: ["a", "b"], maxChoices: [1, 2] },
  { style: "ranked-choice", options: ["a", "b"], maxChoices: { n: 1 } },
  { style: "ranked-choice", options: ["a", "b"], minChoices: 0, maxChoices: 2 },
  { style: "ranked-choice", options: ["a", "b", "c"], title: 7, instructions: null },
  { style: "ranked-choice", options: ["a", "b", "A"] },
  { style: "ranked-choice", options: ["a b", "a  b"] },
  { style: "ranked-choice", options: [{ id: "1", text: "x" }, { id: "0", text: "y" }, "z"] },
  { style: "ranked-choice", options: [{ id: "o1", text: "x" }, "y"] },
  R({}),
  R({ items: "a" }),
  R({ scale: "nps", items: [5] }),
  R({ scale: "nps", items: [null] }),
  R({ scale: "nps", items: [["a"]] }),
  R({ scale: "nps", items: [{ id: "x" }] }),
  R({ scale: "nps", items: [{ text: "a", id: "" }] }),
  R({ scale: "nps", items: [{ text: "a", id: 3 }] }),
  R({ scale: "nps", items: [{ text: "a", required: "yes" }] }),
  R({
    scale: "nps",
    items: [
      { text: "a", required: false },
      { text: "b", required: true },
    ],
  }),
  R({
    scale: "nps",
    items: [
      { text: "a", id: "x" },
      { text: "b", id: "x" },
    ],
  }),
  R({ scale: "nps", items: [" a ", "b"] }),
  R({ scale: "nps", items: ["a"], scales: [] }),
  R({ scale: "nps", items: ["a"], scales: null }),
  R({ scale: "nps", items: ["a"], scales: "nps" }),
  R({ scale: "mine", items: ["a"], scales: { mine: "stars-5" } }),
  R({ scale: "nps", items: ["a"], scales: { nps: { points: ["no", "yes"] } } }),
  R({ scale: "b", items: ["a"], scales: { b: { preset: "agreement-7" }, a: "nope" } }),
  R({ scale: "x", items: ["a"], scales: { 2: "nps", x: "stars-5", 1: "nope" } }),
  R({ scale: "", items: ["a"], scales: { "": { points: ["no", "yes"] } } }),
  R({ scale: null, items: ["a"] }),
  R({ scale: 5, items: ["a"] }),
  R({ scale: ["nps"], items: ["a"] }),
  R({ scale: {}, items: ["a"] }),
  R({ scale: { preset: "nps", points: ["a", "b"] }, items: ["a"] }),
  R({ scale: { preset: "nps", points: ["a", "b"], min: 1 }, items: ["a"] }),
  R({ scale: { preset: "nope" }, items: ["a"] }),
  R({ scale: { preset: { preset: "stars-5" } }, items: ["a"] }),
  R({ scale: { preset: "stars-5", optOut: "Skip", display: "stars" }, items: ["a"] }),
  R({ scale: { preset: "agreement-5", display: "stars", optOut: "N/A" }, items: ["a"] }),
  R({ scale: { points: ["no", "yes"], display: "stars", optOut: "N/A" }, items: ["a"] }),
  R({ scale: { points: ["no", "yes"], display: "bars" }, items: ["a"] }),
  R({ scale: { points: ["no", "yes"], optOut: 5 }, items: ["a"] }),
  R({ scale: { points: ["no", "yes"], optOut: "  " }, items: ["a"] }),
  R({ scale: { points: ["no", "yes"], optOut: " YES " }, items: ["a"] }),
  R({ scale: { points: "no,yes" }, items: ["a"] }),
  R({ scale: { points: ["only"] }, items: ["a"] }),
  R({ scale: { points: [] }, items: ["a"] }),
  R({
    scale: { points: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"] },
    items: ["a"],
  }),
  R({ scale: { points: ["no", "  "] }, items: ["a"] }),
  R({ scale: { points: ["no", 5] }, items: ["a"] }),
  R({ scale: { points: ["no", null] }, items: ["a"] }),
  R({ scale: { points: ["no", ["x"]] }, items: ["a"] }),
  R({ scale: { points: ["no", { label: "x" }] }, items: ["a"] }),
  R({ scale: { points: ["no", { value: "3" }] }, items: ["a"] }),
  R({ scale: { points: [{ value: 1 }, { value: 2.5 }] }, items: ["a"] }),
  R({ scale: { points: [{ value: 1 }, { value: 1 }] }, items: ["a"] }),
  R({ scale: { points: [{ value: -2, label: "low" }, { value: 2 }] }, items: ["a"] }),
  R({ scale: { points: [{ value: 0, label: 7 }, { value: 2 }] }, items: ["a"] }),
  R({ scale: { points: [{ value: 0, label: "" }, { value: 2 }] }, items: ["a"] }),
  R({
    scale: {
      points: [
        { value: 0, label: " lo " },
        { value: 2, label: "LO" },
      ],
    },
    items: ["a"],
  }),
  R({ scale: { points: ["no", "yes"], extra: 1 }, items: ["a"] }),
  R({ scale: { min: 1 }, items: ["a"] }),
  R({ scale: { min: 1, max: 1 }, items: ["a"] }),
  R({ scale: { min: 1.5, max: 3 }, items: ["a"] }),
  R({ scale: { min: "1", max: "3" }, items: ["a"] }),
  R({ scale: { min: -5, max: 5 }, items: ["a"] }),
  R({ scale: { min: -5, max: 6 }, items: ["a"] }),
  R({ scale: { min: 0, max: 1e300 }, items: ["a"] }),
  R({ scale: { min: 1, max: 5, anchors: ["bad", "good"] }, items: ["a"] }),
  R({ scale: { min: 1, max: 5, anchors: ["bad"] }, items: ["a"] }),
  R({ scale: { min: 1, max: 5, anchors: "bad" }, items: ["a"] }),
  R({ scale: { min: 1, max: 5, anchors: ["Bad", " bad "] }, items: ["a"] }),
  R({ scale: { min: 1, max: 5, anchors: ["bad", ""] }, items: ["a"] }),
  R({ scale: { min: 1, max: 5, anchors: null }, items: ["a"] }),
  R({ scale: { min: 1, max: 5, preset: null }, items: ["a"] }),
  R({ scale: "nps", items: [{ text: "a", anchors: [" lo ", " hi "] }] }),
  R({ scale: "nps", items: [{ text: "a", anchors: ["lo", 5] }] }),
  R({ scale: "nps", items: [{ text: "a", scale: "stars-5" }, { text: "b" }] }),
  R({ items: [{ text: "a", scale: "stars-5" }, { text: "b" }] }),
  R({ scale: "nps", items: ["a"], comment: false }),
  R({ scale: "nps", items: ["a"], comment: null }),
  R({ scale: "nps", items: ["a"], comment: "yes" }),
  R({ scale: "nps", items: ["a"], comment: 1 }),
  R({ scale: "nps", items: ["a"], comment: [] }),
  R({ scale: "nps", items: ["a"], comment: {} }),
  R({ scale: "nps", items: ["a"], comment: { prompt: "  Why? " } }),
  R({ scale: "nps", items: ["a"], comment: { prompt: "  " } }),
  R({ scale: "nps", items: ["a"], comment: { prompt: null } }),
  R({ scale: "nps", items: ["a"], comment: { prompt: 5 } }),
  R({ scale: "nps", items: ["a"], title: ["x"], instructions: 5 }),
  R({ scale: "frequency-5", items: ["a"] }),
  R({ scale: "importance-5", items: ["a"] }),
  R({ scale: "satisfaction-5", items: ["a"] }),
  R({ scale: "likelihood-5", items: ["a"] }),
  R({ scale: "agreement-7", items: ["a"] }),
  R({
    scale: {
      points: [
        { value: 10, label: "ten" },
        { value: 20, label: "twenty" },
      ],
      optOut: "Skip",
    },
    items: ["a", "b"],
  }),
];

/** What every fixture is taken with: bare, then answered in its own style and in the other's. */
const barePrograms = [take("fixture")];
const rankedPrograms = [
  respond("fixture", "choices [0]"),
  respond("fixture", 'choices ["a" "b"]'),
  respond("fixture", "choices [1 0]"),
  respond("fixture", 'choices ["x"] write-in "b"'),
  respond("fixture", 'choices ["1"]'),
  respond("fixture", 'choices ["a b"]'),
  respond("fixture", "ratings [[item 0 rating 1]]"),
];
const ratingPrograms = [
  respond("fixture", "choices [0]"),
  respond("fixture", "ratings [[item 0 rating 1]]"),
  respond("fixture", "ratings [[item 0 rating 2]]"),
  respond("fixture", 'ratings [[item 0 rating "Skip"]]'),
  respond("fixture", 'ratings [[item 0 rating "yes"]]'),
  respond("fixture", 'ratings [[item 0 rating "lo"]]'),
  respond("fixture", 'ratings [[item 0 rating "hi"]]'),
  respond("fixture", "ratings [[item 0 rating 10] [item 1 rating 20]]"),
  respond("fixture", "ratings [[item 0 rating 25] [item 1 rating 20]]"),
  respond("fixture", 'ratings [[item 1 rating 1]] comment "hi"'),
  respond("fixture", 'ratings [[item "a" rating 3]] comment "hi"'),
];
// Two items whose text folds to the same key: naming either by text is ambiguous.
generated.push([
  respond("fixture", 'ratings [[item "a b" rating 1] [item 1 rating 2]]'),
  asFixture(R({ scale: "nps", items: ["A b", "a  b"] })),
]);
generated.push([
  respond("fixture", 'ratings [[item "q1" rating 1] [item "A b" rating 2]]'),
  asFixture(R({ scale: "nps", items: ["A b", "a  b"] })),
]);

const styleOf = (data) =>
  Array.isArray(data) ? "ranked-choice" : data && typeof data === "object" ? data.style : undefined;
for (const fixture of [...fixtures, ...broken]) {
  const style = styleOf(fixture);
  const answers =
    style === "ranked-choice" ? rankedPrograms : style === "rating" ? ratingPrograms : [];
  for (const src of [...barePrograms, ...answers]) generated.push([src, asFixture(fixture)]);
}

/* ------------------------------------------------------------- hand-written */

const handwritten = [
  "42..",
  '"hello"..',
  "survey..",
  "survey []..",
  "response []..",
  "survey [ id ]..",
  'survey [ id "school-1" id "school-1" ]..',
  'survey [ id "school-1" response [ choices [0] ] response [ choices [1] ] ]..',
  'survey [ id "school-1" response [ choices [0] choices [1] ] ]..',
  'survey [ "school-1" ]..',
  "survey [ 5 ]..",
  'survey [ id "school-1" [ ] ]..',
  'survey [ id "school-1" null ]..',
  'survey [ id "school-1" {} ]..',
  'survey [ {id: "school-1"} ]..',
  'survey [ {id: "school-1" session-id: "s"} ]..',
  'survey [ {id: "school-1" sessionId: " s-2 "} ]..',
  'survey [ {id: "school-1" 1: 2} ]..',
  'survey [ {id: ["school-1"]} ]..',
  "survey [ {id: 5} ]..",
  "survey [ {id: {a: 1}} ]..",
  'survey [ {id: "school-1" response: {choices: [0]}} ]..',
  'survey [ {id: "app-usability-1" response: {ratings: []}} ]..',
  'survey [ {id: "school-1" response: {}} ]..',
  'survey [ id "school-1" tag red ]..',
  'survey [ id "school-1" <x: x> ]..',
  'survey [ id "../spec/spec" ]..',
  'survey [ id "/etc/passwd" ]..',
  'survey [ id "-leading" ]..',
  'survey [ id "School-1" ]..',
  'survey [ id "civic" ]..',
  'survey [ id "civic-priorities-99" ]..',
  'survey [ id "civic-priorities-0" ]..',
  'survey [ id "civic-priorities-07" ]..',
  'survey [ id "civic-priorities-1-1" ]..',
  'survey [ id "" ]..',
  'survey [ id "  " ]..',
  'survey [ id "no-such-survey" ]..',
  'survey [ id "school-1" session-id "" ]..',
  'survey [ id "school-1" session-id "  s-3  " ]..',
  'survey [ id "civic-priorities" session-id "s" ] ..',
  'survey [ id "civic-priorities" ] survey [ id "civic-priorities" ]..',
  '[ survey [ id "civic-priorities" ] survey [ id "civic-priorities" ] survey [ id "workplace-pulse" ] ]..',
  '[ survey [ id "civic-priorities" session-id "a" ] survey [ id "civic-priorities" session-id "a" ] survey [ id "civic-priorities" session-id "b" ] ]..',
  '[ survey [ id "workplace-pulse" session-id "a" ] survey [ id "civic-priorities" session-id "a" ] survey [ id "civic-priorities" session-id "a" ] ]..',
  '[ survey [ id "workplace-pulse" ] survey [ id "workplace-pulse" ] survey [ id "workplace-pulse" ] survey [ id "workplace-pulse" ] survey [ id "workplace-pulse-2" ] ]..',
  '[ survey [ id 5 ] survey [ id "nope" ] survey [ id "school-1" response [] ] ]..',
  'survey [ id "school-1" response [ choices ["x"] ] ] survey [ id "nope" ]..',
  'survey [ id "school-1" session-id get-val-public "itemId" ]..',
  'set-var "x" "school-1" survey [ id get-var "x" ]..',
  'let x = "school-1"..',
  'survey [ id "school-1" response [ choices ["later start times for high school" 1 "o2"] ] ]..',
  'survey [ id "school-1" response [ choices [] ] ]..',
  'survey [ id "school-1" response [ choices [0 1 2 3] ] ]..',
  'survey [ id "school-1" response [ write-in "x" ] ]..',
  'survey [ id "school-1" response [ write-in "  Later START times for high school " ] ]..',
  'survey [ id "school-1" response [ choices [0] write-in "  padded  " ] ]..',
  'survey [ id "course-feedback-1" response [ ratings [ [item 0] ] ] ]..',
  'survey [ id "course-feedback-1" response [ ratings [ [rating 1] ] ] ]..',
  'survey [ id "course-feedback-1" response [ ratings [ [] ] ] ]..',
  'survey [ id "course-feedback-1" response [ ratings [ [item 0 rating 1 item 1] ] ] ]..',
  'survey [ id "course-feedback-1" response [ ratings [ [item 0 rating 1 choices [0]] ] ] ]..',
  'survey [ id "course-feedback-1" response [ ratings [ [5] ] ] ]..',
  'survey [ id "course-feedback-1" response [ ratings [ [{item: 0 rating: 1}] ] ] ]..',
  'survey [ id "course-feedback-1" response [ ratings [ item 0 rating 1 ] ] ]..',
  'survey [ id "course-feedback-1" response [ item 0 ] ]..',
  'survey [ id "course-feedback-1" response [ rating 0 id "x" ] ]..',
  'survey [ id "course-feedback-1" item 0 ]..',
  'survey [ id "course-feedback-1" choices [0] ratings [] ]..',
  'response [ choices [0] write-in "" comment "" ratings [[item 0]] ]..',
  'response [ comment "" write-in "" ]..',
  'response [ comment "c" write-in "w" choices ["a"] ratings [[rating 1 item 0]] ]..',
  'survey [ id "school-1" response [ comment "  " ratings [[item 0 rating 1]] ] ]..',
  'ratings [[item 0 rating 1] [rating "x" item "y"]]..',
  '[ id "a" choices [0] ]..',
  "id 1..",
  // A response written as a record literal skips `response`'s checks; a value of the wrong
  // kind then fails with JavaScript's own TypeError, which the Rust reproduces.
  'survey [ {id: "school-1" response: {choices: 5}} ]..',
  'survey [ {id: "school-1" response: {choices: null}} ]..',
  'survey [ {id: "app-usability-1" response: {ratings: 5}} ]..',
  'survey [ id "school-1" response [ {choices: [true]} ] ]..',
  'survey [ id "school-1" response [ {choices: [null]} ] ]..',
  'survey [ id "school-1" response [ {choices: [{}]} ] ]..',
  "response [ {ratings: 5} ]..",
  'response [ {ratings: "ab"} ]..',
  'survey [ {id: "school-1" response: {choices: [0] writeIn: 5}} ]..',
  'survey [ {id: "school-1" response: {choices: [0] writeIn: null}} ]..',
  'survey [ {id: "school-1" response: {choices: [0] writeIn: "  Padded "}} ]..',
  'survey [ {id: "app-usability-1" response: {ratings: [{item: null}]}} ]..',
  'survey [ {id: "app-usability-1" response: {ratings: [5]}} ]..',
  'survey [ {id: "app-usability-1" response: {ratings: [{item: 0 rating: true}]}} ]..',
  'survey [ {id: "app-usability-1" response: {comment: 5 ratings: null}} ]..',
  'survey [ {id: "workplace-pulse-1" response: {comment: 5 ratings: null}} ]..',
  'survey [ {id: "school-1" response: 0} ]..',
  'survey [ {id: "school-1" response: ""} ]..',
  'survey [ {id: "school-1" response: 5} ]..',
  // A number too precise for a float (see tests/conformance.rs)
  "survey [ 12345678901234567890 ]..",
  "ratings [ [ 12345678901234567890 ] ]..",
];

/* ------------------------------------------------------------------ write */

const programs = [
  ...recorded.map(({ src, values: vals, fixture }) => [
    src,
    fixture === null ? undefined : asFixture(fixture),
    vals,
  ]),
  ...spec.map((src) => [src, undefined, values]),
  ...generated.map(([src, fixture]) => [src, fixture, values]),
  ...handwritten.map((src) => [src, undefined, values]),
  // Without public values: get-val-public is left unresolved.
  [take("school-1", 'session-id get-val-public "itemId"'), undefined, undefined],
];

process.on("uncaughtException", () => {});

const log = console.log;
const seen = new Set();
const cases = [];
for (const [raw, fixture, vals] of programs) {
  const src = raw.trim().endsWith("..") ? raw : `${raw}..`;
  const key = JSON.stringify([src, fixture ?? null, vals ?? null]);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log = () => {};
  console.error = () => {};
  let result;
  try {
    result = await compileCase(src, fixture, vals);
  } catch {
    result = null;
  } finally {
    console.log = log;
  }
  if (result === null || result.expect === null) {
    console.warn(`skipped: ${src.slice(0, 100).replace(/\s+/g, " ")}`);
    continue;
  }
  const { ast, expect } = result;
  cases.push({ src, ast, ...(fixture !== undefined ? { fixture } : {}), expect });
}
writeFileSync(
  join(here, "cases.json"),
  "[\n" + cases.map((entry) => JSON.stringify(entry)).join(",\n") + "\n]\n",
);
console.log(
  `wrote ${cases.length} cases (${cases.filter((c) => c.expect.errors).length} with errors, ` +
    `${cases.filter((c) => c.fixture !== undefined).length} on fixture surveys)`,
);
process.exit(0);
