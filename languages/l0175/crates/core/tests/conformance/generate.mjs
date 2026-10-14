// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0175 is tested against, from the TypeScript L0175 in
// this directory (packages/core):
//
//   cases.json                        programs parsed with L0175's lexicon and compiled by
//                                     @graffiticode/l0175, with the AST and the result
//   collation.json                    strings in the order JavaScript's localeCompare puts them
//   ../../src/lexicon-additions.json  the words L0175 adds to the base lexicon
//   ../../src/targets.json            the per-target structure, from packages/core/src/targets.ts
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
const { TARGETS_DATA, STANDARD_FAMILIES } = await load("packages/core/dist/targets.js");
const { lexicon: base } = await load("node_modules/@graffiticode/l0000/dist/index.js");

// New words, and any base word this dialect redefines.
const additions = Object.fromEntries(
  Object.entries(lexicon).filter(
    ([word, entry]) => JSON.stringify(base[word]) !== JSON.stringify(entry),
  ),
);
writeFileSync(
  join(root, "crates/core/src/lexicon-additions.json"),
  JSON.stringify(additions, null, 2) + "\n",
);
const redefined = Object.keys(additions).filter((word) => word in base);
console.log(`redefines base words: ${redefined.join(", ") || "none"}`);

// targets.ts is the single source of truth for what a target allows; the Rust compiler reads
// this copy of it.
writeFileSync(
  join(root, "crates/core/src/targets.json"),
  JSON.stringify({ standardFamilies: STANDARD_FAMILIES, targets: TARGETS_DATA }, null, 2) + "\n",
);

// The order distractors and evidence are ranked in when their scores tie.
const ids = [
  ..."_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$ 0123456789aAbBzZ",
  ...[
    "c1",
    "c10",
    "c2",
    "C2",
    "c-2",
    "c_2",
    "c 2",
    "c.2",
    "d1",
    "D1",
    "d-1",
    "e",
    "E1",
    "e1",
    "e1a",
  ],
  ...[
    "claim-b",
    "claim_b",
    "claimB",
    "claimb",
    "Claim-A",
    "q",
    "Q",
    "q1",
    "q-1",
    "",
    "a",
    "ab",
    "aB",
    "Ab",
    "AB",
  ],
];
writeFileSync(
  join(here, "collation.json"),
  JSON.stringify(
    ids.sort((a, b) => a.localeCompare(b)),
    null,
    1,
  ) + "\n",
);

// --- programs --------------------------------------------------------------------------------

// The shipped examples: every target with every task model it offers.
const examplesDir = join(root, "packages/core/spec/examples");
const examples = readdirSync(examplesDir)
  .filter((file) => file.endsWith(".gc"))
  .sort()
  .map((file) => readFileSync(join(examplesDir, file), "utf8"));

// Each example again with something taken away or changed, for the errors and warnings.
const mutations = [
  (src) => src.replace(/\s+task-model tm\d/g, ""),
  (src) => src.replace(/\btype (ebsr|hot-text|short-text|multiple-choice|multi-select)\s+/g, ""),
  (src) => src.replace(/\s+rationale "(?:[^"\\]|\\.)*"/g, ""),
  (src) => src.replace(/\s+targets \[[^\]]*\]/g, ""),
  (src) => src.replace(/\s+focus (?:"[^"]*"|\[[^\]]*\])/g, ""),
  (src) => src.replace(/\s+stem "(?:[^"\\]|\\.)*"/g, ""),
  (src) => src.replace(/\s+stem-b "(?:[^"\\]|\\.)*"/g, ""),
  (src) => src.replace(/\s+dok r-dok\d/g, ""),
  (src) => src.replace(/\s+standard [a-z]+-\d[a-z]?/g, ""),
  (src) => src.replace(/\s+quote "(?:[^"\\]|\\.)*"/g, ""),
  (src) => src.replace(/\s+line \d+/g, ""),
  (src) => src.replace(/\s+cites \[[^\]]*\]/g, ""),
  (src) => src.replace(/\s+supports \[[^\]]*\]/g, ""),
  (src) => src.replace(/\s+plausibility [\d.]+/g, ""),
  (src) => src.replace(/\s+error-type [a-z-]+/g, ""),
  (src) => src.replace(/\bstatus directly-supports\b/g, "status irrelevant"),
  (src) => src.replace(/\bstatus supports-wrong-claim\b/g, "status irrelevant"),
  (src) => src.replace(/\bstatus irrelevant\b/, "status directly-supports"),
  (src) => src.replace(/\bstatus distractor\b/, "status supported"),
  (src) => src.replace(/\bstatus supported\b/, "status distractor"),
  (src) => src.replace(/\bstatus correct\b/g, "status distractor"),
  (src) => src.replace(/\bdimension [a-z-]+/, "dimension topic"),
  (src) => src.replace(/\btarget c1-t\d+\s*/, ""),
  (src) => src.replace(/\btarget c1-t\d+/, "target c1-t4"),
  (src) => src.replace(/\btarget c1-t\d+/, "target c1-t9"),
  (src) => src.replace(/\btarget c1-t\d+/, "target c1-t8"),
  (src) => src.replace(/\btarget c1-t\d+/, "target c1-t10"),
  (src) => src.replace(/\btype (literary|informational)\s*/, ""),
  (src) => src.replace(/\btype literary\b/, "type informational"),
  (src) => src.replace(/\btask-model tm\d/g, "task-model tm5"),
  (src) => src.replace(/\btask-model tm(\d)/g, (_, n) => `task-model tm${(Number(n) % 3) + 1}`),
  (src) => src.replace(/\bid "([a-z]+)\d+"/g, 'id "$1"'),
  (src) => src.replace(/\bid "/g, 'id "B'),
  (src) => src.replace(/\bid "[^"]*"\s*/g, ""),
  (src) => src.replace(/\boutcomes \[/, "grade 2 outcomes ["),
  (src) => src.replace(/\boutcomes \[/, 'grade "7" title "A title" outcomes ['),
  (src) => src.replace(/\blines \[[^\]]*\]/, "lines []"),
  (src) => src.replace(/\blines \[\s*("(?:[^"\\]|\\.)*")[^\]]*\]/, "lines [$1]"),
  (src) => src.replace(/\bevidence \[[\s\S]*?\n\]/, "evidence []"),
  (src) => src.replace(/\bclaims \[[\s\S]*?\n\]/, "claims []"),
  (src) => src.replace(/\bwords \[[\s\S]*?\n\]/, "words []"),
  (src) => src.replace(/\bmeanings \[[^\]]*\]/g, ""),
  (src) => src.replace(/\bmeaning ([^{]*\{\}),/, ""),
  // Two outcomes instead of one: the second repeats the first under another id.
  (src) =>
    src.replace(
      /(outcome id ")([^"]+)("[\s\S]*?\{\})(\s*\]\s*\{\}\.\.)/,
      (_, a, id, rest, tail) => `${a}${id}${rest}, ${a}${id}-again${rest}${tail}`,
    ),
  (src) =>
    src
      .replace(
        /(outcome id ")([^"]+)("[\s\S]*?\{\})(\s*\]\s*\{\}\.\.)/,
        (_, a, id, rest, tail) => `${a}${id}${rest}, ${a}${id}2${rest}${tail}`,
      )
      .replace(/targets \["([^"]+)"/g, 'targets ["$1" "$12"'),
];

// The pool the TypeScript suite composes from (packages/core/test/compose.spec.ts).
const PASSAGE = `target c1-t4 passage "The Tide Pool" type literary lines [
  "Mara crouched at the edge of the tide pool, ignoring the picnic behind her."
  "Her brother called twice, but she did not turn around."
  "A tiny crab scuttled under a rock, and Mara smiled for the first time all day."
  "She traced the cold water as if the pool were the only thing that mattered."
  "Five more minutes, she whispered, though no one was listening."
  "Behind her, paper plates rustled and her mother laughed."
]`;
const POOL = `claims [
  claim id "c1" status supported dimension character subject "Mara" standard rl-1 text "Mara cares more about the tide pool than the picnic." cites ["e1" "e2" "e3"] {},
  claim id "cb" status supported dimension character subject "the brother" text "The brother wants Mara's attention." cites ["e2"] {},
  claim id "c2" status distractor error-type misreads-detail plausibility 0.9 targets ["q1" "q3"] text "Mara is angry at her brother." rationale "Silence is absorption, not anger." cites ["e2"] {},
  claim id "c2b" status distractor error-type misreads-detail plausibility 0.3 targets ["q1" "q3"] text "Mara is upset with her family." rationale "Weak duplicate-ish foil." cites ["e2"] {},
  claim id "c3" status distractor error-type erroneous-inference targets ["q1" "q3"] text "Mara dislikes the outdoors." rationale "Contradicted by her smile." cites ["e4"] {},
  claim id "c4" status distractor error-type faulty-reasoning targets ["q1" "q3"] text "Mara fears her family." rationale "Whisper treated as fear." cites ["e4"] {},
  claim id "c5" status distractor error-type misreads-detail targets ["q1" "q3"] text "Mara is bored." rationale "Stillness is focus." cites ["e4"] {}
]
evidence [
  source id "e1" line 1 status directly-supports supports ["c1"] {},
  source id "e2" line 2 status supports-wrong-claim supports ["c1" "c2"] {},
  source id "e3" line 4 status directly-supports supports ["c1"] {},
  source id "e4" line 6 status irrelevant supports [] {}
]`;
const STEM_A = `stem "Which of these inferences about Mara is supported by the passage?"`;
const STEM_B = `stem-b "Which sentence(s) from the passage best support your answer in Part A?"`;
const Q1 = `outcome id "q1" type ebsr dimension character subject "Mara" standard rl-1 focus "c1" ${STEM_A} ${STEM_B} {}`;
const Q2 = `outcome id "q2" type short-text dimension character subject "Mara" standard rl-1 focus "c1" stem "What inference can be made about Mara? Explain using key details from the passage to support your answer." {}`;
const Q3 = `outcome id "q3" type hot-text dimension character subject "Mara" standard rl-1 focus "c1" stem "Click on the statement that best provides an inference about Mara that is supported by the passage." {}`;
// The pool's distractors are aimed at whichever questions the program asks.
const tide = (outcomes, pool = POOL, passage = PASSAGE) => {
  const asked = [...outcomes.matchAll(/outcome id "([^"]+)"/g)].map((found) => `"${found[1]}"`);
  const aimed = pool.replaceAll(
    'targets ["q1" "q3"]',
    `targets [${[...new Set(asked)].join(" ")}]`,
  );
  return `${passage}\n${aimed}\noutcomes [ ${outcomes} ]\n{}..`;
};

// Word Meanings: a word with meanings, and click-the-word candidates beside it.
const AQUEDUCT = [
  "The city built a long aqueduct to carry water from the hills.",
  "Workers dug a deep channel and lined it with smooth stone.",
  "When it rained, the ditch beside the road filled with mud.",
];
const meaningsOf = (words, outcome, lines = AQUEDUCT) =>
  `target c1-t10 passage "The City Aqueduct" type informational lines [${lines.map((line) => JSON.stringify(line)).join(" ")}]
words [ ${words} ]
outcomes [ outcome id "q1" dimension word-meaning subject "aqueduct" focus "w1" ${outcome} {} ]
{}..`;
const CLICK = 'task-model tm3 stem "Click the word that means a channel built to carry water."';
const MEANINGS = `meanings [
  meaning id "m1" status correct text "a channel built to carry water" rationale "The sentence says it carries water." {},
  meaning id "m2" status distractor error-type other-meaning text "a tall bridge" rationale "Bridges carry people." {},
  meaning id "m3" status distractor error-type misinterprets text "hills" rationale "Where the water comes from." {},
  meaning id "m4" status distractor error-type wrong-context text "a road" rationale "Not in this sentence." {},
  meaning id "m5" status distractor error-type wrong-context text "city" rationale "Who built it." {}
]`;

// A hot-text item over a passage, for the sentence splitter and the reading-level estimate.
const prose = (
  lines,
  evidence = 'source id "e1" line 1 status directly-supports supports ["c1"] {}',
) =>
  `target c1-t9 passage "Prose" type informational lines [${lines.map((line) => JSON.stringify(line)).join(" ")}]
claims [claim id "c1" status supported dimension central-idea text "The main idea." cites ["e1" "e2"] {}]
evidence [${evidence}]
outcomes [outcome id "q" task-model tm4 dimension central-idea focus "c1" stem "Click the sentences that show the main idea." {}]
{}..`;

const handwritten = [
  tide(`${Q1}, ${Q2}, ${Q3}`),
  tide(Q1),
  tide(Q2),
  tide(Q3),
  tide(`${Q3}, ${Q1}`),
  tide(Q1.replace('"q1"', '"q3"')),
  tide(`${Q1}, ${Q1}`),
  tide(Q1.replace("standard rl-1 ", "")),
  tide(Q1.replace("standard rl-1", "standard ri-1")),
  tide(Q1.replace("dimension character", "dimension theme")),
  tide(Q1.replace('focus "c1"', 'focus "cb"')),
  tide(Q1.replace('focus "c1"', 'focus "c2"')),
  tide(Q1.replace('focus "c1"', 'focus "nope"')),
  tide(Q1.replace('focus "c1"', 'focus ["c1" "cb"]')),
  tide(Q1.replace("type ebsr", "type multiple-choice")),
  tide(Q1.replace("type ebsr", "type essay")),
  tide(Q1.replace("type ebsr", "task-model tm1")),
  tide(Q1.replace("type ebsr", "type ebsr task-model tm2")),
  tide(Q1.replace("type ebsr", "type ebsr task-model tm9")),
  tide(Q1.replace("type ebsr", 'type ebsr dok r-dok1 mode inference other "x"')),
  tide(
    Q2.replace(
      "{}",
      'rubric [band score 2 descriptor "Full." {}, band score 0 descriptor "None." {}] {}',
    ),
  ),
  tide(Q2.replace("{}", 'rubric [band score "1" descriptor 5 {}, band {}] {}')),
  tide(Q2.replace("{}", "rubric [] {}")),
  tide(Q3.replace("Click on the statement", "Click on the sentences")),
  // a stem that gives the answer away, and a key that is much longer than its foils
  tide(
    Q1.replace(/stem "[^"]*"/, 'stem "Does Mara care more about the tide pool than the picnic?"'),
  ),
  tide(
    Q1,
    POOL.replace(
      "Mara cares more about the tide pool than the picnic.",
      "Mara cares far more about watching the small creatures of the tide pool than about joining her family at the picnic behind her.",
    ),
  ),
  // thin and duplicated pools
  tide(Q1, POOL.replace(/\n  claim id "c5"[^\n]*/, "").replace(/\{\},\n\]/, "{}\n]")),
  tide(Q1, POOL.replace("Mara is bored.", "Mara is ANGRY at her brother!")),
  tide(Q1, POOL.replace(/plausibility 0\.9/, "plausibility 1.5")),
  tide(Q1, POOL.replace(/plausibility 0\.9/, 'plausibility "high"')),
  tide(Q1, POOL.replace(/plausibility 0\.3/, "plausibility 0.9")),
  tide(Q1, POOL.replace(/ plausibility [\d.]+/g, "")),
  tide(
    Q1,
    POOL.replace(/ plausibility [\d.]+/g, "").replace(
      'claim id "c3" status distractor',
      'claim id "c3" status distractor dimension character',
    ),
  ),
  tide(Q1, POOL.replace(/error-type misreads-detail/g, "error-type faulty-reasoning")),
  tide(
    Q1,
    POOL.replace('id "c4"', 'id "C4"')
      .replace('id "c5"', 'id "c_5"')
      .replace('id "c3"', 'id "c-3"')
      .replace(/ plausibility [\d.]+/g, ""),
  ),
  tide(
    Q1,
    POOL.replace(
      'source id "e4" line 6 status irrelevant supports [] {}',
      'source id "e4" line 6 status irrelevant supports [] {},\n  source id "e5" line 3 status supports-wrong-claim supports ["c3"] rationale "Backs the wrong claim." {},\n  source id "E6" line 5 status irrelevant quote "Five more minutes" {},\n  source id "e7" line 9 status irrelevant {},\n  source id "e8" status irrelevant {}',
    ),
  ),
  tide(Q1, POOL.replace(/source id "e1" line 1/, 'source id "e1" line "1"')),
  tide(Q1, POOL.replace(/cites \["e1" "e2" "e3"\]/, 'cites ["e9"]')),
  tide(
    Q3,
    POOL.replace(
      /source id "e3" line 4 status directly-supports/,
      'source id "e3" quote "She traced the cold water" status directly-supports',
    ),
  ),
  tide(
    Q3,
    POOL.replace(
      /source id "e3" line 4 status directly-supports/,
      'source id "e3" line 4 status irrelevant',
    ),
  ),
  tide(Q1, POOL, PASSAGE.replace("target c1-t4", "target c1-t11")),
  tide(Q1, POOL, PASSAGE.replace("target c1-t4", "target c1-t99")),
  tide(Q1, POOL, PASSAGE.replace("type literary", "type poem")),
  tide(Q1, POOL, PASSAGE.replace('passage "The Tide Pool"', 'passage "  ¡The Tide—Pool!  "')),
  tide(Q1, POOL, PASSAGE.replace('passage "The Tide Pool" ', "")),
  tide(Q1, POOL, PASSAGE.replace("target c1-t4", "grade 0 target c1-t4")),
  tide(Q1, POOL, PASSAGE.replace("target c1-t4", "grade 3.5 target c1-t4")),
  tide(Q1, POOL, PASSAGE.replace("target c1-t4", "title 5 target c1-t4")),
  tide(
    Q1,
    POOL.replace(
      'source id "e2" line 2 status supports-wrong-claim supports ["c1" "c2"] {}',
      'source id "e2" line 2 status supports-wrong-claim supports ["zz"] {}',
    ),
  ),
  tide(Q1.replace('"q1"', '"q-other"') + ", " + Q3),
  tide(Q1, POOL.replace(/ targets \["q1" "q3"\]/, ' targets "q1"')),
  // a distractor that repeats the correct answer is dropped, and may leave the item short
  tide(
    Q1,
    POOL.replace(
      "Mara dislikes the outdoors.",
      "Mara cares more about the tide pool than the picnic!",
    ),
  ),
  tide(
    Q1,
    POOL.replace(
      "Mara dislikes the outdoors.",
      "Mara cares more about the tide pool than the picnic!",
    )
      .replace(/\n  claim id "(c5|c2b)"[^\n]*/g, "")
      .replace(/\{\},\n\]/, "{}\n]"),
  ),
  tide(
    Q1,
    POOL.replace(
      'source id "e4" line 6 status irrelevant supports [] {}',
      'source id "e4" line 6 status irrelevant supports [] {},\n  source id "e7" line 9 status irrelevant {},\n  source id "e8" line 0 status irrelevant {},\n  source id "e9" line 2.5 status irrelevant {},\n  source id "e10" line ebsr status irrelevant {}',
    ),
  ),
  tide(Q1, POOL, PASSAGE.replace("target c1-t4 ", "")),
  // sentence splitting and the reading-level estimate
  prose([
    "Mr. Ruiz never learned who had fixed his porch. He asked Dr. Lee at 9 a.m. on Main St. and got no answer.",
  ]),
  prose([
    '"Stop!" she cried. "Who is there?" No one answered... Then the door (the old one) creaked.',
  ]),
  prose([
    "J. K. Rowling wrote in the U.S. for a while. It was quiet there.",
    "No terminal punctuation here",
    "",
    "   ",
  ]),
  prose(
    ["One. Two! Three? Four.”  Five.’ Six.) Seven.] Eight"],
    'source id "e1" quote "Two!" status directly-supports {}, source id "e2" quote "three four" status directly-supports {}',
  ),
  prose(
    ["...Leading dots. etc. and so on. Prof. X vs. Y. No. 5 is here."],
    'source id "e1" line 1 quote "" status directly-supports {}',
  ),
  prose([
    "The municipal administration unanimously authorized an extraordinarily comprehensive infrastructure rehabilitation initiative, notwithstanding considerable opposition from numerous neighbourhood organizations and independent environmental consultants.",
    "Subsequently, the administration's representatives communicated the complicated implementation timetable to every participating organization.",
  ]),
  prose([
    "The cat sat. The dog ran. The sun was hot. We had fun. I like it. You do too. He is here. She is not.",
  ]),
  prose([
    "Rhythm isn't the same as time; she's seen the lake's edge, the horse, the cage and the tree.",
  ]),
  // word meanings
  meaningsOf(
    `word id "w1" text "aqueduct" line 1 ${MEANINGS} {}`,
    'task-model tm1 stem "What does aqueduct mean?"',
  ),
  meaningsOf(
    `word id "w1" text "aqueduct" line 1 ${MEANINGS} {}`,
    'task-model tm1 stem "Is an aqueduct a channel built to carry water?"',
  ),
  meaningsOf(
    `word id "w1" text "aqueduct" line 1 ${MEANINGS} {}`,
    'task-model tm2 stem "Choose two meanings."',
  ),
  meaningsOf(
    `word id "w1" text "aqueduct" line 1 ${MEANINGS.replace('status distractor error-type other-meaning text "a tall bridge" rationale "Bridges carry people."', 'status correct text "a waterway made by people" standard l-4a')} {}`,
    'task-model tm2 stem "Choose two meanings."',
  ),
  meaningsOf(`word id "w1" text "aqueduct" line 1 ${MEANINGS} {}`, CLICK),
  meaningsOf(
    `word id "w1" text "aqueduct" quote "a long aqueduct, they said" ${MEANINGS.replace(/"hills"|"city"/g, '"far away"')} {}`,
    CLICK,
  ),
  meaningsOf('word id "w1" text "aqueduct" line 1 {}', CLICK),
  meaningsOf('word id "w1" text "aqueduct" {}', CLICK),
  meaningsOf('word id "w1" text "viaduct" {}', CLICK),
  meaningsOf(
    'word id "w1" text "aqueduct" line 2 {}, word id "w2" text "channel" line 2 {}',
    CLICK,
  ),
  meaningsOf(
    'word id "w1" text "Aqueduct" line 1 {}, word id "w2" text "city" {}, word id "w3" text "ditch" targets ["q1" "q9"] {}, word id "w4" text "water" line 1 {}',
    CLICK,
  ),
  meaningsOf(
    'word id "w1" text "aqueduct" line 1 {}',
    'task-model tm3 stem "The city built a long aqueduct to carry water from the hills. Click the word."',
  ),
  meaningsOf('word id "w1" text "it" line 1 {}', CLICK, [
    "It — (was) 'so' wet... and the 2nd one, too!",
  ]),
  meaningsOf(
    'word id "w1" text "aqueduct" line 1 {}',
    CLICK.replace('"w1"', '"w9"').replace("task-model tm3", 'task-model tm3 focus "w9"'),
  ),
  // a chain that ends in a record literal instead of `{}` (the Rust reads the literal's fields)
  `${PASSAGE} claims [claim id "c1" status supported dimension character {text: "From a literal."}] outcomes [outcome id "q" type short-text dimension character focus "c1" stem "What can be inferred?" {}] {}..`,
  // degenerate programs
  "42..",
  "[1 2]..",
  "{}..",
  "target c1-t4 {}..",
  'target c1-t10 lines ["A line."] {}..',
  'passage 5 lines "x" {}..',
  'lines [1 true "three" ebsr] outcomes [] {}..',
  `${PASSAGE} outcomes [outcome {}] {}..`,
  `${PASSAGE} claims [claim {}] evidence [source {}] outcomes [] {}..`,
  `${PASSAGE} claims ["x" 5] evidence ["y"] outcomes [] {}..`,
  `${PASSAGE} claims [claim id "c" status distractor error-type nope targets [] {}] outcomes [] {}..`,
  `target c1-t10 passage "W" lines ["A line."] words [word {}, word id "w" text "t" meanings [meaning {}, meaning id "m" status nope {}] {}] outcomes [] {}..`,
  "outcomes..",
  "claim..",
  "nope 1..",
];

// Every mutation on every example is a large fixture for what it adds, so each mutation is
// applied to one example in five, a different five each time. `L0175_EVERY_MUTATION=1` writes
// them all, for a one-off run; do not commit that fixture.
const every = Boolean(process.env.L0175_EVERY_MUTATION);
const mutated = examples.flatMap((src, i) =>
  mutations
    .filter((_, j) => every || (i + j) % 5 === 0)
    .map((mutate) => mutate(src))
    .filter((out) => out !== src),
);
const programs = [...examples, ...mutated, ...handwritten];

function run(code) {
  const compiled = new Promise((resolve) =>
    compiler.compile(code, {}, {}, (err, val) => {
      const errors = (Array.isArray(err) ? err : []).filter(Boolean);
      // A thrown error arrives as its stack trace; the first line is the message.
      const messages = errors.map((e) => String(e.message ?? e).split("\n")[0]);
      // The text as well as the value: the order of an item's fields is part of what a
      // reader of the JSON sees.
      resolve(errors.length > 0 ? { errors: messages } : { text: JSON.stringify(val) });
    }),
  );
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 2000));
  return Promise.race([compiled, timeout]);
}

// The TypeScript compiler can throw from a timer; such a case times out and is skipped.
process.on("uncaughtException", () => {});

const log = console.log;
const seen = new Set();
const cases = [];
for (const src of programs) {
  if (seen.has(src)) continue;
  seen.add(src);
  console.log = () => {};
  console.error = () => {};
  let ast, expect;
  try {
    ast = await parser.parse(0, src, structuredClone(lexicon));
    expect = await run(ast);
  } catch (e) {
    expect = null;
  } finally {
    console.log = log;
  }
  if (expect === null) {
    console.warn(`skipped (never resumed): ${src.slice(0, 100).replace(/\s+/g, " ")}`);
    continue;
  }
  cases.push({ src, ast, expect });
}
writeFileSync(
  join(here, "cases.json"),
  "[\n" + cases.map((entry) => JSON.stringify(entry)).join(",\n") + "\n]\n",
);
const failed = cases.filter((c) => c.expect.errors).length;
console.log(`wrote ${cases.length} cases (${failed} with errors)`);
process.exit(0);
