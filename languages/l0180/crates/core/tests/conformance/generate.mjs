// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0180 is tested against, from the TypeScript L0180 in
// this directory (packages/core):
//
//   cases.json                        programs parsed with L0180's lexicon and compiled by
//                                     @graffiticode/l0180, with the AST, any upstream data,
//                                     and the result
//   ../../src/lexicon-additions.json  the words L0180 adds to the base lexicon
//   ../../src/vocab.json              the attribute table, the activity words and the
//                                     container table, from packages/core/src/attributes.ts
//
// Part of the corpus is generated from the attribute table: every word of the language, with
// a value of its type and with wrong ones, placed in every container that takes it and in
// containers that do not. Then the spec's programs, the TypeScript suite's, and hand-written
// cases aimed at every error the compiler can report.
//
// Needs `npm ci && npm run -w packages/core build` here; `npm run rust:fixtures` does the
// build. `cargo test` reads the committed output.
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const load = (path) => import(pathToFileURL(join(root, path)).href);

const { parser } = await load("node_modules/@graffiticode/parser/src/index.js");
const { compiler, lexicon } = await load("packages/core/dist/index.js");
const { attributeFields, configFields, validAttributes } = await load(
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

// attributes.ts is the single source of truth for the vocabulary.
writeFileSync(
  join(root, "crates/core/src/vocab.json"),
  JSON.stringify({ attributeFields, configFields, validAttributes }, null, 2) + "\n",
);

const wordOf = (name) => name.toLowerCase().replace(/_/g, "-");

/* ------------------------------------------------------------------ Generated */

// A complete, scoreable program for each interaction, written as its attribute list so that
// a word can be added to it.
const INTERACTIONS = {
  choice: 'prompt "Pick one." options [ [ text "Red" ] [ text "Blue" assess [ correct ] ] ] {}',
  hottext:
    'prompt "Click the claim." text "Cats sleep. Dogs bark. Birds sing." selections [ [ quote "Dogs bark" assess [ correct ] ] ] {}',
  "text-entry":
    'text "The capital of France is {{c}}." blanks [ [ id "c" responses [ [ response "Paris" assess [ correct ] ] ] {} ] ] {}',
  "inline-choice":
    'text "Plants absorb {{gas}}." dropdowns [ [ id "gas" options [ [ text "oxygen" ] [ text "carbon dioxide" assess [ correct ] ] ] {} ] ] {}',
  order:
    'prompt "Order them." elements [ [ text "Second" assess [ position 2 ] ] [ text "First" assess [ position 1 ] ] ] {}',
  match:
    'targets [ [ id "p" text "Paris" ] [ id "r" text "Rome" ] ] {} match-items [ [ text "France" assess [ target "p" ] ] [ text "Italy" assess [ target "r" ] ] ] {}',
  classification:
    'categories [ [ id "m" text "Mammal" ] [ id "b" text "Bird" ] ] {} classification-items [ [ text "Whale" assess [ category "m" ] ] [ text "Owl" assess [ category "b" ] ] [ text "Bat" assess [ category "m" ] ] ] {}',
  "gap-match":
    'text "The {{a}} orbits the {{b}}." tokens [ [ id "moon" text "Moon" ] [ id "earth" text "Earth" ] [ id "sun" text "Sun" ] ] {} gaps [ [ id "a" assess [ token "moon" ] ] [ id "b" assess [ token "earth" ] ] ] {}',
  "extended-text":
    'prompt "Explain." rubric [ [ points 2 descriptor "Full." ] [ points 0 descriptor "None." ] ] {} exemplar "Because."',
};
// Member-level lists, as a function of the attribute list of ONE member, and the container
// program they sit in.
const MEMBERS = {
  option: (m) => `choice [ options [ [ ${m} ] [ text "Blue" assess [ correct ] ] ] {} ]`,
  selection: (m) =>
    `hottext [ text "Cats sleep. Dogs bark." selections [ [ ${m} ] [ quote "Cats sleep" assess [ correct ] ] ] {} ]`,
  blank: (m) =>
    `text-entry [ text "A {{c}} b {{d}}." blanks [ [ ${m} ] [ id "d" responses [ [ response "x" assess [ correct ] ] ] {} ] ] {} ]`,
  response: (m) =>
    `text-entry [ text "A {{c}}." blanks [ [ id "c" responses [ [ ${m} ] [ response "zz" assess [ correct ] ] ] {} ] ] {} ]`,
  dropdown: (m) =>
    `inline-choice [ text "A {{g}} b {{h}}." dropdowns [ [ ${m} ] [ id "h" options [ [ text "y" assess [ correct ] ] ] {} ] ] {} ]`,
  element: (m) => `order [ elements [ [ ${m} ] [ text "Two" assess [ position 2 ] ] ] {} ]`,
  target: (m) =>
    `match [ targets [ [ ${m} ] [ id "r" text "Rome" ] ] {} match-items [ [ text "Italy" assess [ target "r" ] ] ] {} ]`,
  category: (m) =>
    `classification [ categories [ [ ${m} ] [ id "b" text "Bird" ] ] {} classification-items [ [ text "Owl" assess [ category "b" ] ] ] {} ]`,
  "match-item": (m) =>
    `match [ targets [ [ id "p" text "Paris" ] [ id "r" text "Rome" ] ] {} match-items [ [ ${m} ] [ text "Italy" assess [ target "r" ] ] ] {} ]`,
  "classification-item": (m) =>
    `classification [ categories [ [ id "m" text "Mammal" ] [ id "b" text "Bird" ] ] {} classification-items [ [ ${m} ] [ text "Owl" assess [ category "b" ] ] ] {} ]`,
  token: (m) =>
    `gap-match [ text "The {{a}} shines." tokens [ [ ${m} ] [ id "sun" text "Sun" ] ] {} gaps [ [ id "a" assess [ token "sun" ] ] ] {} ]`,
  gap: (m) =>
    `gap-match [ text "The {{a}} and {{b}}." tokens [ [ id "moon" text "Moon" ] [ id "sun" text "Sun" ] ] {} gaps [ [ ${m} ] [ id "b" assess [ token "sun" ] ] ] {} ]`,
  band: (m) => `extended-text [ rubric [ [ ${m} ] [ points 0 descriptor "None." ] ] {} ]`,
  stimulus: (m) =>
    `item [ stimulus [ ${m} ] parts [ choice [ options [ [ text "a" assess [ correct ] ] ] {} ] ] {} ]`,
  item: (m) =>
    `item [ ${m} parts [ choice [ options [ [ text "a" assess [ correct ] ] ] {} ] ] {} ]`,
  // `assess` is checked under one name wherever it appears; each reader then refuses the
  // words it has no use for.
  "assess (option)": (m) =>
    `choice [ options [ [ text "a" assess [ ${m} ] ] [ text "b" assess [ correct ] ] ] {} ]`,
  "assess (selection)": (m) =>
    `hottext [ text "Cats sleep. Dogs bark." selections [ [ quote "Cats" assess [ ${m} ] ] [ quote "Dogs" assess [ correct ] ] ] {} ]`,
  "assess (response)": (m) =>
    `text-entry [ text "A {{c}}." blanks [ [ id "c" responses [ [ response "x" assess [ ${m} ] ] [ response "y" assess [ correct ] ] ] {} ] ] {} ]`,
  "assess (dropdown option)": (m) =>
    `inline-choice [ text "A {{g}}." dropdowns [ [ id "g" options [ [ text "x" assess [ ${m} ] ] [ text "y" assess [ correct ] ] ] {} ] ] {} ]`,
  "assess (element)": (m) =>
    `order [ elements [ [ text "One" assess [ ${m} ] ] [ text "Two" assess [ position 2 ] ] ] {} ]`,
  "assess (match-item)": (m) =>
    `match [ targets [ [ id "p" text "Paris" ] [ id "r" text "Rome" ] ] {} match-items [ [ text "France" assess [ ${m} ] ] [ text "Italy" assess [ target "r" ] ] ] {} ]`,
  "assess (classification-item)": (m) =>
    `classification [ categories [ [ id "m" text "Mammal" ] [ id "b" text "Bird" ] ] {} classification-items [ [ text "Whale" assess [ ${m} ] ] [ text "Owl" assess [ category "b" ] ] ] {} ]`,
  "assess (gap)": (m) =>
    `gap-match [ text "The {{a}} and {{b}}." tokens [ [ id "moon" text "Moon" ] [ id "sun" text "Sun" ] ] {} gaps [ [ id "a" assess [ ${m} ] ] [ id "b" assess [ token "sun" ] ] ] {} ]`,
};

const quote = (s) => JSON.stringify(s);
// Values for a word: those of its type (every value of a closed set), then wrong ones.
function samples(meta) {
  if (meta.flag) return [""];
  if (meta.shape === "object") return ["[ correct ]", '"x"', "[ 5 ]", "[]"];
  switch (meta.expects) {
    case "string":
      return meta.oneOf
        ? [...meta.oneOf.map(quote), '"nope"', "5"]
        : ['"p1"', '""', "7", "true", "[ 1 ]"];
    case "number":
      return ["2", "0", "-1", "1.5", '"2"', "[]"];
    case "boolean":
      return ["true", "false", '"yes"', "1"];
    case "strings":
      return meta.oneOf
        ? [
            `[ ${quote(meta.oneOf[0])} ]`,
            `[ ${meta.oneOf.slice(1).map(quote).join(" ")} ]`,
            '[ "nope" ]',
            '"decimal"',
            "[]",
            '[ "" ]',
            "[ 5 ]",
          ]
        : ['[ "One." "Two." ]', "[]", '"One."', '[ "a" 5 ]', '[ "  " ]', "{}"];
    default:
      return ['"x"'];
  }
}
// A word applied to a value, as source.
const apply = (word, meta, value) => (meta.flag ? word : `${word} ${value}`);

const generated = [];
const words = Object.entries(attributeFields).map(([name, meta]) => [wordOf(name), meta]);
const primary = (meta) => samples(meta).slice(0, 1);
// Every word in every interaction and member list, with the first value of its type; in the
// containers that take it, with every value.
for (const [container, attrs] of Object.entries(INTERACTIONS)) {
  generated.push(`${container} [ ${attrs} ]..`);
  for (const [word, meta] of words) {
    const allowed = (validAttributes[container] || []).includes(word);
    for (const value of allowed ? samples(meta) : primary(meta)) {
      if (attrs.includes(`${word} `) && allowed) {
        generated.push(
          `${container} [ ${attrs.replace(new RegExp(`(^| )${word} ("[^"]*"|\\S+)`), `$1${apply(word, meta, value)}`)} ]..`,
        );
      } else generated.push(`${container} [ ${apply(word, meta, value)} ${attrs} ]..`);
    }
  }
}
const MEMBER_BASES = {
  option: 'text "Red"',
  selection: 'quote "Dogs bark" assess [ points 1 ]',
  blank: 'id "c" responses [ [ response "9" assess [ correct ] ] ] {}',
  response: 'response "Paris" assess [ correct ]',
  dropdown: 'id "g" options [ [ text "x" assess [ correct ] ] ] {}',
  element: 'text "One" assess [ position 1 ]',
  target: 'id "p" text "Paris"',
  category: 'id "m" text "Mammal"',
  "match-item": 'text "France" assess [ target "p" ]',
  "classification-item": 'text "Whale" assess [ category "m" ]',
  token: 'id "moon" text "Moon"',
  gap: 'id "a" assess [ token "moon" ]',
  band: 'points 2 descriptor "Full."',
  stimulus: 'title "T" paragraphs [ "One." ]',
  item: 'scoring "conjunctive"',
};
for (const [member, wrap] of Object.entries(MEMBERS)) {
  const container = member.startsWith("assess") ? "assess" : member;
  const baseAttrs = MEMBER_BASES[member] ?? "";
  generated.push(wrap(baseAttrs));
  for (const [word, meta] of words) {
    const allowed = (validAttributes[container] || []).includes(word);
    for (const value of allowed ? samples(meta) : primary(meta)) {
      generated.push(wrap(`${apply(word, meta, value)} ${baseAttrs}`.trim()));
    }
  }
}
// The numeric blank's words in combination, from the table's closed sets.
const NUMERIC = [];
for (const baseType of ["string", "float", "integer"]) {
  for (const answer of [
    "8",
    "-3",
    "0.5",
    ".5",
    "1/2",
    "1,000",
    "1/3",
    "2/3",
    "5e-1",
    "1.5",
    "4/2",
    "100/300",
    "1/8",
    "x",
    "1,2",
    "0/0",
    "1/0",
    "3.",
    "+4",
    "1e3",
  ]) {
    for (const extra of [
      "",
      "tolerance 0.01",
      'input-formats [ "fraction" ]',
      'input-formats [ "decimal" "fraction" ]',
      'input-formats [ "numeric" ]',
      'input-formats [ "numeric" "decimal" ]',
      "case-sensitive true",
      "tolerance -1",
    ]) {
      NUMERIC.push(
        `text-entry [ text "x = {{v}}" blanks [ [ id "v" base-type "${baseType}" ${extra} responses [ [ response "${answer}" assess [ correct ] ] ] {} ] ] {} ]..`,
      );
    }
  }
}
// Two answers in one blank that may collide.
for (const [a, b] of [
  ["0.5", "1/2"],
  ["0.5", "0.51"],
  ["1/3", "0.3333"],
  ["10", "1e1"],
  ["2", "3"],
  ["1,000", "1000"],
  ["0.1", "0.3"],
]) {
  for (const tol of ["", "tolerance 0.01", "tolerance 0.005", "tolerance 0.1", "tolerance 1e-7"]) {
    NUMERIC.push(
      `text-entry [ text "x = {{v}}" blanks [ [ id "v" base-type "float" ${tol} responses [ [ response "${a}" assess [ correct ] ] [ response "${b}" assess [ points 0.5 ] ] ] {} ] ] {} ]..`,
    );
  }
}
// Option lists whose order may or may not be information.
const ORDERS = [
  ["2", "4", "5", "9", "11"],
  ["11", "9", "5", "4", "2"],
  ["9", "2", "11"],
  ["True", "False"],
  ["False", "True"],
  ["yes", "no"],
  ["Yes.", "No."],
  ["1", "2", "None of the above"],
  ["All of the above.", "1", "2"],
  ["1/2", "0.75", "1"],
  ["1,000", "2,000", "1e4"],
  ["one", "two"],
  ["1", "1"],
  ["Paris"],
  ["None of these apply", "Both of these", "all of the answers above"],
  ["-1", "-0.5", "0", ".5"],
  ["0.1", "0.10"],
  ["3/9", "1/3"],
];
for (const texts of ORDERS) {
  const opts = texts
    .map((t, i) => `[ text ${quote(t)}${i === 0 ? " assess [ correct ]" : ""} ]`)
    .join(" ");
  for (const shuffle of ["", "shuffle true", "shuffle false"]) {
    generated.push(`choice [ ${shuffle} options [ ${opts} ] {} ]..`);
    generated.push(
      `inline-choice [ ${shuffle} text "x {{a}}" dropdowns [ [ id "a" options [ ${opts} ] {} ] ] {} ]..`,
    );
    const places = texts.map((t, i) => `[ id "t${i}" text ${quote(t)} ]`).join(" ");
    generated.push(
      `match [ ${shuffle} targets [ ${places} [ id "z" text "Z" ] ] {} match-items [ ${texts.map((t, i) => `[ text ${quote(t)} assess [ target "t${i}" ] ]`).join(" ")} ] {} ]..`,
    );
  }
}

/* ------------------------------------------------------------- Spec and tests */

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
  .filter((src) => src && !src.includes("…") && !src.includes("..."))
  .map((src) => (src.endsWith("..") ? src : `${src}..`));

// The string literals passed to compile(...) / errorOf(...) in the TypeScript suite, and its
// named programs.
function testPrograms(path) {
  const source = readFileSync(join(root, path), "utf8");
  const found = [];
  for (const match of source.matchAll(/(?:compile|errorOf)\(\s*(['"`])/g)) {
    const q = match[1];
    let at = match.index + match[0].length;
    let text = q;
    while (at < source.length && source[at] !== q) {
      if (source[at] === "\\") text += source[at++];
      text += source[at++];
    }
    text += q;
    if (q === "`" && text.includes("${")) continue;
    found.push(new Function(`return ${text}`)());
  }
  for (const match of source.matchAll(/const [A-Za-z_]+ = `([\s\S]*?)`;/g)) {
    if (!match[1].includes("${")) found.push(match[1]);
  }
  return found
    .map((src) => src.trim())
    .filter(Boolean)
    .map((src) => (src.endsWith("..") ? src : `${src}..`));
}
const suites = readdirSync(join(root, "packages/core/src"))
  .filter((file) => file.endsWith(".test.ts") && file !== "docs.test.ts")
  .sort()
  .flatMap((file) => testPrograms(`packages/core/src/${file}`));

/* ---------------------------------------------------------------- Hand-written */

const Q = (p) =>
  `choice [ prompt ${quote(p)} options [ [ text "A" assess [ correct ] ] [ text "B" ] ] {} ]`;
const handwritten = [
  readFileSync(join(root, "packages/core/spec/template.gc"), "utf8"),
  "42..",
  '"hello"..',
  "[]..",
  "{}..",
  "{a: 1 b: [2 3]}..",
  "nope..",
  'get-var "nope"..',
  // Programs of several questions without `items`.
  `${Q("One?")} ${Q("Two?")}..`,
  `[ ${Q("One?")} ${Q("Two?")} ]..`,
  `[ ${Q("One?")} 5 ]..`,
  `5 ${Q("One?")}..`,
  `${Q("One?")} 5..`,
  `items [ ${Q("One?")} ] {} ${Q("Two?")}..`,
  `[ items [ ${Q("One?")} ] {} ]..`,
  // The activity.
  `items [ ${Q("One?")} ${Q("Two?")} ${Q("Three?")} ] {}..`,
  `items [ ${Q("One?")} ] navigation "linear" {}..`,
  `items [ ${Q("One?")} ] submission "individual" navigation "linear" {}..`,
  `items [ ${Q("One?")} ] navigation "backwards" {}..`,
  `items [ ${Q("One?")} ] submission "later" {}..`,
  `items [ ${Q("One?")} ] navigation "linear" navigation "nonlinear" {}..`,
  `items [ ${Q("One?")} ] navigation "linear" "oops"..`,
  `items [ ${Q("One?")} ] navigation 5 {}..`,
  `items [ ${Q("One?")} ] navigation "linear" {navigation: "x"}..`,
  `items [ ${Q("One?")} ] {navigation: "zigzag" extra: 1}..`,
  `items [ ${Q("One?")} ] {submission: "individual"}..`,
  `items [ ${Q("One?")} ] 5..`,
  `items [ ${Q("One?")} ] "x"..`,
  `items [ ${Q("One?")} ] [1]..`,
  "items [] {}..",
  'items [ "hello" ] {}..',
  "items [ 5 ] {}..",
  "items [ [1] ] {}..",
  "items 5 {}..",
  'items "x" {}..',
  `items [ {interaction: {type: "x"} id: 9} ] {}..`,
  `items [ item [ parts [ ${Q("A?")} ${Q("B?")} ] {} ] ${Q("C?")} ] {}..`,
  'items [ hottext [ prompt "Click one." within "stimulus" selections [ [quote "a"] ] {} ] ] {}..',
  `items [ choice [ options [] {} ] ] {}..`,
  `navigation "linear" {}..`,
  `navigation "linear" 5..`,
  `items [ ${Q("One?")} ] navigation "linear" {} {}..`,
  // A part that is not an interaction.
  "item [ parts [ 5 ] {} ]..",
  "item [ parts [] {} ]..",
  'item [ parts "x" {} ]..',
  "item [ parts [ {interaction: 1} ] {} ]..",
  `item [ parts [ {interaction: {type: "x"} validation: {points: "3"}} ] {} scoring "conjunctive" ]..`,
  `item [ parts [ {interaction: {type: "x"}} ] {} ]..`,
  `item [ parts [ ${Q("A?")} ] {a: 1} ]..`,
  `item [ parts [ ${Q("A?")} ] {parts: 1} ]..`,
  `item [ stimulus [ paragraphs [ "One." ] ] ]..`,
  `item [ scoring "conjunctive" points 3 parts [ ${Q("A?")} ${Q("B?")} ] {} ]..`,
  `item [ points 3 parts [ ${Q("A?")} ] {} ]..`,
  `item [ scoring "conjunctive" parts [ ${Q("A?")} choice [ options [ [ text "x" ] ] {} ] ] {} ]..`,
  `item [ scoring "conjunctive" parts [ ${Q("A?")} extended-text [ rubric [ [ points 1 descriptor "a" ] [ points 0 descriptor "b" ] ] {} ] ] {} ]..`,
  `item [ parts [ ${Q("A?")} extended-text [ rubric [ [ points 1 descriptor "a" ] [ points 0 descriptor "b" ] ] {} ] ] {} ]..`,
  `item [ stimulus [ title "T" paragraphs [ "Mr. Ruiz smiled. He left." "Then it rained" ] ] parts [ hottext [ within "stimulus" selections [ [ quote "He left" assess [ correct ] ] ] {} ] ${Q("A?")} ] {} ]..`,
  `item [ stimulus [ paragraphs [ "Mr. Ruiz smiled. He left." ] ] parts [ hottext [ within "stimulus" granularity "word" selections [ [ quote "smiled" assess [ correct ] ] ] {} ] ] {} ]..`,
  `item [ stimulus [ paragraphs [ "A b. C d." ] ] parts [ hottext [ within "stimulus" selections [ [ quote "A b" assess [ correct ] ] ] {} ] hottext [ within "stimulus" selections [ [ quote "C d" assess [ correct ] ] ] {} ] ] {} ]..`,
  `item [ parts [ hottext [ within "stimulus" selections [ [ quote "A b" assess [ correct ] ] ] {} ] ] {} ]..`,
  `item [ stimulus [ title "Only a title" ] parts [ hottext [ within "stimulus" selections [ [ quote "A" assess [ correct ] ] ] {} ] ] {} ]..`,
  'hottext [ within "stimulus" selections [ [ quote "a" ] ] {} ]..',
  `[ hottext [ within "stimulus" selections [ [ quote "a" ] ] {} ] ]..`,
  // Hottext segmentation and matching.
  'hottext [ text "\\"Stop!\\" she called. Mr. Ruiz ran. It was 5 p.m. J. Smith came. etc. and then she left" selections [ [ quote "she called" assess [ correct ] ] ] {} ]..',
  'hottext [ text "One. Two. Three" selections [ [ quote "Three" assess [ correct ] ] ] {} ]..',
  'hottext [ text "One. Two." selections [ [ quote "Thre" assess [ correct ] ] ] {} ]..',
  'hottext [ text "The cat sat on the mat while the dog slept beside it in the warm afternoon sun. A bird sang." selections [ [ quote "the cat sat on a mat while the dog slept beside it in the warm afternoon sunshine today" assess [ correct ] ] ] {} ]..',
  'hottext [ text "Go now. Go now." selections [ [ quote "Go now" assess [ correct ] ] ] {} ]..',
  'hottext [ text "One. Two." selections [ [ quote "One" assess [ correct ] ] [ quote "One." ] ] {} ]..',
  'hottext [ text "One. Two." selections [ [ quote "   " ] ] {} ]..',
  'hottext [ text "One. Two." selections [ [ quote "?!" assess [ correct ] ] ] {} ]..',
  'hottext [ text "" selections [ [ quote "a" ] ] {} ]..',
  'hottext [ text "   " selections [ [ quote "a" ] ] {} ]..',
  'hottext [ text "a" within "stimulus" selections [ [ quote "a" ] ] {} ]..',
  'hottext [ selections [ [ quote "a" ] ] {} ]..',
  'hottext [ text "a" ]..',
  'hottext [ text "a" selections [] {} ]..',
  'hottext [ text "One. Two." selections [ [ quote "One" ] ] {} ]..',
  'hottext [ text "One. Two." selections [ [ quote "One" assess [ points 2 ] ] ] {} ]..',
  'hottext [ text "One. Two." selections [ [ quote "One" assess [ rationale "r" ] ] [ quote "Two" assess [ correct rationale "s" ] ] ] {} ]..',
  'hottext [ text "One. Two. Three." upper-bound 1 selections [ [ quote "One" assess [ correct ] ] [ quote "Two" assess [ correct ] ] ] {} ]..',
  'hottext [ text "One. Two. Three." upper-bound 3 selections [ [ quote "One" assess [ correct ] ] [ quote "Two" assess [ correct ] ] ] {} ]..',
  'hottext [ text "One. Two. Three." max-choices 1 selections [ [ quote "One" assess [ correct ] ] [ quote "Two" assess [ correct ] ] ] {} ]..',
  'hottext [ text "One. Two. Three." min-choices 3 max-choices 2 selections [ [ quote "One" assess [ correct ] ] [ quote "Two" assess [ correct ] ] ] {} ]..',
  'hottext [ text "One. Two. Three." response-processing "match-correct" selections [ [ quote "One" assess [ correct ] ] [ quote "Two" assess [ correct ] ] ] {} ]..',
  'hottext [ text "One. Two. Three." response-processing "match-correct" selections [ [ quote "One" ] ] {} ]..',
  'hottext [ text "One. Two. Three." response-processing "match-correct" upper-bound 1 selections [ [ quote "One" assess [ correct ] ] [ quote "Two" assess [ correct ] ] ] {} ]..',
  'hottext [ text "Hello, world! (Quietly) — done." granularity "word" selections [ [ quote "world" assess [ correct ] ] [ quote "Quietly" ] ] {} ]..',
  'hottext [ text "a -- b" granularity "word" selections [ [ quote "b" assess [ correct ] ] ] {} ]..',
  'hottext [ text "Café naïve" granularity "word" selections [ [ quote "naïve" assess [ correct ] ] ] {} ]..',
  // Choice edge cases.
  "choice [ options [] {} ]..",
  "choice []..",
  'choice [ options "x" {} ]..',
  "choice [ options [ 5 ] {} ]..",
  "choice [ options [ [ 5 ] ] {} ]..",
  'choice [ options [ [ text "a" text "b" ] ] {} ]..',
  'choice [ options [ [ text "a" ] ] {a: 1} ]..',
  'choice [ options [ [ text "a" ] ] {options: 1 x: 2} ]..',
  'choice [ options [ [ text "a" ] ] 5 ]..',
  'choice [ options [ [ text "a" ] ] "xy" ]..',
  'choice [ options [ {text: "a" assess: {correct: true points: 3}} {text: "b" id: 5} ] {} ]..',
  'choice [ options [ {text: "a" assess: "ab"} ] {} ]..',
  'choice [ options [ {text: "a" assess: 5} ] {} ]..',
  'choice [ options [ {text: "a" assess: true} ] {} ]..',
  'choice [ options [ {text: 5 assess: {correct: true}} {text: "6"} ] {} ]..',
  'choice [ options [ [ id "x" text "a" ] [ id "x" text "b" ] ] {} ]..',
  'choice [ options [ [ id "2" text "a" assess [ correct rationale "r" ] ] [ id "1" text "b" assess [ points -1 rationale "s" ] ] ] {} ]..',
  'choice [ options [ [ text "a" assess [] ] ] {} ]..',
  'choice [ options [ [ text "a" assess [ rationale "r" ] ] ] {} ]..',
  'choice [ response-processing "match-correct" options [ [ text "a" assess [ correct points 2 ] ] ] {} ]..',
  'choice [ response-processing "match-correct" options [ [ text "a" ] ] {} ]..',
  'choice [ response-processing "match-correct" upper-bound 1 options [ [ text "a" assess [ correct ] ] ] {} ]..',
  'choice [ response-processing "match-correct" max-choices 2 options [ [ text "a" assess [ correct ] ] [ text "b" assess [ correct rationale "r" ] ] [ text "c" ] ] {} ]..',
  'choice [ upper-bound 1 options [ [ text "a" assess [ correct ] ] [ text "b" assess [ correct ] ] [ text "c" ] ] {} ]..',
  'choice [ upper-bound 3 options [ [ text "a" assess [ correct ] ] [ text "b" assess [ correct ] ] ] {} ]..',
  'choice [ max-choices 3 min-choices 4 options [ [ text "a" assess [ correct ] ] ] {} ]..',
  'choice [ max-choices 2 options [ [ text "a" assess [ correct points 0.1 ] ] [ text "b" assess [ correct points 0.2 ] ] ] {} ]..',
  'choice [ options [ [ text "a" assess [ correct correct ] ] ] {} ]..',
  'choice [ options [ [ text "a" assess [ position 2 ] ] ] {} ]..',
  'choice [ options [ [ text "a" assess [ target "x" points 1 ] ] ] {} ]..',
  'choice [ options [ [ text "All of the above." ] [ text "None of these" ] [ text "x" assess [ correct ] ] ] {} ]..',
  `choice [ options [ ${Array.from({ length: 30 }, (_, i) => `[ text "o${i}"${i === 28 ? " assess [ correct ]" : ""} ]`).join(" ")} ] {} ]..`,
  'choice [ options [ [ text "a" assess [ correct ] ] [ id "B" text "b" ] [ text "c" ] ] {} ]..',
  // Text entry.
  'text-entry [ text "{{a}} and {{ b }} and {{}}" blanks [ [ id "a" responses [ [ response "x" assess [ correct ] ] ] {} ] [ id "b" responses [ [ response "y" assess [ correct ] ] ] {} ] ] {} ]..',
  'text-entry [ text "ab {{  }} cd" blanks [ [ id "a" responses [ [ response "x" assess [ correct ] ] ] {} ] ] {} ]..',
  'text-entry [ text "é𝒳 {{z}}" blanks [ [ id "a" responses [ [ response "x" assess [ correct ] ] ] {} ] ] {} ]..',
  'text-entry [ text "é𝒳 {{}}" blanks [ [ id "a" responses [ [ response "x" assess [ correct ] ] ] {} ] ] {} ]..',
  'text-entry [ text "{{a}} {{a}}" blanks [ [ id "a" responses [ [ response "x" assess [ correct ] ] ] {} ] ] {} ]..',
  'text-entry [ text "no markers" blanks [ [ id "a" responses [ [ response "x" assess [ correct ] ] ] {} ] ] {} ]..',
  'text-entry [ text "{{a}}" blanks [ [ id "a" responses [ [ response "x" assess [ correct ] ] ] {} ] [ id "b" responses [ [ response "y" assess [ correct ] ] ] {} ] ] {} ]..',
  'text-entry [ text "{{2}} then {{1}}" blanks [ [ id "2" responses [ [ response "x" assess [ correct points 0.1 ] ] ] {} ] [ id "1" responses [ [ response "y" assess [ correct points 0.2 ] ] ] {} ] [ id "0" responses [ [ response "z" assess [ correct points 0.3 ] ] ] {} ] ] {} ]..',
  'text-entry [ text "{{a}}" blanks [ [ id "a" responses [ [ response "Paris" assess [ correct ] ] [ response " paris " assess [ points 1 ] ] ] {} ] ] {} ]..',
  'text-entry [ case-sensitive true text "{{a}}" blanks [ [ id "a" responses [ [ response "Paris" assess [ correct ] ] [ response "paris" assess [ points 1 ] ] ] {} ] ] {} ]..',
  'text-entry [ case-sensitive true text "{{a}}" blanks [ [ id "a" case-sensitive false responses [ [ response "Paris" assess [ correct ] ] [ response "PARIS" assess [ points 1 ] ] ] {} ] ] {} ]..',
  'text-entry [ text "{{a}}" blanks [ [ id "a" responses [ [ response "x" ] ] {} ] ] {} ]..',
  'text-entry [ text "{{a}}" blanks [ [ id "a" responses [ [ response "x" assess [ rationale "no" ] ] ] {} ] ] {} ]..',
  'text-entry [ text "{{a}}" blanks [ [ id "a" responses [ [ response "x" assess [ correct points 3 ] ] [ response "y" assess [ correct points 5 ] ] [ response "z" assess [ points 1 rationale "near" ] ] ] {} ] ] {} ]..',
  'text-entry [ text "{{a}}" blanks [ [ id "a" responses [ [ response "  " assess [ correct ] ] ] {} ] ] {} ]..',
  'text-entry [ text "{{a}}" blanks [ [ id "a" responses [] {} ] ] {} ]..',
  'text-entry [ text "{{a}}" blanks [ [ id "  " responses [ [ response "x" assess [ correct ] ] ] {} ] ] {} ]..',
  'text-entry [ text "{{a}}" blanks [ [ id "a" responses [ [ response "x" assess [ correct ] ] ] {} ] [ id "a" responses [ [ response "x" assess [ correct ] ] ] {} ] ] {} ]..',
  'text-entry [ text "  " blanks [] {} ]..',
  'text-entry [ text "{{a}}" blanks [] {} ]..',
  'text-entry [ text "{{a}}" ]..',
  'text-entry [ prompt "P" text "{{a}} " blanks [ [ id "a" base-type "integer" tolerance 1 responses [ [ response "3" assess [ correct ] ] [ response "6" assess [ correct ] ] ] {} ] ] {} ]..',
  'text-entry [ text "{{a}}" blanks [ [ id "a" responses [ [ response "x" assess [ correct ] ] ] {} ] ] {} ]..',
  // Inline choice.
  'inline-choice [ text "{{a}} {{b}}" dropdowns [ [ id "a" options [ [ text "1" assess [ correct ] ] [ text "2" ] ] {} ] [ id "b" options [ [ text "x" assess [ correct points 2 ] ] [ text "y" assess [ rationale "no" ] ] [ text "z" assess [ points -1 ] ] ] {} ] ] {} ]..',
  'inline-choice [ text "{{a}}" dropdowns [ [ id "a" options [ [ text "1" assess [ correct ] ] [ id "A" text "2" ] ] {} ] ] {} ]..',
  'inline-choice [ text "{{a}}" dropdowns [ [ id "a" options [ [ text "  " assess [ correct ] ] ] {} ] ] {} ]..',
  'inline-choice [ text "{{a}}" dropdowns [ [ id "a" options [ [ text "x" ] ] {} ] ] {} ]..',
  'inline-choice [ text "{{a}}" dropdowns [ [ id "a" options [ [ text "x" assess [] ] ] {} ] ] {} ]..',
  'inline-choice [ text "{{a}}" dropdowns [ [ id "a" options [] {} ] ] {} ]..',
  'inline-choice [ text "{{a}}" dropdowns [ [ options [ [ text "x" assess [ correct ] ] ] {} ] ] {} ]..',
  'inline-choice [ text "{{a}}" dropdowns [ [ id "a" options [ [ text "x" assess [ correct ] ] ] {} ] [ id "a" options [ [ text "x" assess [ correct ] ] ] {} ] ] {} ]..',
  'inline-choice [ text "{{a}} {{b}}" dropdowns [ [ id "a" options [ [ text "x" assess [ correct ] ] ] {} ] ] {} ]..',
  'inline-choice [ text "plain" dropdowns [ [ id "a" options [ [ text "x" assess [ correct ] ] ] {} ] ] {} ]..',
  'inline-choice [ text "{{a}}" dropdowns [] {} ]..',
  "inline-choice [ dropdowns [] {} ]..",
  'inline-choice [ text "{{a}} {{b}}" dropdowns [ [ id "a" options [ [ text "1" assess [ correct ] ] [ text "2" ] ] {} ] [ id "b" options [ [ text "x" assess [ correct ] ] [ text "y" ] ] {} ] ] {} ]..',
  'inline-choice [ text "{{a}} {{b}}" dropdowns [ [ id "a" options [ [ text "1" assess [ correct ] ] [ text "2" ] ] {} ] [ id "b" options [ [ text "2" assess [ correct ] ] [ text "1" ] ] {} ] ] {} ]..',
  'inline-choice [ text "{{a}}" dropdowns [ [ id "a" options [ [ text "x" assess [ correct ] ] [ text "None of the above" ] ] {} ] ] {} ]..',
  // Order.
  'order [ elements [ [ text "the" assess [ position 1 ] ] [ text "cat" assess [ position 2 ] ] [ text " the " assess [ position 3 ] ] [ text "mat" assess [ position 4 ] ] [ text "The" assess [ position 5 ] ] ] {} ]..',
  'order [ elements [ [ text "a" assess [ position 1 ] ] ] {} ]..',
  'order [ elements [ [ text "a" assess [ position 1 ] ] [ text "b" assess [ position 1 ] ] ] {} ]..',
  'order [ elements [ [ text "a" assess [ position 1.5 ] ] [ text "b" assess [ position 2 ] ] ] {} ]..',
  'order [ elements [ [ text "a" assess [ position 0 ] ] [ text "b" assess [ position 3 ] ] ] {} ]..',
  'order [ elements [ [ text "a" ] [ text "b" assess [ position 2 ] ] ] {} ]..',
  'order [ elements [ [ text "a" assess [ correct ] ] [ text "b" assess [ position 2 ] ] ] {} ]..',
  'order [ elements [ [ text " " assess [ position 1 ] ] [ text "b" assess [ position 2 ] ] ] {} ]..',
  'order [ elements [ [ id "x" text "a" assess [ position 1 ] ] [ id "x" text "b" assess [ position 2 ] ] ] {} ]..',
  'order [ elements [ [ id "2" text "a" assess [ position 2 ] ] [ id "1" text "b" assess [ position 1 ] ] ] {} ]..',
  "order [ elements [] {} ]..",
  "order []..",
  'order [ shuffle false elements [ [ text "b" assess [ position 2 ] ] [ text "a" assess [ position 1 ] ] [ text "c" assess [ position 3 ] ] ] {} ]..',
  // Pairing.
  'match [ targets [ [ id "p" text "Paris" ] ] {} match-items [ [ text "France" assess [ target "p" ] ] ] {} ]..',
  'match [ targets [ [ id "p" text "Paris" ] [ id "r" text "Rome" ] ] {} match-items [ [ text "France" assess [ target "p" ] ] [ text "Gaul" assess [ target "p" ] ] ] {} ]..',
  'match [ targets [ [ id "p" text "Paris" ] [ id "r" text "Rome" ] ] {} match-items [ [ text "France" assess [ target "x" ] ] ] {} ]..',
  'match [ targets [ [ id "p" text "Paris" ] [ id "r" text "Rome" ] ] {} match-items [ [ text "France" ] ] {} ]..',
  'match [ targets [ [ id "p" text "Paris" ] [ id "r" text "Rome" ] ] {} match-items [ [ text "France" assess [ category "p" ] ] ] {} ]..',
  'match [ targets [ [ id "p" text "Paris" ] [ id "p" text "Rome" ] ] {} match-items [ [ text "France" assess [ target "p" ] ] ] {} ]..',
  'match [ targets [ [ text "Paris" ] [ id "r" text "Rome" ] ] {} match-items [ [ text "France" assess [ target "r" ] ] ] {} ]..',
  'match [ targets [ [ id "p" ] [ id "r" text "Rome" ] ] {} match-items [ [ text "France" assess [ target "r" ] ] ] {} ]..',
  'match [ targets [ [ id "p" text "Paris" ] [ id "r" text "Rome" ] ] {} match-items [ [ id "x" text "France" assess [ target "p" ] ] [ id "x" text "Italy" assess [ target "r" ] ] ] {} ]..',
  'match [ targets [ [ id "p" text "Paris" ] [ id "r" text "Rome" ] ] {} match-items [ [ assess [ target "p" ] ] ] {} ]..',
  'match [ targets [ [ id "p" text "Paris" ] [ id "r" text "Rome" ] ] {} match-items [ [ text "France" assess [ target "p" points 2 rationale "r" ] ] [ text "Italy" assess [ target "r" points 0.5 ] ] ] {} ]..',
  'match [ response-processing "match-correct" targets [ [ id "p" text "Paris" ] [ id "r" text "Rome" ] ] {} match-items [ [ text "France" assess [ target "p" ] ] ] {} ]..',
  'match [ targets [] {} match-items [ [ text "France" assess [ target "p" ] ] ] {} ]..',
  'match [ targets [ [ id "p" text "Paris" ] [ id "r" text "Rome" ] ] {} match-items [] {} ]..',
  "match []..",
  'match [ targets "x" {} ]..',
  'classification [ categories [ [ id "m" text "Mammal" ] [ id "b" text "Bird" ] ] {} classification-items [ [ text "Whale" assess [ category "x" ] ] ] {} ]..',
  'classification [ categories [ [ id "m" text "Mammal" ] ] {} classification-items [ [ text "Whale" assess [ category "m" ] ] ] {} ]..',
  'classification [ categories [ [ id "m" text "Mammal" ] [ id "b" text "Bird" ] ] {} classification-items [ [ text "Whale" ] ] {} ]..',
  'classification [ categories [ [ id "m" text "Mammal" ] [ id "b" text "Bird" ] ] {} classification-items [ [ text "Whale" assess [ target "m" ] ] ] {} ]..',
  "classification []..",
  // Gap match.
  'gap-match [ text "The {{a}} and {{b}}." tokens [ [ id "moon" text "Moon" ] [ id "sun" text "Sun" ] ] {} gaps [ [ id "a" assess [ token "moon" ] ] [ id "b" assess [ token "moon" ] ] ] {} ]..',
  'gap-match [ text "The {{a}}." tokens [ [ id "moon" text "Moon" ] [ id "sun" text "Sun" ] ] {} gaps [ [ id "a" assess [ token "x" ] ] ] {} ]..',
  'gap-match [ text "The {{a}}." tokens [ [ id "moon" text "Moon" ] [ id "sun" text "Sun" ] ] {} gaps [ [ id "a" ] ] {} ]..',
  'gap-match [ text "The {{a}}." tokens [ [ id "moon" text "Moon" ] [ id "sun" text "Sun" ] ] {} gaps [ [ assess [ token "moon" ] ] ] {} ]..',
  'gap-match [ text "The {{a}}." tokens [ [ id "moon" text "Moon" ] [ id "sun" text "Sun" ] ] {} gaps [ [ id "a" assess [ token "moon" ] ] [ id "a" assess [ token "sun" ] ] ] {} ]..',
  'gap-match [ text "The {{a}}." tokens [ [ id "moon" text "Moon" ] [ id "sun" text "Sun" ] ] {} gaps [ [ id "a" assess [ token "moon" points 3 rationale "r" ] ] ] {} ]..',
  'gap-match [ text "The {{a}}." tokens [ [ id "moon" text "Moon" ] [ id "sun" text "Sun" ] ] {} gaps [ [ id "a" assess [ token "moon" position 1 ] ] ] {} ]..',
  'gap-match [ text "The {{b}}." tokens [ [ id "moon" text "Moon" ] [ id "sun" text "Sun" ] ] {} gaps [ [ id "a" assess [ token "moon" ] ] ] {} ]..',
  'gap-match [ text "No gaps." tokens [ [ id "moon" text "Moon" ] [ id "sun" text "Sun" ] ] {} gaps [ [ id "a" assess [ token "moon" ] ] ] {} ]..',
  'gap-match [ text "The {{a}}." tokens [ [ id "moon" text "Moon" ] ] {} gaps [ [ id "a" assess [ token "moon" ] ] ] {} ]..',
  'gap-match [ response-processing "match-correct" text "The {{a}}." tokens [ [ id "moon" text "Moon" ] [ id "sun" text "Sun" ] ] {} gaps [ [ id "a" assess [ token "moon" ] ] ] {} ]..',
  'gap-match [ text "The {{a}}." tokens [] {} gaps [] {} ]..',
  'gap-match [ text "The {{a}}." tokens [ [ id "moon" text "Moon" ] ] {} gaps [] {} ]..',
  'gap-match [ text "" ]..',
  // Extended text.
  'extended-text [ rubric [ [ points 2 descriptor "a" ] ] {} ]..',
  'extended-text [ rubric [ [ points 2 descriptor "a" ] [ descriptor "b" ] ] {} ]..',
  'extended-text [ rubric [ [ points 2 descriptor "a" ] [ points 1 ] ] {} ]..',
  'extended-text [ rubric [ [ points 2 descriptor "a" ] [ points 1 descriptor "  " ] ] {} ]..',
  'extended-text [ rubric [ [ points 2 descriptor "a" ] [ points 2 descriptor "b" ] ] {} ]..',
  'extended-text [ rubric [ [ points 0 descriptor "a" ] [ points -1 descriptor "b" ] ] {} ]..',
  'extended-text [ rubric [ [ points 1 descriptor "a" ] [ points 3 descriptor "b" ] [ points 2.5 descriptor "c" ] ] {} exemplar "x" ]..',
  "extended-text []..",
  'extended-text [ rubric "x" {} ]..',
  // Values that do not fit where they are written.
  'choice [ prompt "a" prompt "b" options [ [ text "x" ] ] {} ]..',
  'choice [ options [ [ text "x" ] ] {} options [ [ text "y" ] ] {} ]..',
  'choice [ navigation "linear" {} options [ [ text "x" ] ] {} ]..',
  'choice [ items [] {} options [ [ text "x" ] ] {} ]..',
  'choice [ correct options [ [ text "x" ] ] {} ]..',
  'choice [ "loose" options [ [ text "x" ] ] {} ]..',
  "choice [ [ 1 2 ] ]..",
  'choice [ {prompt: "Q" options: [{text: "a" assess: {correct: true}}] shuffle: true} ]..',
  'choice [ {prompt: "Q"} {prompt: "R"} ]..',
  'choice "x"..',
  "choice 5..",
  'stimulus [ title "T" ]..',
  "assess [ correct points 2 ]..",
  'assess [ correct points "two" ]..',
  "correct..",
  'prompt "Hello"..',
  "points 5..",
  'options [ [ text "a" ] ] {}..',
  'tokens [ [ id "a" text "A" ] ] {}..',
  'responses [ [ response "a" assess [ correct ] ] ] {}..',
  // `null`, and a reference to nothing (undefined in TypeScript).
  'choice [ prompt null options [ [ text "a" ] ] {} ]..',
  "choice [ null ]..",
  'choice [ options [ [ text "a" ] null ] {} ]..',
  'choice [ prompt get-var "nope" options [ [ text "a" ] ] {} ]..',
  'choice [ options [ [ text "a" ] get-var "nope" ] {} ]..',
  'choice [ options [ [ text "a" ] ] get-var "nope" ]..',
  'options [ [ text "a" ] ] null..',
  'navigation "linear" get-var "nope"..',
  '{a: get-var "nope" b: 1}..',
  // Programs of more than one expression, and functions.
  `set-var "q" "Hi?" choice [ prompt get-var "q" options [ [ text "a" assess [ correct ] ] ] {} ]..`,
  `set-var "q" ${Q("One?")} get-var "q"..`,
  "<x: x> 5..",
  "<x: x>..",
  `(<x: choice [ prompt x options [ [ text "a" ] ] {} ]>) "Q"..`,
  `<x: choice [ prompt x options [ [ text "a" ] ] {} ]> "Q"..`,
  `map (<x: choice [ prompt x options [ [ text "a" ] ] {} ]>) [ "Q" "R" ]..`,
  `items map (<x: choice [ prompt x options [ [ text "a" ] ] {} ]>) [ "Q" "R" ] {}..`,
  `if true then ${Q("One?")} else 5..`,
  // the TypeScript holds undefined in a list where the Rust holds null (see conformance.rs)
  'choice [ get-var "nope" options [ [ text "a" ] ] {} ]..',
  'paragraphs [ "a" get-var "nope" ]..',
];

// Every member list standing alone: given no list, given a configuration record that is not
// one (spread as JavaScript spreads it), and given entries that are not attribute lists.
for (const word of [
  "options",
  "selections",
  "rubric",
  "blanks",
  "responses",
  "dropdowns",
  "elements",
  "targets",
  "match-items",
  "categories",
  "classification-items",
  "tokens",
  "gaps",
  "parts",
  "items",
]) {
  handwritten.push(
    `${word} "x" {}..`,
    `${word} [] "ab"..`,
    `${word} [ [] ] [1 2]..`,
    `${word} [ [] ] {k: 1}..`,
    `${word} [ 5 ] {}..`,
    `${word} [ [ id "a" ] [ id "b" ] ] {}..`,
  );
}

/* ------------------------------------------------------------------- Upstream data */

const SIMPLE = `${Q("One?")}..`;
const withData = [
  { src: SIMPLE, data: { response: ["A"] } },
  { src: SIMPLE, data: { interaction: { type: "stale" }, response: ["B"], 2: 1, 1: 0 } },
  { src: SIMPLE, data: null },
  { src: SIMPLE, data: "ab" },
  { src: SIMPLE, data: [7, 8] },
  { src: SIMPLE, data: 5 },
  { src: "42..", data: { response: ["A"] } },
  // A chained task's envelope: the TypeScript spreads the envelope itself (see conformance.rs).
  { src: SIMPLE, data: { data: { response: ["A"] }, errors: [] } },
];

/* ------------------------------------------------------------------------- Run */

const programs = [...generated, ...NUMERIC, ...fragments, ...suites, ...handwritten].map((src) => ({
  src,
  data: {},
}));

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
for (const { src, data } of [...programs, ...withData]) {
  const key = JSON.stringify([src, data]);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log = () => {};
  let ast, expect;
  try {
    ast = await parser.parse(180, src, structuredClone(lexicon));
    expect = await run(ast, structuredClone(data));
  } catch {
    expect = null;
  } finally {
    console.log = log;
  }
  // A program the TypeScript visitor crashed on (a property read off `null`) reports the
  // exception's text and stack, which is no behaviour to conform to.
  if (expect === null || expect.errors?.some((e) => e.includes("TypeError"))) {
    console.warn(`skipped: ${src.slice(0, 100).replace(/\s+/g, " ")}`);
    continue;
  }
  cases.push({ src, ast, ...(JSON.stringify(data) === "{}" ? {} : { data }), expect });
}
writeFileSync(
  join(here, "cases.json"),
  "[\n" + cases.map((entry) => JSON.stringify(entry)).join(",\n") + "\n]\n",
);
console.log(
  `wrote ${cases.length} cases (${cases.filter((c) => c.expect.errors).length} with errors)`,
);
process.exit(0);
