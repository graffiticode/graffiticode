// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0186 is tested against, from the TypeScript L0186 in
// this directory (packages/core):
//
//   cases.json                        programs parsed with L0186's lexicon and compiled by
//                                     @graffiticode/l0186, with the AST and the result
//   ../../src/lexicon-additions.json  the words L0186 adds to the base lexicon
//   ../../src/vocab.json              the vocabulary tables, from packages/core/src/attributes.ts
//
// Most of the corpus is generated from the vocabulary: every word with a spread of good and
// wrong values in the description that takes it, every word in every description that does
// not, every setting of every container, every member in every list. Then the spec's
// programs, the TypeScript suite's, and hand-written cases.
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
const attributes = await load("packages/core/dist/attributes.js");
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

// attributes.ts is the single source of truth for the vocabulary. A tag's `emit` is a
// function there; it is written out as the value each accepted tag emits.
const {
  chainFields,
  memberFields,
  containerFields,
  SAVE_TO_FIGJAM,
  validAttributes,
  validSettings,
  containerMembers,
  NAMED_COLORS,
  SHAPE_KINDS,
  STAMP_KINDS,
  exampleOf,
  wordOf,
} = attributes;
const fields = (table) =>
  Object.fromEntries(
    Object.entries(table).map(([name, meta]) => [
      name,
      {
        field: meta.field,
        expects: meta.expects,
        ...(meta.oneOf ? { oneOf: [...meta.oneOf] } : {}),
        ...(meta.emit
          ? { emit: Object.fromEntries(meta.oneOf.map((tag) => [tag, meta.emit(tag)])) }
          : {}),
      },
    ]),
  );
const words = [
  ...Object.keys(chainFields).map(wordOf),
  ...Object.keys(memberFields).map(wordOf),
  ...Object.values(containerFields).map((c) => c.word),
  SAVE_TO_FIGJAM.word,
];
writeFileSync(
  join(root, "crates/core/src/vocab.json"),
  JSON.stringify(
    {
      chainFields: fields(chainFields),
      memberFields: fields(memberFields),
      containerFields: Object.fromEntries(
        Object.entries(containerFields).map(([name, c]) => [name, c.word]),
      ),
      saveToFigjam: {
        name: SAVE_TO_FIGJAM.name,
        word: SAVE_TO_FIGJAM.word,
        field: SAVE_TO_FIGJAM.field,
      },
      validAttributes,
      validSettings,
      containerMembers,
      namedColors: NAMED_COLORS,
      shapeKinds: SHAPE_KINDS,
      stampKinds: STAMP_KINDS,
      examples: Object.fromEntries(words.map((word) => [word, exampleOf(word)])),
    },
    null,
    2,
  ) + "\n",
);

/* ------------------------------------------------------------------ generated */

// Values written in source, good and wrong for every kind of word.
const VALUES = [
  '"s"',
  '""',
  '"  "',
  "5",
  "0",
  "-40.5",
  "150",
  "0.5",
  "0.005",
  "1",
  "true",
  '"true"',
  "null",
  "[1 2]",
  "[_ 400]",
  '["a" "b"]',
  "[]",
  "{x: 1}",
  "DIAMOND",
  "LIKE",
  "TOP",
  "CENTER",
  "SMALL",
  "THICK",
  "ELBOWED",
  "_",
  '"diamond"',
  '"arrow lines"',
  '"Like"',
  '"#ffcc00"',
  '"#FFF"',
  '"#ffcc0"',
  '" Red "',
  '"constructor"',
  '"*"',
  'get-var "nope"',
  "div 1 0",
  "div 0 0",
  "add 100 20",
  "waypoint [1 2]",
  'sticky text "x" {}',
  'save-to-figjam "ABC123"',
];

// The rest of a description, so the word under test is all that can be wrong.
const filler = {
  sticky: "",
  shape: "",
  textbox: "",
  stamp: "kind LIKE",
  connector: 'from "a" to "b"',
};
const nodes = 'sticky id "a" {} sticky id "b" {}';
const page = (body) => `board [ page [ ${nodes} ${body} ] {} ] {}..`;

const generated = [];
// Every word with every value, in each description that takes it.
for (const [member, words] of Object.entries(validAttributes)) {
  for (const word of words) {
    const rest = filler[member]
      .split(/ (?=[a-z])/)
      .filter((part) => part && !part.startsWith(`${word} `))
      .join(" ");
    for (const value of VALUES) generated.push(page(`${member} ${word} ${value} ${rest} {}`));
  }
}
// Every setting with every value.
for (const value of VALUES) {
  for (const word of validSettings.board) {
    generated.push(`board [ page [ ] name "A" {} page [ ] name "B" {} ] ${word} ${value} {}..`);
  }
  for (const word of validSettings.page) {
    generated.push(`board [ page [ ] ${word} ${value} {} ] {}..`);
  }
  for (const word of validSettings.section) {
    generated.push(page(`section [ sticky text "in" {} ] ${word} ${value} {}`));
  }
  generated.push(`save-to-figjam ${value} board [ page [ ] {} ] {}..`);
  generated.push(page(`connector from "a" to "b" waypoints [ waypoint ${value} ] {}`));
  generated.push(page(`connector from "a" to "b" waypoints ${value} {}`));
  generated.push(page(`connector from "a" to "b" waypoints [ ${value} ] {}`));
}
// Every word where it does not belong: in each other description, and as each setting.
const allWords = Object.keys(chainFields).map(wordOf);
const sample = (word) => {
  const meta = chainFields[Object.keys(chainFields).find((name) => wordOf(name) === word)];
  return (
    {
      text: '"t"',
      content: '"t"',
      coord: "10",
      size: "10",
      opacity: "50",
      boolean: "true",
      tag: meta.oneOf?.[0],
      tagOrNumber: meta.oneOf?.[0],
      color: '"red"',
      endpoints: '"a"',
      waypoints: "[ waypoint [1 2] ]",
    }[meta.expects] ?? '"t"'
  );
};
for (const word of allWords) {
  for (const member of Object.keys(validAttributes)) {
    if (!validAttributes[member].includes(word)) {
      generated.push(page(`${member} ${filler[member]} ${word} ${sample(word)} {}`));
    }
  }
  for (const container of Object.keys(validSettings)) {
    if (validSettings[container].includes(word)) continue;
    if (container === "board") generated.push(`board [ page [ ] {} ] ${word} ${sample(word)} {}..`);
    if (container === "page") generated.push(`board [ page [ ] ${word} ${sample(word)} {} ] {}..`);
    if (container === "section") generated.push(page(`section [ ] ${word} ${sample(word)} {}`));
  }
  // A bare property as a list item: the early-close hint.
  generated.push(page(`sticky text "A" {} ${word} ${sample(word)} {}`));
  generated.push(`board [ ${word} ${sample(word)} {} ] {}..`);
  generated.push(`${word} ${sample(word)} {}..`);
}
// Every member and container in every list.
const items = {
  sticky: 'sticky text "s" {}',
  shape: "shape kind DIAMOND {}",
  textbox: 'textbox text "t" {}',
  stamp: "stamp kind LOVE {}",
  connector: 'connector from "a" to "b" {}',
  waypoint: "waypoint [1 2]",
  section: 'section [ sticky text "in" {} ] name "S" {}',
  page: "page [ ] {}",
  board: "board [ page [ ] {} ] {}",
  "save-to-figjam": 'save-to-figjam "ABC123"',
};
for (const [word, item] of Object.entries(items)) {
  generated.push(`board [ ${item} ] {}..`);
  generated.push(page(item));
  generated.push(page(`section [ ${item} ] {}`));
  generated.push(page(`connector from "a" to "b" waypoints [ ${item} ] {}`));
  generated.push(`${item}..`);
  generated.push(`board [ page [ ] {} ] {} ${item}..`);
  generated.push(`${word} {}..`);
}
// Every tag value of every tag word, on the description that takes it.
for (const [name, meta] of Object.entries(chainFields)) {
  if (!meta.oneOf) continue;
  const word = wordOf(name);
  for (const tag of meta.oneOf) {
    for (const [member, words] of Object.entries(validAttributes)) {
      if (!words.includes(word)) continue;
      const rest = word === "kind" ? "" : filler[member];
      generated.push(page(`${member} ${word} ${tag} ${rest} {}`));
      generated.push(
        page(`${member} ${word} "${tag.toLowerCase().replace(/_/g, "-")}" ${rest} {}`),
      );
    }
  }
}
// Every side on every line type.
for (const type of ["STRAIGHT", "ELBOWED", "CURVED", null]) {
  for (const side of attributes.SIDES) {
    const lineType = type ? `line-type ${type}` : "";
    generated.push(page(`connector from "a" to "b" ${lineType} from-side ${side} {}`));
    generated.push(page(`connector from "a" to "b" ${lineType} to-side ${side} {}`));
  }
}

/* ------------------------------------------------------------------ the spec */

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
  "packages/core/spec/README.md",
]
  .flatMap(blocks)
  .map((block) => block.trim())
  .filter((src) => src && !src.includes("…") && !src.includes("..."))
  .flatMap((src) =>
    src.endsWith("..")
      ? [src]
      : [`${src}..`, `board [ page [ sticky id "a" {} sticky id "b" {} ${src} ] {} ] {}..`],
  );

/* ------------------------------------------------------------------ the TypeScript suite */

// The string literals passed to compile/errorOf/nodesOf in the TypeScript suite. `${two}` is
// substituted; other interpolations are skipped. `nodesOf` bodies are wrapped as it wraps them.
const TWO = 'sticky id "A" text "A" {} sticky id "B" text "B" {}';
function testPrograms(path) {
  const source = readFileSync(join(root, path), "utf8");
  const found = [];
  for (const match of source.matchAll(/(compile|errorOf|nodesOf|conn)\(\s*(['"`])/g)) {
    const [, fn, quote] = match;
    let at = match.index + match[0].length;
    let text = quote;
    while (at < source.length && source[at] !== quote) {
      if (source[at] === "\\") text += source[at++];
      text += source[at++];
    }
    text += quote;
    text = text.replaceAll("${two}", TWO);
    if (quote === "`" && text.includes("${")) continue;
    let src = new Function(`return ${text}`)();
    if (fn === "nodesOf") src = `board [ page [ ${src} ] {} ] {}`;
    if (fn === "conn") src = `board [ page [ ${TWO} connector from "A" to "B" ${src} {} ] {} ] {}`;
    found.push(src.trim().endsWith("..") ? src : `${src}..`);
  }
  return found;
}

/* ------------------------------------------------------------------ by hand */

const handwritten = [
  readFileSync(join(root, "packages/core/spec/template.gc"), "utf8"),
  // degenerate programs
  "42..",
  "..",
  '"board"..',
  "{}..",
  "board..",
  "board [ ] {}..",
  "board [ page [ ] {} ] {} board [ page [ ] {} ] {}..",
  "board [ page [ ] {} ] {} {}..",
  'board [ page [ sticky text "A" {} ] {} ] {} x 3 {}..',
  'set-var "n" 3 board [ page [ sticky x get-var "n" {} ] {} ] {}..',
  'board [ page [ sticky text "A" {} ] {} ] {} print "hi"..',
  "board [ page [ ] {} ] {} 42..",
  "[board [ page [ ] {} ] {}]..",
  'board [ page [ sticky text "A" {} ] {} ] title "T" {} save-to-figjam "ABC123"..',
  'save-to-figjam "ABC123" board [ page [ ] {} ] {} save-to-figjam "XYZ987"..',
  'save-to-figjam "ABC12" board [ page [ ] {} ] {}..',
  'save-to-figjam "  ABC123  " board [ page [ ] {} ] {}..',
  'save-to-figjam "figma.com/board/Q1w2E3/x" board [ page [ ] {} ] {}..',
  'save-to-figjam "https://www.figma.com/proto/ABC123/x" board [ page [ ] {} ] {}..',
  'save-to-figjam "https://www.figma.com/board/" board [ page [ ] {} ] {}..',
  "save-to-figjam 123456 board [ page [ ] {} ] {}..",
  'save-to-figjam ["ABC123"] board [ page [ ] {} ] {}..',
  "save-to-figjam board [ page [ ] {} ] {}..",
  'board [ page [ ] {} ] save-to-figjam "ABC123"..',
  'board [ save-to-figjam "ABC123" page [ ] {} ] {}..',
  'board [ page [ sticky save-to-figjam "ABC123" ] {} ] {}..',
  'board [ page [ ] title save-to-figjam "ABC123" ] {}..',
  // records written as literals
  'board [ page [ sticky {"constructor": 1} ] {} ] {}..',
  'board [ page [ sticky {"toString": 1} ] {} ] {}..',
  'board [ page [ sticky {"valueOf": 1} ] {} ] {}..',
  'board [ page [ sticky {"hasOwnProperty": 1} ] {} ] {}..',
  'board [ page [ sticky {"__proto__": 1} ] {} ] {}..',
  'board [ page [ {"constructor": {}} ] {} ] {}..',
  'board [ page [ sticky {"font-size": 1 x: 2 "id": "q"} ] {} ] {}..',
  'board [ page [ sticky x 5 {"2": 1} ] {} ] {}..',
  'board [ page [ sticky x 5 {"2": 1 "1": 2} ] {} ] {}..',
  'board [ page [ sticky {x: get-var "q"} ] {} ] {}..',
  'board [ page [ {sticky: get-var "q"} ] {} ] {}..',
  'board [ page [ {sticky: "ab"} ] {} ] {}..',
  'board [ page [ {sticky: ""} ] {} ] {}..',
  "board [ page [ {sticky: []} ] {} ] {}..",
  "board [ page [ {sticky: [1]} ] {} ] {}..",
  "board [ page [ {sticky: null} ] {} ] {}..",
  "board [ page [ {sticky: 5} ] {} ] {}..",
  'board [ page [ {shape: 5} {stamp: {kind: "LIKE"}} ] {} ] {}..',
  'board [ page [ {stamp: {kind: "like"}} ] {} ] {}..',
  "board [ page [ {stamp: {kind: [1 2]}} ] {} ] {}..",
  "board [ page [ {stamp: {kind: {a: 1}}} ] {} ] {}..",
  "board [ page [ {stamp: {kind: null}} ] {} ] {}..",
  "board [ page [ {shape: {kind: 5}} ] {} ] {}..",
  "board [ page [ {shape: {kind: DIAMOND}} ] {} ] {}..",
  "board [ page [ {shape: null} ] {} ] {}..",
  "board [ page [ {stamp: null} ] {} ] {}..",
  "board [ page [ {connector: null} ] {} ] {}..",
  "board [ page [ {connector: 5} ] {} ] {}..",
  'board [ page [ sticky id "a" {} {connector: {from: "a" to: 5}} ] {} ] {}..',
  'board [ page [ sticky id "a" {} {connector: {from: "a" to: null}} ] {} ] {}..',
  'board [ page [ sticky id "a" {} {connector: {from: "a" to: [1 "a"]}} ] {} ] {}..',
  'board [ page [ sticky id "a" {} {connector: {from: "a" to: {b: 1}}} ] {} ] {}..',
  'board [ page [ sticky id "a" {} {connector: {from: "a" to: "a" fromSide: "center"}} ] {} ] {}..',
  'board [ page [ sticky id "a" {} {connector: {from: "a" to: "a" toSide: "center" lineType: 5}} ] {} ] {}..',
  'board [ page [ sticky id "a" {} {connector: {from: "a" to: "a" toSide: "center" lineType: "curvy"}} ] {} ] {}..',
  'board [ page [ sticky id "a" {} {connector: {from: "a" to: "*" waypoints: 1}} ] {} ] {}..',
  'board [ page [ sticky id "a" {} {connector: {from: "a" to: "a" waypoints: null}} ] {} ] {}..',
  'board [ page [ {sticky: {id: 5}} {sticky: {id: "5"}} ] {} ] {}..',
  'board [ page [ {sticky: {id: null text: "t"}} sticky id "b" {} connector from "b" to "t" {} ] {} ] {}..',
  "board [ page [ {sticky: {id: null text: null}} ] {} ] {}..",
  'board [ page [ {sticky: {id: [1 2]}} {sticky: {id: "1,2"}} ] {} ] {}..',
  'board [ page [ {sticky: {text: {a: 1}}} sticky id "b" {} connector from "b" to "[object Object]" {} ] {} ] {}..',
  'board [ page [ {sticky: {id: ""}} {sticky: {id: ""}} ] {} ] {}..',
  'board [ page [ {sticky: {id: ""}} sticky id "b" {} connector from "b" to "" {} ] {} ] {}..',
  "board [ {page: null} ] {}..",
  "board [ {page: {settings: {}}} ] {}..",
  'board [ {page: {nodes: "ab" settings: {}}} ] {}..',
  "board [ {page: {nodes: {} settings: {}}} ] {}..",
  "board [ {page: {nodes: [null] settings: {}}} ] {}..",
  "board [ {page: {nodes: [5 [1]] settings: {}}} ] {}..",
  'board [ {page: {nodes: [{type: "connector" from: null to: "*"}] settings: {}}} {page: {nodes: [{type: "connector" from: "*" to: "*"}] settings: {name: "B"}}} ] {}..',
  'board [ page [ {section: {name: "S"}} ] {} ] {}..',
  'board [ page [ {section: {name: "S" nodes: [{type: "section" nodes: 5}]}} ] {} ] {}..',
  "board [ {page: 5} ] {}..",
  "board [ {page: {}} ] {}..",
  'board [ {page: {nodes: [] settings: {name: "A"}}} ] {}..',
  "board [ {page: {nodes: [] settings: {}}} {page: {nodes: [] settings: {}}} ] {}..",
  "board [ {page: {nodes: [] settings: {name: 5}}} {page: {nodes: [] settings: {name: 5}}} ] {}..",
  "board [ {page: {nodes: [] settings: {name: [1]}}} {page: {nodes: [] settings: {name: [1]}}} ] {}..",
  "board [ {page: {nodes: [] settings: {name: null}}} ] {}..",
  "board [ {page: {nodes: [] settings: {name: null}}} {page: {nodes: [] settings: {name: null}}} ] {}..",
  'board [ {page: {nodes: [{type: "section" nodes: [] name: "S"}] settings: {}}} ] {}..',
  "board [ page [ {section: 5} ] {} ] {}..",
  "board [ page [ {section: null} ] {} ] {}..",
  'board [ page [ {section: {name: "S" nodes: []}} ] {} ] {}..',
  'board [ page [ ] {} ] {showPageTabs: "yes"}..',
  'board [ page [ ] name "A" {} page [ ] name "B" {} ] {showPageTabs: 0}..',
  'board [ page [ ] name "A" {} page [ ] name "B" {} ] {showPageTabs: null showPageMenu: null}..',
  "board [ page [ ] {} ] {title: 5}..",
  'board [ page [ ] {} ] {title: get-var "q"}..',
  "board [ page [ ] {background: 5 name: 7} ] {}..",
  'board [ page [ ] {"1": 2} ] {}..',
  'board [ page [ ] {} ] {"0": 2}..',
  'board [ page [ ] {} ] {"": 2}..',
  'board [ page [ {"": 2} ] {} ] {}..',
  'board [ page [ {"x": 1 "y": 2} ] {} ] {}..',
  'board [ page [ {"fontSize": 1} ] {} ] {}..',
  'board [ page [ {"saveToFigjam": "ABC123"} ] {} ] {}..',
  '{"saveToFigjam": "ABC123"} board [ page [ ] {} ] {}..',
  '{type: "board" pages: []} ..',
  '{type: "board"} {saveToFigjam: "Q"}..',
  // lists and settings that are not
  "board [ page [ ] [ ] ] {}..",
  "board page [ ] {} {}..",
  'board "x" {}..',
  "board [ page [ ] {} ] 5..",
  "board [ page [ ] {} ] DIAMOND..",
  "board [ page 5 {} ] {}..",
  'board [ page [ ] "x" ] {}..',
  "board [ page [ section 5 {} ] {} ] {}..",
  "board [ page [ section [ ] [] ] {} ] {}..",
  "board [ page [ sticky 5 ] {} ] {}..",
  'board [ page [ sticky "x" ] {} ] {}..',
  "board [ page [ sticky [] ] {} ] {}..",
  "board [ page [ sticky DIAMOND ] {} ] {}..",
  "board [ page [ sticky x 1 5 ] {} ] {}..",
  "board [ page [ sticky x 1 [] ] {} ] {}..",
  "board [ page [ sticky x 1 DIAMOND ] {} ] {}..",
  "board [ page [ sticky x 1 null ] {} ] {}..",
  'board [ page [ sticky x 1 get-var "q" ] {} ] {}..',
  "board [ page [ ] {} ] title 5 {}..",
  // errors that accumulate
  'board [ page [ sticky x "a" y "b" {} ] {} ] {}..',
  'board [ page [ sticky x "a" {} sticky y "b" {} ] {} ] {}..',
  'board [ page [ sticky x "a" {} ] name 5 {} ] title 6 {}..',
  'board [ page [ sticky x "a" {} ] {} page [ sticky y "b" {} ] {} ] {}..',
  "board [ page [ sticky x 1 x 2 x 3 {} ] {} ] {}..",
  "board [ page [ sticky width 1 height 2 {} ] {} ] {}..",
  // nodes, keys and connectors
  'board [ page [ sticky text "A" {} sticky text "A" {} connector from "A" to "A" {} ] {} ] {}..',
  'board [ page [ sticky id "A" text "A" {} sticky text "A" {} connector from "A" to "A" {} ] {} ] {}..',
  'board [ page [ section [ ] name "S" {} section [ ] name "S" {} sticky id "b" {} connector from "b" to "S" {} ] {} ] {}..',
  'board [ page [ section [ sticky id "S" {} ] name "S" {} sticky id "b" {} connector from "b" to "S" {} ] {} ] {}..',
  'board [ page [ section [ ] name "S" {} sticky id "b" {} connector from "b" to "S" {} ] {} ] {}..',
  'board [ page [ section [ sticky id "x" {} ] id "s" {} ] {} ] {}..',
  'board [ page [ section [ sticky id "a" {} ] {} sticky id "a" {} ] {} ] {}..',
  'board [ page [ stamp kind LIKE {} stamp kind LIKE {} sticky id "b" {} connector from "b" to "like" {} ] {} ] {}..',
  'board [ page [ stamp kind LIKE {} sticky id "b" {} connector from "b" to "LIKE" {} ] {} ] {}..',
  'board [ page [ connector from "a" to "b" {} ] {} ] {}..',
  'board [ page [ connector from "*" to "*" {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} connector from "a" to ["*" "a"] {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} connector from "a" to [] {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} connector from "a" to [""] {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} connector from "a" to ["a" 5] {} ] {} ] {}..',
  'board [ page [ sticky id "5" {} connector from 5 to "5" {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} connector from "a" to " " {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} connector to "a" {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} connector {} ] {} ] {}..',
  `board [ page [ ${Array.from({ length: 14 }, (_, i) => `sticky id "n${i}" {}`).join(" ")} connector from "n0" to "zz" {} ] {} ] {}..`,
  `board [ page [ ${Array.from({ length: 12 }, (_, i) => `sticky id "n${i}" {}`).join(" ")} connector from "n0" to "zz" {} ] {} ] {}..`,
  'board [ page [ sticky id "a" {} ] name "One" {} page [ sticky id "b" {} connector from "b" to "a" {} ] name "Two" {} page [ sticky text "a" {} ] name "Three" {} ] {}..',
  'board [ page [ section [ sticky id "a" {} ] name "Sec" {} ] name "One" {} page [ sticky id "b" {} connector from "b" to "Sec" {} ] name "Two" {} ] {}..',
  'board [ page [ ] name "A" {} page [ ] {} ] {}..',
  'board [ page [ ] name "A" {} page [ ] name "B" {} ] show-page-tabs false show-page-menu false {}..',
  'board [ page [ ] name "A" {} page [ ] name "B" {} ] show-page-menu true {}..',
  "board [ page [ ] {} ] show-page-tabs true {}..",
  'board [ page [ ] name "Page 1" {} ] {}..',
  'board [ page [ sticky text "Ünïcödé ✓ 😀" id "é" {} sticky id "b" {} connector from "b" to "é" {} ] name "Ω" {} ] title "日本" {}..',
  'board [ page [ sticky text "line\\nbreak \\"q\\" \\\\ tab\\t" {} ] {} ] {}..',
  "board [ page [ sticky text 1e21 x 1e21 y 0.1 {} sticky text 0.1 x -0 {} ] {} ] {}..",
  "board [ page [ sticky text 123456789012345678901 {} ] {} ] {}..",
  // numbers no double holds: decimal.js objects in the TypeScript
  "board [ page [ sticky 123456789012345678901 ] {} ] {}..",
  "board [ page [ sticky x 1 123456789012345678901 ] {} ] {}..",
  "board [ page [ 123456789012345678901 ] {} ] {}..",
  'board [ page [ sticky id "a" {} sticky id "b" {} connector from "a" to "b" waypoints [ 123456789012345678901 ] {} ] {} ] {}..',
  "board [ page [ {sticky: {x: 123456789012345678901}} ] {} ] {}..",
  "board [ page [ ] name 123456789012345678901 {} ] {}..",
  "board [ page [ ] {name: 123456789012345678901} ] {}..",
  "board [ page [ ] {name: 123456789012345678901} page [ ] {name: 123456789012345678901} ] {}..",
  'board [ page [ {sticky: {id: 123456789012345678901}} {sticky: {id: "123456789012345678901"}} ] {} ] {}..',
  'board [ page [ sticky id "a" {} connector from "a" to 123456789012345678901 {} ] {} ] {}..',
  "board [ page [ ] {} ] 123456789012345678901..",
  "123456789012345678901..",
  "board [ page [ sticky x 100000000000000000000 y 9007199254740992 {} ] {} ] {}..",
  "board [ page [ sticky y 9007199254740993 {} ] {} ] {}..",
  'board [ page [ sticky id 7 {} sticky id "b" {} connector from "b" to 7 {} ] {} ] {}..',
  "board [ page [ sticky opacity 0.999 {} ] {} ] {}..",
  "board [ page [ sticky opacity 0.0049 {} ] {} ] {}..",
  "board [ page [ sticky opacity 0.125 {} ] {} ] {}..",
  "board [ page [ sticky opacity 0.145 {} ] {} ] {}..",
  "board [ page [ sticky opacity 100.5 {} ] {} ] {}..",
  "board [ page [ sticky opacity -0.5 {} ] {} ] {}..",
  'board [ page [ shape kind " diamond " {} ] {} ] {}..',
  'board [ page [ shape kind "rounded rectangle" {} ] {} ] {}..',
  'board [ page [ shape kind "Rounded-Rectangle" {} ] {} ] {}..',
  'board [ page [ shape fill "\\u00a0red\\u00a0" {} ] {} ] {}..',
  'board [ page [ shape fill "RED" stroke "#ABCDEF" {} ] {} ] {}..',
  'board [ page [ shape fill "__proto__" {} ] {} ] {}..',
  'board [ page [ shape fill "Constructor" {} ] {} ] {}..',
  'board [ page [ shape fill "tostring" {} ] {} ] {}..',
  'board [ page [ textbox font-size "large" {} ] {} ] {}..',
  'board [ page [ textbox font-size "extra large" {} ] {} ] {}..',
  "board [ page [ textbox font-size -3 {} ] {} ] {}..",
  'board [ page [ sticky id "a" {} sticky id "b" {} connector from "a" to "b" waypoints [ waypoint [1 2 3] ] {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} sticky id "b" {} connector from "a" to "b" waypoints [ waypoint ["1" 2] ] {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} sticky id "b" {} connector from "a" to "b" waypoints [ waypoint [1 2] waypoint [_ 3] waypoint [4 _] ] {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} sticky id "b" {} connector from "a" to "b" waypoints [ {waypoint: 5} ] {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} sticky id "b" {} connector from "a" to "b" waypoints [ {waypoint: 5 x: 1} ] {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} sticky id "b" {} connector from "a" to "b" waypoints [ 5 ] {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} sticky id "b" {} connector from "a" to "b" waypoints [ DIAMOND ] {} ] {} ] {}..',
  'board [ page [ sticky id "a" {} sticky id "b" {} connector from ["a"] to "b" waypoints [ waypoint [1 2] ] {} ] {} ] {}..',
  // L0000 inside a program
  'board [ page [ sticky text concat ["a" "b"] x mul 2 3 y sub 0 5 {} ] {} ] {}..',
  'board [ page [ sticky text "n" x add 100 20 {} ] {} ] {}..',
  'board [ page [ sticky text "n" x if true then 1 else 2 {} ] {} ] {}..',
  'board [ map (<x: sticky text x {}>) ["a" "b"] ] {}..',
  'board [ page map (<x: sticky text x {}>) ["a" "b"] {} ] {}..',
  'board [ page [ sticky text hd ["a"] {} ] {} ] {}..',
  'let f = <x: sticky text x {}>.. board [ page [ f "a" ] {} ] {}..',
  'board [ page [ sticky text "a" x {} ] {} ] {}..',
  'board [ page [ sticky text "a" x ] {} ] {}..',
  "board [ page [ sticky",
  'board [ page [ sticky text "A" {} ] {} ] {}',
  "board [ page [ sticky nope 1 {} ] {} ] {}..",
  "board [ page [ nope ] {} ] {}..",
  "nope..",
];

const programs = [
  ...generated,
  ...fragments,
  ...testPrograms("packages/core/src/compiler.test.ts"),
  ...testPrograms("packages/core/src/errors.test.ts"),
  ...handwritten,
];

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

process.on("uncaughtException", () => {});

const log = console.log;
const warn = console.warn;
const seen = new Set();
const cases = [];
for (const src of programs) {
  if (seen.has(src)) continue;
  seen.add(src);
  console.log = () => {};
  console.warn = () => {};
  let ast, expect;
  try {
    ast = await parser.parse(186, src, structuredClone(lexicon));
    expect = await run(ast);
  } catch {
    expect = null;
  } finally {
    console.log = log;
    console.warn = warn;
  }
  if (expect === null) {
    console.warn(`skipped: ${src.slice(0, 100).replace(/\s+/g, " ")}`);
    continue;
  }
  cases.push({ src, ast, expect });
}
writeFileSync(
  join(here, "cases.json"),
  "[\n" + cases.map((entry) => JSON.stringify(entry)).join(",\n") + "\n]\n",
);
console.log(
  `wrote ${cases.length} cases (${cases.filter((c) => c.expect.errors).length} with errors)`,
);
process.exit(0);
