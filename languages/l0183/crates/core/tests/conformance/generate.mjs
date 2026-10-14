// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0183 is tested against, from the TypeScript L0183 in
// this directory (packages/core):
//
//   cases.json                        programs parsed with L0183's lexicon and compiled by
//                                     @graffiticode/l0183, with the AST, the upstream data and
//                                     the result
//   ../../src/lexicon-additions.json  the words L0183 adds to the base lexicon
//   ../../src/attributes.json         the vocabulary tables of packages/core/src/attributes.ts
//
// Most of the corpus is generated from the tables: every chain word written in every
// description and settings record, with a value of each kind; every member word and assess
// word with good and wrong values. Then the spec's programs, the TypeScript suite's, the
// learner's answers carried in upstream data, and hand-written cases.
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
const core = await load("packages/core/dist/index.js");
const {
  compiler,
  lexicon,
  chainFields,
  memberFields,
  assessFields,
  validAttributes,
  validSettings,
} = core;
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

// attributes.ts is the single source of truth for the vocabulary and where each word goes.
writeFileSync(
  join(root, "crates/core/src/attributes.json"),
  JSON.stringify(
    { chainFields, memberFields, assessFields, validAttributes, validSettings },
    null,
    2,
  ) + "\n",
);

const wordOf = (name) => name.toLowerCase().replace(/_/g, "-");

/* ------------------------------------------------------------ generated */

// A value of every kind a word can be handed, as source.
const VALUES = [
  '"s"',
  '""',
  '"  "',
  "42",
  "1.5",
  "-1",
  "0",
  "DARK",
  "left",
  '"dark"',
  '"left"',
  "true",
  "false",
  '"true"',
  "[expected]",
  "[]",
  "{}",
  "{a: 1}",
  "null",
];
const good = (name, meta) => {
  if (meta.oneOf) return meta.expects === "tag" ? meta.oneOf : meta.oneOf.map((v) => `"${v}"`);
  switch (meta.expects) {
    case "text":
      return ['"Nucleus"', "7"];
    case "number":
      return ["2", "-1"];
    case "boolean":
      return ["true", "false"];
    case "list":
      return ["[expected]"];
    case "record":
      return ['text "x" {}'];
    default:
      return [];
  }
};

const HUB = 'hub text "A" {}';
const NODES = 'nodes [ node text "B" {} ] {}';
const web = (inside, after = "{}") => `concept-web [ ${inside} ] ${after}..`;

// Where a chain word can be written, as a function of the word written there.
const PLACES = {
  hub: (w) => web(`hub ${w} ${w.startsWith("text ") ? "" : 'text "A" '}{} ${NODES}`),
  node: (w) => web(`${HUB} nodes [ node ${w} ${w.startsWith("text ") ? "" : 'text "B" '}{} ] {}`),
  blank: (w) =>
    web(
      `${HUB} nodes [ node ${w} ${w.startsWith("text ") ? "" : 'text "B" '}assess [expected] {} ] {}`,
    ),
  edge: (w) =>
    web(
      `${HUB} ${NODES} edges [ edge ${w} ${w.startsWith("from ") ? "" : 'from "hub" '}${
        w.startsWith("to ") ? "" : 'to "B" '
      }{} ] {}`,
    ),
  "concept-web": (w) => web(`${HUB} ${NODES}`, `${w} {}`),
  nodes: (w) => web(`${HUB} nodes [ node text "B" assess [expected] {} ] ${w} {}`),
  edges: (w) =>
    web(`${HUB} ${NODES} edges [ edge from "hub" to "B" label "x" assess [expected] {} ] ${w} {}`),
  inside: (w) => web(`${HUB} ${w} {} ${NODES}`),
  assess: (w) => web(`${HUB} nodes [ node text "B" assess [expected ${w} {}] {} ] {}`),
};

const generated = [];
for (const [name, meta] of Object.entries(chainFields)) {
  const word = wordOf(name);
  for (const place of Object.keys(PLACES)) {
    // Every value where the word belongs; elsewhere, a good one and a wrong one.
    const accepts = {
      ...validAttributes,
      ...validSettings,
      blank: validAttributes.node,
      inside: [],
    };
    const values = accepts[place].includes(word)
      ? [...good(name, meta), ...VALUES]
      : [good(name, meta)[0] ?? '"s"', "[]"];
    for (const v of values) generated.push(PLACES[place](`${word} ${v}`));
  }
  // A chain that does not end in a record, and a word given twice.
  generated.push(web(`hub ${word} "x" 5 ${NODES}`));
  generated.push(
    web(`${HUB} nodes [ node text "B" ${word} ${good(name, meta)[0] ?? '"x"'} [] ] {}`),
  );
  generated.push(web(`${HUB} ${NODES}`, `${word} ${good(name, meta)[0] ?? '"x"'} "x"`));
  generated.push(web(`${HUB} ${NODES}`, `${word} ${good(name, meta)[0] ?? '"x"'} 5`));
  generated.push(web(`${HUB} nodes [ node ${word} "x" ${word} "y" text "B" {} ] {}`));
}
for (const [name, meta] of Object.entries(memberFields)) {
  const word = wordOf(name);
  for (const v of [...good(name, meta), ...VALUES]) {
    generated.push(web(`${HUB} nodes [ ${word} ${v} ] {}`));
    generated.push(web(`${word} ${v} ${NODES}`));
    generated.push(web(`${HUB} ${NODES} edges [ ${word} ${v} ] {}`));
  }
}
for (const [name] of Object.entries(assessFields)) {
  const word = wordOf(name);
  const forms = name === "POINTS" ? VALUES.map((v) => `points ${v}`) : [word];
  for (const f of forms) {
    for (const flag of ["", "expected", "distractor"]) {
      const list = [flag, f].filter(Boolean).join(" ");
      generated.push(web(`${HUB} nodes [ node text "B" {} node text "C" assess [${list}] {} ] {}`));
      generated.push(
        web(
          `${HUB} ${NODES} edges [ edge from "hub" to "B" label "x" assess [expected] {} edge label "y" assess [${list}] {} ] {}`,
        ),
      );
    }
    generated.push(web(`${HUB} nodes [ ${f} ] {}`));
    generated.push(web(`${HUB} ${f} ${NODES}`));
    generated.push(web(`${HUB} nodes [ node text "B" ${f} {} ] {}`));
  }
}

// Every container given a value of every kind, as its list and as its settings.
for (const container of ["concept-web", "nodes", "edges"]) {
  for (const v of VALUES) {
    if (container === "concept-web") {
      generated.push(`concept-web ${v} {}..`);
      generated.push(`concept-web [ ${HUB} ${NODES} ] ${v}..`);
    } else {
      const ok = container === "nodes" ? '[ node text "B" {} ]' : '[ edge from "hub" to "B" {} ]';
      const other = container === "nodes" ? "" : NODES;
      generated.push(web(`${HUB} ${other} ${container} ${v} {}`));
      generated.push(web(`${HUB} ${other} ${container} ${ok} ${v}`));
    }
  }
}

/* -------------------------------------------------------- webs: edges, trays, pools */

const shapes = [];
const nodeTexts = ["Nucleus", "Ribosome", "Golgi", "Lysosome", "Vacuole"];
for (let n = 1; n <= 5; n++) {
  for (let blanks = 0; blanks <= n; blanks++) {
    const nodes = nodeTexts
      .slice(0, n)
      .map((t, i) => `node text "${t}" ${i < blanks ? `assess [expected points ${i + 1}] ` : ""}{}`)
      .join(" ");
    shapes.push(web(`${HUB} nodes [ ${nodes} ] {}`));
    shapes.push(web(`hub text "A" assess [expected] {} nodes [ ${nodes} ] tray-align top {}`));
    shapes.push(
      web(
        `${HUB} nodes [ ${nodes} node text "Wrong" assess [distractor points -1] {} ] {}`,
        'title "T" instructions "I" theme DARK instant-feedback true {}',
      ),
    );
    const edges = nodeTexts
      .slice(0, n)
      .map(
        (t, i) =>
          `edge from "hub" to "${t}" ${i % 2 ? 'style "dashed-arrow" ' : ""}label "${
            i < 2 ? "has" : `rel${i}`
          }" ${i >= blanks ? "assess [expected] " : ""}{}`,
      )
      .join(" ");
    shapes.push(web(`${HUB} nodes [ ${nodes} ] {} edges [ ${edges} ] {}`));
    shapes.push(
      web(
        `${HUB} nodes [ ${nodes} ] {} edges [ ${edges} edge label "nope" assess [distractor] {} ] tray-align right {}`,
      ),
    );
  }
}
// Pools: interchangeable blanks and the edges that tell them apart.
shapes.push(
  web(
    `${HUB} nodes [ node text "a" assess [expected] {} node text "b" assess [expected] {} node text "c" assess [expected] {} ] {}`,
  ),
  web(
    `${HUB} nodes [ node id "a" text "ice" assess [expected] {} node id "b" text "steam" assess [expected] {} node id "c" text "fog" {} ] {} edges [ edge from "hub" to "a" {} edge from "b" to "hub" {} edge from "a" to "c" style "dashed" {} edge from "b" to "c" style "dashed" {} ] {}`,
  ),
  web(
    `${HUB} nodes [ node id "a" text "x" assess [expected] {} node id "b" text "y" assess [expected] {} ] {} edges [ edge from "hub" to "a" label "l" assess [expected] {} edge from "hub" to "b" label "m" assess [expected] {} edge from "a" to "b" label "k" {} ] {}`,
  ),
  web(
    `hub text "A" assess [expected] {} nodes [ node text "B" assess [expected] {} node text "C" {} ] {} edges [ edge from "A" to "B" {} edge from "C" to "A" style "solid-arrow" {} edge from "B" to "C" label "Z" {} edge from "C" to "B" label "a" {} ] {}`,
  ),
  // Ids that look like array indices, which JavaScript orders first.
  web(
    `${HUB} nodes [ node id "b" text "B" assess [expected] {} node id "2" text "C" assess [expected] {} node id "1" text "D" assess [expected] {} node text "10" assess [distractor] {} node text "3" assess [distractor] {} ] {}`,
  ),
  web(
    `${HUB} nodes [ node id "x" text "B" {} node id "y" text "C" {} ] {} edges [ edge id "9" from "x" to "y" label "p" assess [expected] {} edge id "e" from "hub" to "x" label "q" assess [expected] {} edge label "1" assess [distractor] {} ] {}`,
  ),
  // Edge references: by id, by text, the hub, a blank, ambiguous, missing, a distractor.
  web(`${HUB} ${NODES} edges [ edge from "A" to "B" {} ] {}`),
  web(`${HUB} ${NODES} edges [ edge from "hub" to "n1" {} ] {}`),
  web(
    `${HUB} nodes [ node text "B" assess [expected] {} node text "C" {} ] {} edges [ edge from "B" to "C" {} ] {}`,
  ),
  web(`${HUB} nodes [ node text "B" {} node text "B" {} ] {} edges [ edge from "A" to "B" {} ] {}`),
  web(`${HUB} nodes [ node text "B" {} node id "x" {} ] {} edges [ edge from "A" to "Q" {} ] {}`),
  web(
    `${HUB} nodes [ node text "B" assess [expected] {} node text "D" assess [distractor] {} ] {} edges [ edge from "A" to "D" {} ] {}`,
  ),
  web(`${HUB} ${NODES} edges [ edge from "B" to "B" {} ] {}`),
  web(`${HUB} ${NODES} edges [ edge from "hub" to "A" {} ] {}`),
  web(`${HUB} ${NODES} edges [ edge to "B" {} ] {}`),
  web(`${HUB} ${NODES} edges [ edge {} ] {}`),
  web(`${HUB} ${NODES} edges [ edge from "A" to "B" label "" assess [expected] {} ] {}`),
  web(`${HUB} ${NODES} edges [ edge from "A" to "B" label "  " assess [expected] {} ] {}`),
  web(`${HUB} ${NODES} edges [ edge from "A" to "B" label "" {} ] {}`),
  web(`${HUB} ${NODES} edges [ edge label "x" assess [distractor] {} ] {}`),
  web(
    `${HUB} ${NODES} edges [ edge from "A" to "B" label "x" assess [expected] {} edge label "x" assess [distractor] {} ] {}`,
  ),
  web(
    `${HUB} ${NODES} edges [ edge from "A" to "B" label "x" assess [expected] {} edge label "y" assess [distractor] {} edge label "y" assess [distractor points -2] {} ] {}`,
  ),
  web(
    `${HUB} ${NODES} edges [ edge from "A" to "B" label "x" assess [expected] {} edge from "hub" label "y" assess [distractor] {} ] {}`,
  ),
  web(
    `${HUB} ${NODES} edges [ edge id "e1" from "A" to "B" {} edge id "e1" from "B" to "A" {} ] {}`,
  ),
  web(`${HUB} ${NODES} edges [ edge id "n1" from "A" to "B" {} ] {}`),
  web(`${HUB} ${NODES} edges [ edge id "hub" from "A" to "B" {} ] {}`),
  web(`${HUB} ${NODES} edges [] {}`),
  web(`${HUB} nodes [ node id "e1" text "B" assess [expected] {} ] {}`),
  web(
    `${HUB} nodes [ node id "e2" text "B" {} node text "C" {} ] {} edges [ edge from "A" to "B" {} edge from "A" to "C" {} ] {}`,
  ),
  // Nodes: ids, blanks, distractors.
  web(`${HUB} nodes [ node id "x" text "B" {} node id "x" text "C" {} ] {}`),
  web(`${HUB} nodes [ node id "hub" text "B" {} ] {}`),
  web(`${HUB} nodes [ node text "B" {} node id "n1" text "C" {} ] {}`),
  web(`${HUB} nodes [ node text "x" assess [distractor] {} ] {}`),
  web(
    `${HUB} nodes [ node text "x" assess [expected] {} node text "x" assess [distractor] {} ] {}`,
  ),
  web(
    `${HUB} nodes [ node text "x" assess [expected] {} node text "y" assess [distractor] {} node text "y" assess [distractor] {} ] {}`,
  ),
  web(`${HUB} nodes [ node text "x" assess [expected] {} node text "x" assess [expected] {} ] {}`),
  web(`${HUB} nodes [ node text "" {} ] {}`),
  web(`${HUB} nodes [ node text "" assess [expected] {} ] {}`),
  web(`${HUB} nodes [ node text " " assess [distractor] {} node text "B" {} ] {}`),
  web(
    `${HUB} nodes [ node text "B" shape "pill" color "teal" size "large" assess [expected] {} ] {}`,
  ),
  web(
    `${HUB} nodes [ node text "B" {} node text "x" shape "pill" assess [distractor] {} node text "y" assess [expected] {} ] {}`,
  ),
  web(`hub text "A" assess [distractor] {} ${NODES}`),
  web(`hub text "A" assess [expected points 3] shape "circle" {} ${NODES}`),
  web(`hub text "A" id "h" {} ${NODES}`),
  web(`${HUB} nodes [] {}`),
  web(`${HUB} nodes [ node text "x" assess [distractor] {} ] {} edges [] {}`),
  web(`${HUB} nodes [ node text "B" {} ] {} nodes [ node text "C" {} ] {}`),
  web(`${HUB} ${HUB} ${NODES}`),
  web(NODES),
  web(HUB),
  web(""),
  web(`${HUB} ${NODES}`, 'title "" instructions "" {}'),
  web(`${HUB} ${NODES}`, 'title "   " {}'),
  web(`${HUB} ${NODES}`, "theme LIGHT instant-feedback false {}"),
  web(`${HUB} ${NODES}`, "{title: 5 theme: null instantFeedback: 0}"),
  web(`${HUB} ${NODES}`, '{title: "T" "1": 2}'),
);

/* ------------------------------------------------------------ spec and suite */

function blocks(path) {
  const out = [];
  let current = null;
  let fence = "";
  for (const line of readFileSync(join(root, path), "utf8").split("\n")) {
    if (line.trim().startsWith("```")) {
      if (current) {
        out.push(current.join("\n"));
        current = null;
      } else {
        current = [];
        fence = line.match(/^\s*/)[0];
      }
      continue;
    }
    if (current) current.push(line.startsWith(fence) ? line.slice(fence.length) : line);
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
  .filter((src) => src.endsWith(".."));

// The first argument of every compile(...) and errorOf(...) in the TypeScript suite, evaluated
// with the suite's helpers in scope.
function testPrograms(path) {
  const source = readFileSync(join(root, path), "utf8");
  const consts = {};
  for (const match of source.matchAll(/^const ([A-Z_]+) = (`[^`]*`);/gm)) {
    consts[match[1]] = new Function(...Object.keys(consts), `return ${match[2]}`)(
      ...Object.values(consts),
    );
  }
  const scope = { web, ...consts, data: undefined, model: undefined };
  const found = [];
  for (const match of source.matchAll(/\b(?:compile|errorOf)\(/g)) {
    let at = match.index + match[0].length;
    let depth = 1;
    let quote = null;
    const start = at;
    for (; at < source.length && depth > 0; at++) {
      const c = source[at];
      if (quote) {
        if (c === "\\") at++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
    }
    const args = source.slice(start, at - 1);
    if (/readFileSync|\bsrc\b/.test(args)) continue;
    try {
      const value = new Function(...Object.keys(scope), `return ((a) => a)(${args})`)(
        ...Object.values(scope),
      );
      if (typeof value === "string") found.push(value);
    } catch {}
  }
  return found;
}

const template = readFileSync(join(root, "packages/core/spec/template.gc"), "utf8");
const CELL = `concept-web [
  hub text "The Cell" {}
  nodes [
    node id "r" text "Receptor" assess [expected] {}
    node text "Nucleus" {}
    node text "Mitochondria" assess [expected] {}
    node text "Ribosome" assess [expected points 2] {}
    node text "Golgi" assess [distractor] {}
  ] tray-align left {}
  edges [
    edge from "hub" to "r" {}
    edge from "hub" to "Mitochondria" label "makes energy" assess [expected] {}
    edge label "stores" assess [distractor points -1] {}
  ] {}
] title "Cell signaling" {}..`;

const handwritten = [
  template,
  "42..",
  "..",
  '"x"..',
  "{}..",
  "[]..",
  "concept-web..",
  // A record literal shaped like a compiled web (the Rust reads it; see tests/conformance.rs).
  '{interaction: {type: "concept-web"}}..',
  'hub text "A" {}..',
  'nodes [ node text "B" {} ] {}..',
  'text "A" {}..',
  "expected..",
  "points 2..",
  `${web(`${HUB} ${NODES}`)} 42..`.replace("....", ".."),
  `42 ${web(`${HUB} ${NODES}`)}`,
  // Read through the kernel: variables, parentheses, a list of webs.
  `set-var "h" hub text "A" {} ${web(`get-var "h" ${NODES}`)}`,
  `set-var "t" "Hello" ${web(`hub text get-var "t" {} ${NODES}`)}`,
  web(`hub text get-var "nope" {} ${NODES}`),
  web(`${HUB} ${NODES}`, 'title get-var "nope" {}'),
  web(`${HUB} ${NODES}`, '{title: get-var "nope"}'),
  // Undefined inside a list or a record literal (the Rust reads null or no field; see
  // tests/conformance.rs).
  web(`${HUB} nodes [ node text "B" assess [get-var "nope"] {} ] {}`),
  web(`${HUB} nodes [ node text "B" {a: get-var "nope"} ] {}`),
  web(`(${HUB}) ${NODES}`),
  `[${web(`${HUB} ${NODES}`).slice(0, -2)}]..`,
  // Record literals where words are expected.
  web(`{hub: {text: "A"}} {nodes: {items: [{text: "B"}] settings: {}}}`),
  web(`${HUB} {nodes: [1 2]}`),
  web(`${HUB} {nodes: 5}`),
  web(`{hub: "abc"} ${NODES}`),
  web(`{hub: 5} ${NODES}`),
  web(`{hub: {text: "A" assess: [{expected: true}]}} ${NODES}`),
  web(`{hub: {text: 5 assess: [{expected: true}]}} ${NODES}`),
  web(`${HUB} nodes [ {node: {text: "B"}} {node: 5} ] {}`),
  web(
    `${HUB} nodes [ node {text: "B" id: 5} node {text: 7} ] {} edges [ edge {from: "A" to: 5} ] {}`,
  ),
  web(`${HUB} nodes [ node {text: "B" assess: [{points: 2 expected: true}]} ] {}`),
  web(`${HUB} nodes [ node text "B" assess [{expected: true} {expected: true}] {} ] {}`),
  web(`${HUB} nodes [ node text "B" assess ["x"] {} ] {}`),
  web(`${HUB} nodes [ node text "B" assess [expected {}] {} ] {}`),
  web(`${HUB} nodes [ node text "B" assess [expected {a: 1 b: 2}] {} ] {}`),
  web(`${HUB} nodes [ {} ] {}`),
  web(`${HUB} nodes [ {a: 1 b: 2} ] {}`),
  web(`${HUB} nodes [ {expected: true} ] {}`),
  web(`${HUB} nodes [ "x" ] {}`),
  web(`${HUB} nodes [ [] ] {}`),
  web(`${HUB} nodes [ node text "B" {} edge from "A" to "B" {} ] {}`),
  web(`${HUB} nodes [ node text "B" {} ] {} edges [ node text "C" {} ] {}`),
  web(`${HUB} nodes [ node text "B" points 2 {} ] {}`),
  web(`${HUB} nodes [ node text "B" "C" ] {}`),
  web(`${HUB} node text "B" {}`),
  web(`${HUB} ${NODES} title "T" {}`),
  web(`${HUB} ${NODES} {title: "T"}`),
  web(`${HUB} ${NODES} {"5": 1}`),
  web(`${HUB} ${NODES} {}`),
  web(`${HUB} ${NODES}`, '{text: "x"}'),
  web(`${HUB} ${NODES}`, "{expected: true}"),
  web(`${HUB} ${NODES}`, '{"3": 1 "1": 2 b: 3}'),
  web(`${HUB} nodes [ node text "B" assess [expected] {} ] {trayAlign: "top" "2": 1}`),
  web(`${HUB} nodes [ node text "B" {"2": 1 a: 2} ] {}`),
  web(`${HUB} nodes [ node text "B" {"2": 1} ] {}`),
  web(`${HUB} nodes [ node text "B" assess [expected] {} ] {trayAlign: ""}`),
  web(`${HUB} nodes [ node text "B" assess [expected] {} ] {trayAlign: 0}`),
  web(`hub text "A" {constructorx: 1} ${NODES}`),
  // Numbers: decimals, signs, large.
  web(
    `${HUB} nodes [ node text 1.25 assess [expected points 0.1] {} node text 1e3 assess [expected points 0.2] {} ] {}`,
  ),
  web(
    `${HUB} nodes [ node text -0 {} node text 1e21 {} node text 0.000001 {} node text 1e-7 {} ] {}`,
  ),
  web(`${HUB} nodes [ node text "B" assess [expected points 1e21] {} ] {}`),
  web(
    `${HUB} nodes [ node text "B" assess [distractor points -0] {} node text "C" assess [expected] {} ] {}`,
  ),
  // Text JavaScript treats specially: escapes, astral characters, white space.
  web(`hub text "\\"q\\" \\\\ é 😀" {} nodes [ node text "\\u2028" assess [expected] {} ] {}`),
  web(`${HUB} nodes [ node text "\u00a0\u3000" assess [expected] {} ] {}`),
  web(`${HUB} nodes [ node text "\ufeff" assess [expected] {} node text "B" {} ] {}`),
  web(
    `${HUB} nodes [ node text "b" assess [expected] {} node text "B" assess [expected] {} node text "é" assess [expected] {} node text "😀" assess [expected] {} node text "\uff5e" assess [expected] {} ] {} edges [ edge from "A" to "b" label "😀" {} edge from "A" to "B" label "\uff5e" {} edge from "A" to "é" label "Z" {} edge from "A" to "😀" label "a" {} edge from "A" to "\uff5e" label "é" {} ] {}`,
  ),
];

const programs = [
  ...generated,
  ...shapes,
  ...fragments,
  ...testPrograms("packages/core/src/compiler.test.ts"),
  ...testPrograms("packages/core/src/errors.test.ts"),
  ...handwritten,
].map((src) => (src.trim().endsWith("..") ? src : `${src}..`));

// Upstream data: the learner's answers, bare and in the platform's envelope.
const ANSWERS = { interaction: { cells: { r: { value: "Golgi" }, n3: { value: "Ribosome" } } } };
const withData = [
  [CELL, ANSWERS],
  [CELL, { data: ANSWERS, errors: [] }],
  [CELL, { data: { data: ANSWERS, errors: [] }, errors: [] }],
  [CELL, { data: ANSWERS, errors: "no" }],
  [CELL, { data: ANSWERS }],
  [CELL, { errors: [] }],
  [CELL, { data: null, errors: [] }],
  [
    CELL,
    {
      title: "STALE",
      interaction: { type: "concept-web", nodes: [], cells: { gone: { value: "x" } } },
      validation: { points: 99 },
    },
  ],
  [CELL, { interaction: { cells: { r: { value: null } } } }],
  [
    CELL,
    { interaction: { cells: { r: { value: 5 }, n3: { value: "" }, e2: { value: "stores" } } } },
  ],
  [CELL, { interaction: { cells: { r: "Golgi", n3: [] } } }],
  [CELL, { interaction: { cells: ["a", { value: "b" }] } }],
  [CELL, { interaction: { cells: "abc" } }],
  [CELL, { interaction: { cells: null } }],
  [CELL, { interaction: "x" }],
  [CELL, { interaction: { cells: { r: { value: { tag: "x" } } } } }],
  [CELL, [1, 2]],
  [CELL, "string"],
  [CELL, 7],
  [
    web(
      `${HUB} nodes [ node id "0" text "B" assess [expected] {} node id "1" text "C" assess [expected] {} ] {}`,
    ),
    { interaction: { cells: ["first", { value: "second" }] } },
  ],
  [
    web(`${HUB} nodes [ node id "length" text "B" assess [expected] {} ] {}`),
    { interaction: { cells: "abc" } },
  ],
  ["data..", { interaction: { type: "concept-web" } }],
  ["data..", {}],
];

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
const jobs = [...programs.map((src) => [src, undefined]), ...withData];
for (const [src, data] of jobs) {
  const key = JSON.stringify([src, data]);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log = () => {};
  let ast, expect;
  try {
    ast = await parser.parse(183, src, structuredClone(lexicon));
    expect = await run(ast, data === undefined ? {} : structuredClone(data));
  } catch {
    expect = null;
  } finally {
    console.log = log;
  }
  if (expect === null) {
    console.warn(`skipped: ${src.slice(0, 100).replace(/\s+/g, " ")}`);
    continue;
  }
  cases.push(data === undefined ? { src, ast, expect } : { src, ast, data, expect });
}
writeFileSync(
  join(here, "cases.json"),
  "[\n" + cases.map((entry) => JSON.stringify(entry)).join(",\n") + "\n]\n",
);
console.log(
  `wrote ${cases.length} cases (${cases.filter((c) => c.expect.errors).length} with errors, ${
    cases.filter((c) => c.data !== undefined).length
  } with data)`,
);
process.exit(0);
