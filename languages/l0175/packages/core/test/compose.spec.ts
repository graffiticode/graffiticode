// SPDX-License-Identifier: MIT
// Compose-engine regression tests. Parses .gc fixtures with @graffiticode/parser (a sibling
// repo in this workspace) and runs the built compiler. Run: `npm test` (builds core first).
//
// L0175 is item-first: each outcome carries a unique `id`, a `focus` (the correct claim), and an
// explicit `stem` (+ `stem-b` on EBSR); each distractor `targets` the question(s) it foils, and
// composition draws an item's foils ONLY from the distractors that target it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — sibling repo, plain JS, no types
import { parser } from "../../../../graffiticode/packages/parser/src/index.js";
import { lexicon, compiler } from "../dist/index.js";

async function compile(src: string): Promise<{ errors: any[]; data: any }> {
  const ast = await parser.parse("0175", src, lexicon);
  return new Promise((resolve) =>
    compiler.compile(ast, {}, {}, (err: any, data: any) =>
      resolve({ errors: Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [], data })),
  );
}

const PASSAGE = `target c1-t4 passage "The Tide Pool" type literary lines [
  "Mara crouched at the edge of the tide pool, ignoring the picnic behind her."
  "Her brother called twice, but she did not turn around."
  "A tiny crab scuttled under a rock, and Mara smiled for the first time all day."
  "She traced the cold water as if the pool were the only thing that mattered."
  "Five more minutes, she whispered, though no one was listening."
  "Behind her, paper plates rustled and her mother laughed."
]`;

// Five distinct distractors targeting q1/q3; c2 (misreads, plausibility 0.9) beats c2b/c5.
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

// Reusable, guideline-authored stems (the compiler no longer synthesizes these).
const STEM_A = `stem "Which of these inferences about Mara is supported by the passage?"`;
const STEM_B = `stem-b "Which sentence(s) from the passage best support your answer in Part A?"`;
const Q1 = `outcome id "q1" type ebsr dimension character subject "Mara" standard rl-1 focus "c1" ${STEM_A} ${STEM_B} {}`;
const Q2 = `outcome id "q2" type short-text dimension character subject "Mara" standard rl-1 focus "c1" stem "What inference can be made about Mara? Explain using key details from the passage to support your answer." {}`;
const Q3 = `outcome id "q3" type hot-text dimension character subject "Mara" standard rl-1 focus "c1" stem "Click on the statement that best provides an inference about Mara that is supported by the passage." {}`;

const prog = (outcomes: string) => `${PASSAGE}\n${POOL}\noutcomes [ ${outcomes} ]\n{}..`;
const one = async (outcome: string) => {
  const { errors, data } = await compile(prog(outcome));
  return { errors, item: data?.kind === "items" ? data.items[0] : data };
};

describe("compose — task models", () => {
  it("composes all three task models from one pool", async () => {
    const { errors, data } = await compile(prog(`${Q1}, ${Q2}, ${Q3}`));
    expect(errors).toHaveLength(0);
    expect(data.items.map((i: any) => i.type)).toEqual(["ebsr", "short-text", "hot-text"]);
  });

  it("EBSR Part A has 4 options with exactly one correct", async () => {
    const { item } = await one(Q1);
    expect(item.partA.options).toHaveLength(4);
    expect(item.partA.options.filter((o: any) => o.correct)).toHaveLength(1);
    expect(item.partB.options.filter((o: any) => o.correct)).toHaveLength(1);
  });

  it("Hot Text exposes one selectable sentence per paragraph and marks the directly-supporting ones", async () => {
    const { item } = await one(Q3);
    // PASSAGE lines are single sentences, so each paragraph yields one selectable unit "<lineId>.1".
    expect(item.selectable.map((s: any) => s.id)).toEqual(["1.1", "2.1", "3.1", "4.1", "5.1", "6.1"]);
    expect(item.selectable.filter((s: any) => s.correct).map((s: any) => s.id)).toEqual(["1.1", "4.1"]);
    expect(item.answerKey.partB).toBe("1.1, 4.1");
    // 2 valid sentences → exact count is one less (a proper subset): min(3, 2-1) = 1.
    expect(item.selectCount).toBe(1);
    expect(item.stem.partB).toBe("Click 1 sentence from the passage that supports your answer in Part A.");
  });

  it("Hot Text Part B asks for an exact count = one less than the valid sentences (capped at 3)", async () => {
    // One paragraph of 4 sentences; a no-quote directly-supports source marks all 4 valid.
    const FOUR = `target c1-t4 passage "P" type literary lines [
      "Mara watched the pool. She ignored the picnic. She traced the water. She smiled at a crab."
    ]
    claims [
      claim id "c1" status supported dimension character subject "Mara" text "Mara is focused on the pool." cites ["e1"] {},
      claim id "d1" status distractor error-type misreads-detail targets ["q1"] text "Mara is angry." rationale "r" cites ["e1"] {},
      claim id "d2" status distractor error-type erroneous-inference targets ["q1"] text "Mara dislikes the outdoors." rationale "r" cites ["e1"] {},
      claim id "d3" status distractor error-type faulty-reasoning targets ["q1"] text "Mara fears her brother." rationale "r" cites ["e1"] {}
    ]
    evidence [ source id "e1" line 1 status directly-supports supports ["c1"] {} ]
    outcomes [ outcome id "q1" type hot-text dimension character subject "Mara" standard rl-1 focus "c1" stem "Click on the statement that best provides an inference about Mara that is supported by the passage." {} ] {}..`;
    const { data } = await compile(FOUR);
    const item = data.kind === "items" ? data.items[0] : data;
    expect(item.selectable.filter((s: any) => s.correct)).toHaveLength(4); // V = 4
    expect(item.selectCount).toBe(3); // min(3, 4-1) = 3
    expect(item.stem.partB).toBe("Click 3 sentences from the passage that support your answer in Part A.");
  });

  it("Hot Text segments a multi-sentence paragraph and marks the quoted sentence, keeping paragraph grouping", async () => {
    const MULTI = `target c1-t4 passage "P" type literary lines [
      "Mara watched the tide pool. Her brother called twice, but she did not turn around."
      "She smiled at a small crab."
    ]
    claims [
      claim id "c1" status supported dimension character subject "Mara" text "Mara is focused on the pool." cites ["e1"] {},
      claim id "d1" status distractor error-type misreads-detail targets ["q1"] text "Mara is angry." rationale "r" cites ["e2"] {},
      claim id "d2" status distractor error-type erroneous-inference targets ["q1"] text "Mara dislikes the outdoors." rationale "r" cites ["e2"] {},
      claim id "d3" status distractor error-type faulty-reasoning targets ["q1"] text "Mara fears her brother." rationale "r" cites ["e2"] {}
    ]
    evidence [
      source id "e1" line 1 quote "Mara watched the tide pool." status directly-supports supports ["c1"] {},
      source id "e2" line 1 quote "Her brother called twice, but she did not turn around." status supports-wrong-claim supports ["c1" "d1"] {}
    ]
    outcomes [ outcome id "q1" type hot-text dimension character subject "Mara" standard rl-1 focus "c1" stem "Click on the statement that best provides an inference about Mara that is supported by the passage." {} ] {}..`;
    const { errors, data } = await compile(MULTI);
    expect(errors).toHaveLength(0);
    const item = data.kind === "items" ? data.items[0] : data;
    // Paragraph 1 splits into 2 sentences; paragraph 2 stays one — grouped by lineId.
    expect(item.selectable.map((s: any) => s.id)).toEqual(["1.1", "1.2", "2.1"]);
    expect(item.selectable.filter((s: any) => s.lineId === 1)).toHaveLength(2);
    // Only the sentence matching the directly-supporting quote is correct.
    expect(item.selectable.filter((s: any) => s.correct).map((s: any) => s.id)).toEqual(["1.1"]);
  });

  it("Short Text emits the authored prompt and a default 0/1/2 rubric, no distractors", async () => {
    const { item } = await one(Q2);
    expect(item.prompt).toMatch(/What inference can be made about Mara/);
    expect(item.rubric.map((r: any) => r.score)).toEqual([2, 1, 0]);
    expect(item.distractorAnalysis).toHaveLength(0);
  });

  it("Short Text carries no two-part lead-in (single answer box, not Part A/B)", async () => {
    const { item } = await one(Q2);
    expect(item.stem.leadIn).toBeUndefined();
    // EBSR and Hot Text, which do have two parts, still carry it.
    expect((await one(Q1)).item.stem.leadIn).toMatch(/two parts/);
    expect((await one(Q3)).item.stem.leadIn).toMatch(/two parts/);
  });
});

describe("compose — selection binds foils by `targets`", () => {
  it("draws an item's foils ONLY from distractors that target it (no dimension bleed)", async () => {
    // Two same-dimension questions with DISJOINT foil sets — the case the old dimension join broke.
    const src = `${PASSAGE}
      claims [
        claim id "c1" status supported dimension character subject "Mara" text "Mara prefers the tide pool to the picnic." cites ["e1" "e3"] {},
        claim id "cb" status supported dimension character subject "the brother" text "The brother wants Mara's attention." cites ["e2"] {},
        claim id "a1" status distractor error-type misreads-detail targets ["qA"] text "Mara is angry at her brother." rationale "r" cites ["e2"] {},
        claim id "a2" status distractor error-type erroneous-inference targets ["qA"] text "Mara dislikes the outdoors." rationale "r" cites ["e4"] {},
        claim id "a3" status distractor error-type faulty-reasoning targets ["qA"] text "Because Mara is quiet she must be upset." rationale "r" cites ["e2"] {},
        claim id "b1" status distractor error-type misreads-detail targets ["qB"] text "The brother is angry at Mara." rationale "r" cites ["e2"] {},
        claim id "b2" status distractor error-type erroneous-inference targets ["qB"] text "The brother wants to go home." rationale "r" cites ["e4"] {},
        claim id "b3" status distractor error-type faulty-reasoning targets ["qB"] text "Because the brother calls, he is in charge." rationale "r" cites ["e2"] {}
      ]
      evidence [
        source id "e1" line 1 status directly-supports supports ["c1"] {},
        source id "e2" line 2 status supports-wrong-claim supports ["c1" "a1"] {},
        source id "e3" line 4 status directly-supports supports ["c1"] {},
        source id "e4" line 6 status irrelevant supports [] {}
      ]
      outcomes [
        outcome id "qA" type ebsr dimension character subject "Mara" focus "c1" ${STEM_A} ${STEM_B} {},
        outcome id "qB" type ebsr dimension character subject "the brother" focus "cb" stem "Which of these inferences about the brother is supported by the passage?" ${STEM_B} {}
      ] {}..`;
    const { errors, data } = await compile(src);
    expect(errors).toHaveLength(0);
    const foils = (item: any) => item.distractorAnalysis.filter((d: any) => d.part === "A").map((d: any) => d.claimId).sort();
    const qA = data.items.find((i: any) => i.id.endsWith("qA"));
    const qB = data.items.find((i: any) => i.id.endsWith("qB"));
    expect(foils(qA)).toEqual(["a1", "a2", "a3"]);
    expect(foils(qB)).toEqual(["b1", "b2", "b3"]);
  });

  it("ranks the targeted distractors by plausibility (c2 0.9 wins the misreads slot)", async () => {
    const { item } = await one(Q1);
    const misreads = item.distractorAnalysis.find((d: any) => d.errorType === "misreads-detail");
    expect(misreads.claimId).toBe("c2");
    expect(misreads.plausibility).toBeGreaterThan(0.5);
  });

  it("uses the focus claim as the correct answer", async () => {
    const { item } = await one(Q1);
    expect(item.review.correctClaim.id).toBe("c1");
  });
});

describe("compose — hard errors (the item-first contract)", () => {
  const errs = async (mut: (s: string) => string) => (await compile(mut(prog(Q1)))).errors.map((e: any) => e.message);

  it("errors when a distractor has no targets", async () => {
    const m = await errs((s) => s.replace(`targets ["q1" "q3"] text "Mara is angry`, `text "Mara is angry`));
    expect(m.some((x) => /needs targets/.test(x))).toBe(true);
  });

  it("errors when an outcome is missing focus", async () => {
    const m = await errs((s) => s.replace(`focus "c1" ${STEM_A}`, STEM_A));
    expect(m.some((x) => /missing focus/.test(x))).toBe(true);
  });

  it("errors when an outcome is missing its stem", async () => {
    const m = await errs((s) => s.replace(` ${STEM_A}`, ``));
    expect(m.some((x) => /missing stem/.test(x))).toBe(true);
  });

  it("errors when an EBSR outcome is missing stem-b", async () => {
    const m = await errs((s) => s.replace(` ${STEM_B}`, ``));
    expect(m.some((x) => /Part B stem/.test(x))).toBe(true);
  });

  it("errors when focus points at a distractor, not a supported claim", async () => {
    const m = await errs((s) => s.replace(`focus "c1"`, `focus "c2"`));
    expect(m.some((x) => /must be a supported claim/.test(x))).toBe(true);
  });

  it("errors when targets names an unknown outcome", async () => {
    const m = await errs((s) => s.replace(`targets ["q1" "q3"]`, `targets ["qZ"]`));
    expect(m.some((x) => /targets unknown outcome/.test(x))).toBe(true);
  });

  it("errors when fewer than 3 distractors target an EBSR/Hot-Text outcome", async () => {
    // Strip every distractor's q1 binding except c2's → only 1 targets q1.
    const m = await errs((s) =>
      s.replaceAll(`targets ["q1" "q3"]`, `targets ["q3"]`).replace(`targets ["q3"] text "Mara is angry`, `targets ["q1"] text "Mara is angry`));
    expect(m.some((x) => /at least 3/.test(x))).toBe(true);
  });

  it("errors on a duplicate id", async () => {
    const m = await errs((s) => s.replace(`id "c2b"`, `id "c2"`));
    expect(m.some((x) => /Duplicate claim id/.test(x))).toBe(true);
  });

  it("errors (with coords) when a distractor lacks a rationale", async () => {
    const { errors } = await compile(prog(Q1).replace(`rationale "Silence is absorption, not anger." `, ``));
    const e = errors.find((x: any) => /needs a rationale/.test(x.message));
    expect(e).toBeTruthy();
    expect(typeof e.from).toBe("number");
  });
});

describe("compose — warnings (non-fatal)", () => {
  it("warns when fewer than 5 viable distractors target an outcome", async () => {
    const src = `${PASSAGE}
      claims [ claim id "c1" status supported dimension character text "correct inference here ok" cites ["e1"] {},
        claim id "d1" status distractor error-type misreads-detail targets ["q1"] text "foil a here ok" rationale "r" cites ["e2"] {},
        claim id "d2" status distractor error-type erroneous-inference targets ["q1"] text "foil b here ok" rationale "r" cites ["e2"] {},
        claim id "d3" status distractor error-type faulty-reasoning targets ["q1"] text "foil c here ok" rationale "r" cites ["e2"] {} ]
      evidence [ source id "e1" line 1 status directly-supports supports ["c1"] {},
        source id "e2" line 2 status irrelevant supports [] {} ]
      outcomes [ outcome id "q1" type ebsr dimension character subject "x" focus "c1" ${STEM_A} ${STEM_B} {} ] {}..`;
    const { errors, data } = await compile(src);
    expect(errors).toHaveLength(0); // 3 targeted foils → no hard error
    expect((data.warnings || []).some((w: string) => /viable distractor/.test(w))).toBe(true);
  });

  it("warns on a dangling cites reference", async () => {
    const src = prog(Q1).replace(`cites ["e1" "e2" "e3"]`, `cites ["e1" "e99"]`);
    const { data } = await compile(src);
    expect((data.warnings || []).some((w: string) => /e99/.test(w))).toBe(true);
  });

  // The correct claim is far longer/more detailed than its foils — the length giveaway.
  const lengthProg = (correctText: string, foilTexts: [string, string, string]) => `${PASSAGE}
    claims [ claim id "c1" status supported dimension character text "${correctText}" cites ["e1"] {},
      claim id "d1" status distractor error-type misreads-detail targets ["q1"] text "${foilTexts[0]}" rationale "r" cites ["e2"] {},
      claim id "d2" status distractor error-type erroneous-inference targets ["q1"] text "${foilTexts[1]}" rationale "r" cites ["e2"] {},
      claim id "d3" status distractor error-type faulty-reasoning targets ["q1"] text "${foilTexts[2]}" rationale "r" cites ["e2"] {} ]
    evidence [ source id "e1" line 1 status directly-supports supports ["c1"] {},
      source id "e2" line 2 status irrelevant supports [] {} ]
    outcomes [ outcome id "q1" type ebsr dimension character subject "x" focus "c1" ${STEM_A} ${STEM_B} {} ] {}..`;

  it("warns when the correct option is the longest and far longer than its foils", async () => {
    const src = lengthProg(
      "Mara values the quiet time she spends watching the tide pool far more than she values joining her family's picnic.",
      ["Mara is angry.", "Mara is bored.", "Mara is scared."],
    );
    const { errors, data } = await compile(src);
    expect(errors).toHaveLength(0);
    expect((data.warnings || []).some((w: string) => /length giveaway/.test(w))).toBe(true);
  });

  it("does not warn when Part A and Part B options are parallel in length", async () => {
    // Part A claim texts are comparable; Part B draws the correct line + foil lines of similar
    // length (passage lines 1/3/4/6), so neither part is a length outlier.
    const src = `${PASSAGE}
      claims [ claim id "c1" status supported dimension character text "Mara cares more about the tide pool than the family picnic." cites ["e1"] {},
        claim id "d1" status distractor error-type misreads-detail targets ["q1"] text "Mara is angry at her brother for calling her twice." rationale "r" cites ["e2"] {},
        claim id "d2" status distractor error-type erroneous-inference targets ["q1"] text "Mara feels bored by the long afternoon at the beach." rationale "r" cites ["e4"] {},
        claim id "d3" status distractor error-type faulty-reasoning targets ["q1"] text "Mara is scared of the crab she saw beneath the rock." rationale "r" cites ["e5"] {} ]
      evidence [ source id "e1" line 1 status directly-supports supports ["c1"] {},
        source id "e2" line 3 status supports-wrong-claim supports ["c1" "d1"] {},
        source id "e4" line 4 status irrelevant supports [] {},
        source id "e5" line 6 status irrelevant supports [] {} ]
      outcomes [ outcome id "q1" type ebsr dimension character subject "x" focus "c1" ${STEM_A} ${STEM_B} {} ] {}..`;
    const { errors, data } = await compile(src);
    expect(errors).toHaveLength(0);
    expect((data.warnings || []).some((w: string) => /length giveaway/.test(w))).toBe(false);
  });

  // A Hot Text stem that restates the correct claim's wording telegraphs the answer.
  const Q3_GIVEAWAY = `outcome id "q3" type hot-text dimension character subject "Mara" standard rl-1 focus "c1" stem "Click the sentence that shows Mara cares more about the tide pool than the picnic." {}`;

  it("warns when the Part A stem reuses the correct option's wording", async () => {
    const { item } = await one(Q3_GIVEAWAY);
    expect((item.warnings || []).some((w: string) => /stem reuses much of the correct option's wording/.test(w))).toBe(true);
  });

  it("does not warn when the stem is a neutral question (the catalog stems)", async () => {
    const { item } = await one(Q3); // "Click on the statement that best provides an inference about Mara…"
    expect((item.warnings || []).some((w: string) => /stem reuses/.test(w))).toBe(false);
  });

  // A Hot Text Part A stem that asks for passage sentences (Part B's job) instead of a statement.
  const Q3_SENTENCE_STEM = `outcome id "q3" type hot-text dimension character subject "Mara" standard rl-1 focus "c1" stem "Click on the two sentences from the passage that best show what Mara cares about." {}`;

  it("warns when a Hot Text Part A stem asks for sentences instead of the best statement", async () => {
    const { item } = await one(Q3_SENTENCE_STEM);
    expect((item.warnings || []).some((w: string) => /Part A must ask for the best STATEMENT/.test(w))).toBe(true);
  });

  it("does not warn when the Hot Text Part A stem is a 'statement' prompt", async () => {
    const { item } = await one(Q3); // "Click on the statement that best provides an inference…"
    expect((item.warnings || []).some((w: string) => /must ask for the best STATEMENT/.test(w))).toBe(false);
  });
});

describe("compose — stems are authored verbatim", () => {
  it("passes the authored Part A / Part B stems through unchanged", async () => {
    const { item } = await one(Q1);
    expect(item.stem.partA).toBe("Which of these inferences about Mara is supported by the passage?");
    expect(item.stem.partB).toBe("Which sentence(s) from the passage best support your answer in Part A?");
  });

  it("synthesizes the Hot-Text Part B instruction from the selection cap (no authored Part B stem)", async () => {
    const { item } = await one(Q3);
    expect(item.stem.partA).toMatch(/Click on the statement that best provides an inference about Mara/);
    expect(item.stem.partB).toMatch(/Click 1 sentence from the passage/); // Q3 has 2 valid → cap 1
  });
});

describe("compose — vocabulary", () => {
  it("authors a rubric via band and echoes a top-level title", async () => {
    const src = `title "My Assessment"
      ${PASSAGE}
      claims [ claim id "c1" status supported dimension character text "correct inference here ok" cites ["e1"] {} ]
      evidence [ source id "e1" line 1 status directly-supports supports ["c1"] {} ]
      outcomes [ outcome id "q1" type short-text dimension character subject "x" focus "c1"
        stem "What inference can be made about the character? Explain using key details."
        rubric [ band score 2 descriptor "Full." {}, band score 0 descriptor "None." {} ] {} ] {}..`;
    const { data } = await compile(src);
    expect(data.title).toBe("My Assessment");
    expect(data.rubric).toEqual([
      { score: 2, descriptor: "Full." },
      { score: 0, descriptor: "None." },
    ]);
  });
});

describe("compose — learning targets (parameterization)", () => {
  // An informational passage under Target 11 (RI standards, informational dimensions).
  const T11 = `target c1-t11 passage "Bridges" type informational lines [
      "Early bridges were simple logs laid across streams.",
      "As towns grew, builders needed stronger spans, so they turned to stone arches.",
      "The Romans perfected the arch, distributing weight outward to supports called piers.",
      "Centuries later, iron and then steel let engineers build far longer bridges.",
      "Suspension bridges hang the roadway from cables strung between tall towers.",
      "Each advance solved a problem the previous design could not."
    ]
    claims [
      claim id "c1" status supported dimension relationships-interactions subject "the bridge designs" text "Each new bridge design arose to solve a limitation of the earlier one." cites ["e1" "e3"] {},
      claim id "d1" status distractor error-type misreads-detail targets ["q1"] text "Stone arches replaced steel bridges over time." rationale "Reverses the order of developments." cites ["e2"] {},
      claim id "d2" status distractor error-type erroneous-inference targets ["q1"] text "The Romans invented the suspension bridge." rationale "Conflates two different advances." cites ["e3"] {},
      claim id "d3" status distractor error-type faulty-reasoning targets ["q1"] text "Because logs were used first, they were the strongest material." rationale "Treats earliest as strongest without support." cites ["e1"] {}
    ]
    evidence [
      source id "e1" line 1 status directly-supports supports ["c1"] {},
      source id "e2" line 2 status supports-wrong-claim supports ["c1" "d1"] {},
      source id "e3" line 3 status directly-supports supports ["c1"] {},
      source id "e4" line 6 status irrelevant supports [] {}
    ]
    outcomes [ outcome id "q1" type ebsr dimension relationships-interactions subject "the bridge designs" focus "c1"
      stem "Which of these inferences about the relationship between the bridge designs is supported by the passage?"
      stem-b "Which sentence(s) from the passage best support your answer in part A?" {} ] {}..`;

  it("composes a T11 item with RI standards and stamps the target", async () => {
    const r = await compile(T11);
    expect(r.errors).toHaveLength(0);
    const it0 = r.data.kind === "items" ? r.data.items[0] : r.data;
    expect(it0.target).toBe("c1-t11");
    expect(it0.standards).toContain("ri-1");
    expect(it0.standards).toContain("ri-3"); // relationships-interactions → ri-3
    expect(it0.standards).not.toContain("rl-1");
  });

  it("defaults to c1-t4 with a warning when `target` is omitted (keeps generation/back-compat working)", async () => {
    // Drop both the target and the now-mismatched T11 dimensions so the default-T4 profile validates.
    const noTarget = T11.replace("target c1-t11 ", "").replaceAll("relationships-interactions", "character");
    const { errors, data } = await compile(noTarget);
    expect(errors).toHaveLength(0);
    const it0 = data.kind === "items" ? data.items[0] : data;
    expect(it0.target).toBe("c1-t4");
    expect((it0.warnings || []).some((w: string) => /No target declared; defaulting to c1-t4/.test(w))).toBe(true);
  });

  it("errors on a non-target tag used as the target", async () => {
    // A truly-unknown tag is rejected by the parser; a registered-but-non-target tag (here the
    // dimension `theme`) reaches the compiler's target check.
    const { errors } = await compile(T11.replace("target c1-t11", "target theme"));
    expect(errors.some((e: any) => /unknown target 'theme'/.test(e.message))).toBe(true);
  });

  it("rejects a T4 dimension under T11", async () => {
    const { errors } = await compile(T11.replaceAll("relationships-interactions", "character"));
    expect(errors.some((e: any) => /invalid dimension 'character' for target c1-t11/.test(e.message))).toBe(true);
  });

  it("rejects an RL standard under T11", async () => {
    const { errors } = await compile(T11.replace(`focus "c1"`, `focus "c1" standard rl-3`));
    expect(errors.some((e: any) => /invalid standard 'rl-3' for target c1-t11/.test(e.message))).toBe(true);
  });

  it("warns (not errors) when the passage type mismatches the target", async () => {
    const { errors, data } = await compile(T11.replace("type informational", "type literary"));
    expect(errors).toHaveLength(0);
    const it0 = data.kind === "items" ? data.items[0] : data;
    expect((it0.warnings || []).some((w: string) => /expects an informational passage/.test(w))).toBe(true);
  });
});

describe("compose — Target 9 (Central Ideas) + Multiple-Choice / Multi-Select", () => {
  const item0 = (d: any) => (d.kind === "items" ? d.items[0] : d);
  const T9_PASSAGE = `target c1-t9 passage "Honeybees" type informational lines [
      "Honeybees live together in large groups called colonies. Worker bees gather nectar and build the hive. The queen bee lays all the eggs. By working together, the colony survives and grows."
    ]`;

  // Multiple Choice — pick the central idea; distractors use T9's significance taxonomy.
  const T9_MC = `${T9_PASSAGE}
    claims [
      claim id "c1" status supported dimension central-idea subject "the colony" text "Honeybees survive by living and working together, each bee with its own job." cites ["e1"] {},
      claim id "d1" status distractor error-type too-narrow targets ["q1"] text "The queen bee lays all the eggs." rationale "A true supporting detail, not the central idea." cites ["e1"] {},
      claim id "d2" status distractor error-type too-broad targets ["q1"] text "Insects are the most important animals on Earth." rationale "An overgeneralization beyond the passage." cites ["e1"] {},
      claim id "d3" status distractor error-type misreads-detail targets ["q1"] text "Each bee in the colony does every job by itself." rationale "Misreads the division of labor." cites ["e1"] {}
    ]
    evidence [ source id "e1" line 1 status directly-supports supports ["c1"] {} ]
    outcomes [ outcome id "q1" type multiple-choice dimension central-idea subject "the colony" standard ri-2 focus "c1" stem "Which sentence best shows the main idea of the passage?" {} ] {}..`;

  it("composes a Multiple-Choice item: 4 options, exactly one correct, RI-1+RI-2, DOK r-dok2", async () => {
    const { errors, data } = await compile(T9_MC);
    expect(errors).toHaveLength(0);
    const it0 = item0(data);
    expect(it0.target).toBe("c1-t9");
    expect(it0.type).toBe("multiple-choice");
    expect(it0.standards).toEqual(expect.arrayContaining(["ri-1", "ri-2"]));
    expect(it0.standards).not.toContain("rl-1");
    expect(it0.dok).toBe("r-dok2");
    expect(it0.choice.options).toHaveLength(4);
    expect(it0.choice.options.filter((o: any) => o.correct)).toHaveLength(1);
    expect(it0.answerKey.choice).toMatch(/^[A-D]$/);
  });

  // Multi-Select — choose the two sentences that belong in a summary; focus is the correct SET.
  const T9_MS = `${T9_PASSAGE}
    claims [
      claim id "s1" status supported dimension summary subject "the colony" text "Worker bees gather nectar and build the hive." cites ["e1"] {},
      claim id "s2" status supported dimension summary subject "the colony" text "The queen bee lays all the eggs." cites ["e1"] {},
      claim id "d1" status distractor error-type insignificant targets ["q1"] text "Bees are a kind of insect." rationale "True but too minor for a summary." cites ["e1"] {},
      claim id "d2" status distractor error-type too-broad targets ["q1"] text "All animals live in groups." rationale "Overgeneralization beyond the passage." cites ["e1"] {},
      claim id "d3" status distractor error-type misreads-detail targets ["q1"] text "The queen gathers all the nectar." rationale "Misreads who does which job." cites ["e1"] {},
      claim id "d4" status distractor error-type insignificant targets ["q1"] text "A hive is made of wax." rationale "Minor detail, not summary-worthy." cites ["e1"] {}
    ]
    evidence [ source id "e1" line 1 status directly-supports supports ["s1" "s2"] {} ]
    outcomes [ outcome id "q1" type multi-select dimension summary subject "the colony" standard ri-2 focus ["s1" "s2"] stem "Choose two sentences that should be included in a summary of the passage." {} ] {}..`;

  it("composes a Multi-Select item: the correct SET via focus list, answerKey.choices, selectCount", async () => {
    const { errors, data } = await compile(T9_MS);
    expect(errors).toHaveLength(0);
    const it0 = item0(data);
    expect(it0.type).toBe("multi-select");
    expect(it0.choice.options.length).toBeGreaterThanOrEqual(5);
    expect(it0.choice.options.filter((o: any) => o.correct)).toHaveLength(2);
    expect(it0.answerKey.choices).toHaveLength(2);
    expect(it0.selectCount).toBe(2);
    expect(it0.dok).toBe("r-dok2");
  });

  it("Short Text under T9 is DOK r-dok3; selected-response is r-dok2", async () => {
    const st = T9_MC
      .replace('type multiple-choice', 'type short-text')
      .replace('stem "Which sentence best shows the main idea of the passage?"', 'stem "Determine the main idea of the passage. Explain using key details from the passage to support your answer."');
    expect(item0((await compile(st)).data).dok).toBe("r-dok3");
  });

  it("uses T9's significance error taxonomy: accepts too-narrow, rejects an R&E error-type", async () => {
    // T9_MC already uses too-narrow/too-broad/misreads-detail and composes cleanly (above).
    const bad = T9_MC.replace("error-type too-broad", "error-type erroneous-inference");
    const { errors } = await compile(bad);
    expect(errors.some((e: any) => /valid error-type for target c1-t9/.test(e.message))).toBe(true);
  });

  it("rejects a T9 error-type under T11 (the taxonomy is per-target)", async () => {
    const bad = T9_MC
      .replace("target c1-t9", "target c1-t11")
      .replace("dimension central-idea", "dimension purpose").replace("dimension central-idea", "dimension purpose")
      .replace("standard ri-2", "standard ri-8")
      .replace("error-type too-narrow", "error-type misreads-detail"); // leave one valid-for-T11 + the rest still T9-only
    const { errors } = await compile(bad);
    expect(errors.some((e: any) => /valid error-type for target c1-t11/.test(e.message))).toBe(true);
  });

  it("multi-select requires at least 2 focus claims; single-focus items reject a list", async () => {
    const oneFocus = T9_MS.replace('focus ["s1" "s2"]', 'focus "s1"');
    expect((await compile(oneFocus)).errors.some((e: any) => /multi-select needs at least 2 focus/.test(e.message))).toBe(true);
    const listOnMc = T9_MC.replace('focus "c1"', 'focus ["c1" "d1"]');
    expect((await compile(listOnMc)).errors.some((e: any) => /takes a single focus claim/.test(e.message))).toBe(true);
  });

  // Hot Text (TM4): single-part "click the sentence(s) that show the main idea" — no Part A.
  const T9_HT = `target c1-t9 passage "Honeybees" type informational lines [
      "Honeybees live together in colonies. By working together, the whole colony survives. The queen lays the eggs."
    ]
    claims [ claim id "c1" status supported dimension central-idea subject "the colony" text "Honeybees survive by working together." cites ["e1" "e2"] {} ]
    evidence [
      source id "e1" line 1 quote "Honeybees live together in colonies." status directly-supports supports ["c1"] {},
      source id "e2" line 1 quote "By working together, the whole colony survives." status directly-supports supports ["c1"] {}
    ]
    outcomes [ outcome id "q1" type hot-text dimension central-idea subject "the colony" standard ri-2 focus "c1" stem "Click on the sentence(s) that best show the main idea of the passage." {} ] {}..`;

  it("composes a single-part Hot-Text item (TM4): a selectable passage, no Part A", async () => {
    const { errors, data } = await compile(T9_HT);
    expect(errors).toHaveLength(0);
    const it0 = item0(data);
    expect(it0.target).toBe("c1-t9");
    expect(it0.type).toBe("hot-text");
    expect(it0.dok).toBe("r-dok2");
    expect(it0.partA).toBeUndefined(); // single-part
    expect(it0.stem.partB).toBeUndefined();
    expect(it0.stem.partA).toMatch(/Click on the sentence/);
    expect(it0.selectable.filter((s: any) => s.correct).map((s: any) => s.id)).toEqual(["1.1", "1.2"]);
    expect(it0.answerKey.partB).toBe("1.1, 1.2");
  });
});

describe("compose — Target 8 (Key Details): evidence selection", () => {
  const item0 = (d: any) => (d.kind === "items" ? d.items[0] : d);
  // T8: the inference is GIVEN in the stem; the options are passage EVIDENCE. One supported claim
  // (the given inference) + sources: directly-supports = correct evidence, irrelevant = foils.
  const T8 = (outcome: string) => `target c1-t8 passage "Aqueducts" type informational lines [
      "Roman aqueducts carried water across long distances. They used gentle slopes so water flowed by gravity. Arches held the channels high above valleys. Cities far from rivers could finally get fresh water."
    ]
    claims [
      claim id "c1" status supported dimension supporting-evidence subject "the aqueducts" text "Roman aqueducts let cities far from rivers get fresh water." cites ["e1" "e2"] {}
    ]
    evidence [
      source id "e1" line 1 quote "Cities far from rivers could finally get fresh water." status directly-supports supports ["c1"] {},
      source id "e2" line 1 quote "Roman aqueducts carried water across long distances." status directly-supports supports ["c1"] {},
      source id "e3" line 1 quote "They used gentle slopes so water flowed by gravity." status irrelevant supports [] {},
      source id "e4" line 1 quote "Arches held the channels high above valleys." status irrelevant supports [] {},
      source id "e5" line 1 quote "Roman builders mixed strong concrete." status irrelevant supports [] {}
    ]
    outcomes [ ${outcome} ] {}..`;
  const MC = `outcome id "q1" type multiple-choice dimension supporting-evidence subject "the aqueducts" standard ri-7 focus "c1" stem "Roman aqueducts let far-off cities get fresh water. Which detail from the passage best supports this conclusion?" {}`;
  const MS = `outcome id "q1" type multi-select dimension supporting-evidence subject "the aqueducts" standard ri-7 focus "c1" stem "Which two details from the passage best support the idea that aqueducts brought water to distant cities? Select two answers." {}`;
  const HT = `outcome id "q1" type hot-text dimension supporting-evidence subject "the aqueducts" standard ri-7 focus "c1" stem "Aqueducts brought water to distant cities. Click the sentence(s) from the passage that support this." {}`;

  it("Multiple-Choice draws evidence options (1 correct source), RI-1+RI-7, DOK r-dok2", async () => {
    const { errors, data } = await compile(T8(MC));
    expect(errors).toHaveLength(0);
    const it0 = item0(data);
    expect(it0.target).toBe("c1-t8");
    expect(it0.standards).toEqual(expect.arrayContaining(["ri-1", "ri-7"]));
    expect(it0.dok).toBe("r-dok2");
    expect(it0.choice.options).toHaveLength(4);
    expect(it0.choice.options.filter((o: any) => o.correct)).toHaveLength(1);
    // the correct option is an evidence excerpt (a source quote), not the inference statement
    expect(it0.choice.options.find((o: any) => o.correct).text).toMatch(/Cities far from rivers|Roman aqueducts carried/);
    expect(it0.answerKey.choice).toMatch(/^[A-D]$/);
  });

  it("Multi-Select takes the directly-supporting sources as the correct set", async () => {
    const it0 = item0((await compile(T8(MS))).data);
    expect(it0.type).toBe("multi-select");
    expect(it0.choice.options.filter((o: any) => o.correct)).toHaveLength(2);
    expect(it0.answerKey.choices).toHaveLength(2);
    expect(it0.selectCount).toBe(2);
  });

  it("Hot-Text is single-part: a selectable passage, no Part A", async () => {
    const it0 = item0((await compile(T8(HT))).data);
    expect(it0.partA).toBeUndefined();
    expect(it0.stem.partB).toBeUndefined();
    expect(it0.stem.partA).toMatch(/Click the sentence/);
    expect(it0.selectable.filter((s: any) => s.correct).length).toBeGreaterThanOrEqual(1);
    expect(it0.answerKey.partB).toBeTruthy();
  });

  it("restricts item types per target: T8 rejects ebsr; T4 rejects multiple-choice", async () => {
    const ebsrOnT8 = T8(MC).replace("type multiple-choice", "type ebsr");
    expect((await compile(ebsrOnT8)).errors.some((e: any) => /item type 'ebsr' is not available for target c1-t8/.test(e.message))).toBe(true);
    const mcOnT4 = `target c1-t4 passage "P" type literary lines [ "A cat sat. It purred." ] claims [ claim id "c1" status supported dimension character subject "the cat" text "The cat is content." cites ["e1"] {} ] evidence [ source id "e1" line 1 status directly-supports supports ["c1"] {} ] outcomes [ outcome id "q1" type multiple-choice dimension character subject "the cat" focus "c1" stem "Which inference is supported?" {} ] {}..`;
    expect((await compile(mcOnT4)).errors.some((e: any) => /item type 'multiple-choice' is not available for target c1-t4/.test(e.message))).toBe(true);
  });
});

describe("compose — Target 2 (Central Ideas, literary): theme + scoped summary", () => {
  const item0 = (d: any) => (d.kind === "items" ? d.items[0] : d);
  // T2 is the literary twin of T9 and the only other target offering all five item types. Its own
  // facts: THEME is a first-class dimension (RL-2), every dimension answers to rl-2 so standards
  // compose to exactly ["rl-1", "rl-2"], and summary is scoped to a key event, never the whole text.
  const T2 = (outcome: string, claims = CLAIMS) => `target c1-t2 passage "The Blue Ribbon" type literary lines [
      "Every spring, Tessa entered her drawing in the county fair."
      "This year she almost did not enter at all."
      "Tessa drew the same barn eleven times before she kept one."
      "At the fair, the blue ribbon went to somebody else."
      "Then a teacher asked to hang Tessa's drawing in the hall."
    ]
    ${claims}
    evidence [
      source id "e3" line 3 status directly-supports supports ["c1"] quote "Tessa drew the same barn eleven times before she kept one." {},
      source id "e5" line 5 status directly-supports supports ["c1"] quote "Then a teacher asked to hang Tessa's drawing in the hall." {},
      source id "e1" line 1 status supports-wrong-claim supports ["c1" "d1"] quote "Every spring, Tessa entered her drawing in the county fair." {},
      source id "e2" line 2 status supports-wrong-claim supports ["c1" "d3"] quote "This year she almost did not enter at all." {},
      source id "e4" line 4 status irrelevant supports [] quote "At the fair, the blue ribbon went to somebody else." {}
    ]
    outcomes [ ${outcome} ] {}..`;
  const CLAIMS = `claims [
      claim id "c1" status supported dimension theme subject "Tessa" text "Keeping at something can matter more than winning." cites ["e3" "e5"] {},
      claim id "d1" status distractor error-type too-narrow targets ["q1"] text "Tessa entered the county fair every single spring." rationale "A true detail, not the theme." cites ["e1"] {},
      claim id "d2" status distractor error-type too-broad targets ["q1"] text "Hard work always makes a person famous someday." rationale "Overgeneralizes past the story." cites ["e5"] {},
      claim id "d3" status distractor error-type misreads-detail targets ["q1"] text "Tessa gave up drawing after she lost again." rationale "Misreads the ending." cites ["e2"] {},
      claim id "d4" status distractor error-type insignificant targets ["q1"] text "Tessa's grandmother owned more than one pencil." rationale "Too trivial to carry a theme." cites ["e1"] {}
    ]`;
  const THEME = (t: string, tm: string, extra = "") =>
    `outcome id "q1" type ${t} task-model ${tm} dimension theme subject "Tessa" focus "c1" stem "Which sentence best tells the theme of the passage?" ${extra} {}`;

  it("standards compose to exactly rl-1 + rl-2 — every dimension answers to the theme standard", async () => {
    const { errors, data } = await compile(T2(THEME("multiple-choice", "tm1")));
    expect(errors).toHaveLength(0);
    const it0 = item0(data);
    expect(it0.target).toBe("c1-t2");
    expect(it0.standards).toEqual(["rl-1", "rl-2"]);
    expect(it0.dok).toBe("r-dok2");
    expect(it0.choice.options.filter((o: any) => o.correct)).toHaveLength(1);
  });

  it("offers all five item types — tm3 is EBSR here, not hot-text as in T1/T8/T10", async () => {
    const { errors, data } = await compile(
      T2(THEME("ebsr", "tm3", `stem-b "Which sentence from the passage best supports your answer in Part A?"`)),
    );
    expect(errors).toHaveLength(0);
    expect(item0(data).partA).toBeDefined(); // two-part, unlike the single-part hot-text targets
    // the same number means hot-text on the Key Details / Word Meanings targets
    const mismatch = await compile(T2(THEME("hot-text", "tm3")));
    expect(mismatch.errors.map((e: any) => e.message).join("\n")).toMatch(/task model 'tm3' is ebsr for target c1-t2, but type is 'hot-text'/);
  });

  it("short-text bumps DOK to r-dok3; selected-response stays r-dok2", async () => {
    const st = `outcome id "q1" type short-text task-model tm5 dimension summary subject "the fair" focus "c1" stem "Summarize what happens after the blue ribbon goes to somebody else. Use key details from the passage in your summary." {}`;
    const claims = `claims [ claim id "c1" status supported dimension summary subject "the fair" text "A teacher asked to hang Tessa's drawing in the hall." cites ["e3" "e5"] {} ]`;
    const { errors, data } = await compile(T2(st, claims));
    expect(errors).toHaveLength(0);
    expect(item0(data).dok).toBe("r-dok3");
  });

  it("hot-text is single-part (click the sentences that show the theme)", async () => {
    const ht = `outcome id "q1" type hot-text task-model tm4 dimension theme subject "Tessa" focus "c1" stem "Click on the two sentences that best show the theme of the story." {}`;
    const claims = `claims [ claim id "c1" status supported dimension theme subject "Tessa" text "Keeping at something can matter more than winning." cites ["e3" "e5"] {} ]`;
    const it0 = item0((await compile(T2(ht, claims))).data);
    expect(it0.partA).toBeUndefined();
    expect(it0.selectable.filter((s: any) => s.correct)).toHaveLength(2);
  });

  it("takes the significance taxonomy, and rejects an R&E error type", async () => {
    const bad = CLAIMS.replace("error-type too-narrow", "error-type faulty-reasoning");
    const { errors } = await compile(T2(THEME("multiple-choice", "tm1"), bad));
    expect(errors.map((e: any) => e.message).join("\n")).toMatch(
      /distractor needs a valid error-type for target c1-t2 \(too-narrow, too-broad, misreads-detail, insignificant\)/,
    );
  });

  it("rejects a T9 dimension: `theme` is T2's, and T2 has no informational vocabulary", async () => {
    const bad = CLAIMS.replace(/dimension theme/g, "dimension relationships-interactions");
    const { errors } = await compile(
      T2(THEME("multiple-choice", "tm1").replace("dimension theme", "dimension relationships-interactions"), bad),
    );
    expect(errors.map((e: any) => e.message).join("\n")).toMatch(/relationships-interactions/);
  });
});

describe("compose — Target 1 (Key Details, literary): evidence selection", () => {
  const item0 = (d: any) => (d.kind === "items" ? d.items[0] : d);
  // T1 is the LITERARY mirror of T8: the inference is GIVEN in the stem and the options are passage
  // evidence. The T1-specific fact is its standards — the guideline lists RL-1 and nothing else, so
  // an item's `standards` is exactly ["rl-1"] (T8 adds the RI-7 companion).
  const T1 = (outcome: string) => `target c1-t1 passage "The Loose Board" type literary lines [
      "Nina had walked past Mr. Ruiz's crooked porch a hundred times. The third board rocked under her feet every time she crossed it. On Saturday she stopped, because someone had left a hammer on the step. Then she knelt down and set the first nail without anyone asking her to. Mr. Ruiz never learned who had fixed his porch."
    ]
    claims [
      claim id "c1" status supported dimension supporting-evidence subject "Nina" text "Nina takes care of a problem on her own, without being told to." cites ["e1" "e2"] {}
    ]
    evidence [
      source id "e1" line 1 quote "Then she knelt down and set the first nail without anyone asking her to." status directly-supports supports ["c1"] {},
      source id "e2" line 1 quote "Mr. Ruiz never learned who had fixed his porch." status directly-supports supports ["c1"] {},
      source id "e3" line 1 quote "The third board rocked under her feet every time she crossed it." status irrelevant supports [] {},
      source id "e4" line 1 quote "On Saturday she stopped, because someone had left a hammer on the step." status irrelevant supports [] {},
      source id "e5" line 1 quote "Nina had walked past Mr. Ruiz's crooked porch a hundred times." status irrelevant supports [] {}
    ]
    outcomes [ ${outcome} ] {}..`;
  const MC = `outcome id "q1" type multiple-choice dimension supporting-evidence subject "Nina" focus "c1" stem "The reader can conclude that Nina takes care of a problem on her own. Which line from the passage best supports this conclusion?" {}`;
  const MS = `outcome id "q1" type multi-select dimension supporting-evidence subject "Nina" focus "c1" stem "Which two lines from the passage best support the conclusion that Nina acts without being told? Select two answers." {}`;
  const HT = `outcome id "q1" type hot-text dimension supporting-evidence subject "Nina" focus "c1" stem "Nina acts without being told. Click the two sentences from the passage that best support this conclusion." {}`;

  it("Multiple-Choice draws evidence options; standards are RL-1 ALONE (no companion), DOK r-dok2", async () => {
    const { errors, data } = await compile(T1(MC));
    expect(errors).toHaveLength(0);
    const it0 = item0(data);
    expect(it0.target).toBe("c1-t1");
    expect(it0.standards).toEqual(["rl-1"]); // the whole of T1's standard list — not ["rl-1", …]
    expect(it0.dok).toBe("r-dok2");
    expect(it0.choice.options).toHaveLength(4);
    expect(it0.choice.options.filter((o: any) => o.correct)).toHaveLength(1);
    // the correct option is an evidence excerpt (a source quote), not the inference statement
    expect(it0.choice.options.find((o: any) => o.correct).text).toMatch(/set the first nail|never learned who/);
  });

  it("Multi-Select takes the directly-supporting sources as the correct set", async () => {
    const it0 = item0((await compile(T1(MS))).data);
    expect(it0.type).toBe("multi-select");
    expect(it0.choice.options.filter((o: any) => o.correct)).toHaveLength(2);
    expect(it0.selectCount).toBe(2);
  });

  it("Hot-Text is single-part, and an honorific does not split a sentence in two", async () => {
    const it0 = item0((await compile(T1(HT))).data);
    expect(it0.partA).toBeUndefined();
    expect(it0.stem.partB).toBeUndefined();
    // "Mr. Ruiz never learned…" stays ONE selectable sentence — a bare [.!?] split would have made
    // "Mr." its own clickable option and put a phantom id in the answer key.
    expect(it0.selectable.map((s: any) => s.text)).toContain("Mr. Ruiz never learned who had fixed his porch.");
    expect(it0.selectable.some((s: any) => s.text === "Mr.")).toBe(false);
    expect(it0.selectable.filter((s: any) => s.correct)).toHaveLength(2);
    expect(it0.answerKey.partB.split(", ")).toHaveLength(2);
  });

  it("restricts item types: T1 offers only MC / MS / Hot-Text (no ebsr, no short-text)", async () => {
    for (const bad of ["ebsr", "short-text"]) {
      const src = T1(MC).replace("type multiple-choice", `type ${bad}`);
      const { errors } = await compile(src);
      expect(errors.some((e: any) => new RegExp(`item type '${bad}' is not available for target c1-t1`).test(e.message))).toBe(true);
    }
  });
});

describe("compose — Target 10 (Word Meanings): meaning selection", () => {
  const item0 = (d: any) => (d.kind === "items" ? d.items[0] : d);
  // T10: the answer choices are MEANINGS of a targeted `word`; correct meaning(s) + distractor
  // meanings (with T10 error-types). Multi-Select needs ≥2 correct meanings.
  const T10 = (outcome: string, words = WORDS) => `target c1-t10 passage "Aqueducts" type informational lines [
      "Roman engineers built aqueducts. The aqueduct carried water across long distances."
    ]
    ${words}
    outcomes [ ${outcome} ] {}..`;
  const WORDS = `words [
      word id "w1" text "aqueduct" line 1 quote "The aqueduct carried water across long distances."
        meanings [
          meaning id "m1" status correct text "a channel built to carry water" {},
          meaning id "m2" status distractor error-type other-meaning text "a boat that carries cargo" rationale "another meaning, ignores context" {},
          meaning id "m3" status distractor error-type misinterprets text "a tall stone tower" rationale "misreads the sentence" {},
          meaning id "m4" status distractor error-type wrong-context text "a kind of road" rationale "uses the wrong context" {}
        ] {}
    ]`;
  const MC = `outcome id "q1" type multiple-choice dimension word-meaning subject "aqueduct" standard l-4a focus "w1" stem "Read the sentence: \\"The aqueduct carried water across long distances.\\" What does the word aqueduct most likely mean?" {}`;

  it("Multiple-Choice draws meaning options (1 correct), RI-4 + L-4, DOK r-dok2", async () => {
    const { errors, data } = await compile(T10(MC));
    expect(errors).toHaveLength(0);
    const it0 = item0(data);
    expect(it0.target).toBe("c1-t10");
    expect(it0.standards).toEqual(expect.arrayContaining(["ri-4", "l-4a"])); // base ri-4 + authored l-4a
    expect(it0.dok).toBe("r-dok2");
    expect(it0.choice.options).toHaveLength(4);
    expect(it0.choice.options.filter((o: any) => o.correct)).toHaveLength(1);
    expect(it0.choice.options.find((o: any) => o.correct).text).toBe("a channel built to carry water");
    expect(it0.word.text).toBe("aqueduct");
    expect(it0.answerKey.choice).toMatch(/^[A-D]$/);
  });

  it("Multi-Select takes the correct meanings as the set (needs ≥2 correct)", async () => {
    const words2 = WORDS.replace('meaning id "m2" status distractor error-type other-meaning text "a boat that carries cargo" rationale "another meaning, ignores context" {}',
      'meaning id "m2" status correct text "a water channel" {}');
    const MS = `outcome id "q1" type multi-select dimension word-meaning subject "aqueduct" standard l-5c focus "w1" stem "What does the word aqueduct most likely mean? Choose two answers." {}`;
    const it0 = item0((await compile(T10(MS, words2))).data);
    expect(it0.type).toBe("multi-select");
    expect(it0.choice.options.filter((o: any) => o.correct)).toHaveLength(2);
    expect(it0.answerKey.choices).toHaveLength(2);
    expect(it0.selectCount).toBe(2);
  });

  it("validates words: a word needs a correct meaning and a distractor; rejects a bad T10 error-type", async () => {
    const noCorrect = WORDS.replace('status correct text "a channel built to carry water"', 'status distractor error-type misinterprets text "a channel built to carry water" rationale "r"');
    expect((await compile(T10(MC, noCorrect))).errors.some((e: any) => /needs at least one meaning with status correct/.test(e.message))).toBe(true);
    const badType = WORDS.replace("error-type other-meaning", "error-type faulty-reasoning");
    expect((await compile(T10(MC, badType))).errors.some((e: any) => /valid error-type for target c1-t10/.test(e.message))).toBe(true);
  });

  it("restricts item types: T10 rejects ebsr / short-text", async () => {
    expect((await compile(T10(MC.replace("type multiple-choice", "type ebsr")))).errors.some((e: any) => /item type 'ebsr' is not available for target c1-t10/.test(e.message))).toBe(true);
    expect((await compile(T10(MC.replace("type multiple-choice", "type short-text")))).errors.some((e: any) => /item type 'short-text' is not available for target c1-t10/.test(e.message))).toBe(true);
  });

  // Task Model 3 — click the word. The excerpt is the PARAGRAPH containing the focus word; the
  // clickable CANDIDATES are the authored words in that paragraph (focus = correct). (Passage line 1
  // is "Roman engineers built aqueducts. The aqueduct carried water across long distances.")
  const HT = `outcome id "q1" type hot-text dimension word-meaning subject "aqueduct" standard l-4c focus "w1" stem "Read the paragraph below. Click the word that means a channel that carries water." {}`;

  it("curated: only the authored candidate words in the paragraph are clickable, focus is correct", async () => {
    const words = `words [ word id "w1" text "aqueduct" line 1 {}, word id "w2" text "engineers" {}, word id "w3" text "water" {} ]`;
    const { errors, data } = await compile(T10(HT, words));
    expect(errors).toHaveLength(0);
    const it0 = item0(data);
    expect(it0.type).toBe("hot-text");
    expect(it0.partA).toBeUndefined();
    expect(it0.wordSelect.excerpt).toMatch(/^Roman engineers built aqueducts\./); // the full paragraph
    const sel = it0.wordSelect.tokens.filter((t: any) => t.selectable).map((t: any) => t.text);
    expect(sel.sort()).toEqual(["aqueduct", "engineers", "water"]); // exactly the authored candidates
    expect(sel).not.toContain("built"); // a content word but not an authored candidate
    const correct = it0.wordSelect.tokens.filter((t: any) => t.correct);
    expect(correct).toHaveLength(1);
    expect(correct[0].text).toBe("aqueduct");
    expect(it0.answerKey.word).toBe("aqueduct");
  });

  it("fallback: with only the correct word authored, every content word is clickable", async () => {
    const it0 = item0((await compile(T10(HT, `words [ word id "w1" text "aqueduct" line 1 {} ]`))).data);
    const sel = it0.wordSelect.tokens.filter((t: any) => t.selectable).map((t: any) => t.text);
    expect(sel).toEqual(expect.arrayContaining(["aqueduct", "engineers", "carried", "water", "across"]));
    expect(sel).not.toContain("The");
    expect(it0.wordSelect.tokens.filter((t: any) => t.correct)).toHaveLength(1);
  });

  it("meaning-derived candidates: single-word distractor meanings in the paragraph become the choices", async () => {
    // The generator sometimes authors the click candidates as the focus word's distractor MEANINGS
    // (the MC/MS shape) instead of separate `word`s. Single-word meaning texts present in the
    // paragraph are the candidates; the multi-word correct definition is ignored (no fallback).
    const words = `words [ word id "w1" text "aqueduct" line 1
      meanings [
        meaning id "m1" status correct text "a channel that carries water" {},
        meaning id "m2" status distractor error-type other-meaning text "engineers" rationale "a nearby word, not the meaning" {},
        meaning id "m3" status distractor error-type misinterprets text "distances" rationale "a nearby word, not the meaning" {}
      ] {} ]`;
    const it0 = item0((await compile(T10(HT, words))).data);
    const sel = it0.wordSelect.tokens.filter((t: any) => t.selectable).map((t: any) => t.text);
    expect(sel.sort()).toEqual(["aqueduct", "distances", "engineers"]); // exactly correct + the 2 meaning-words
    expect(sel).not.toContain("built"); // NOT the all-content-words fallback
    expect(sel).not.toContain("water");
    const correct = it0.wordSelect.tokens.filter((t: any) => t.correct);
    expect(correct).toHaveLength(1);
    expect(correct[0].text).toBe("aqueduct");
  });

  it("warns when an authored candidate word is not in the correct word's paragraph", async () => {
    const words = `words [ word id "w1" text "aqueduct" line 1 {}, word id "w2" text "vessels" {} ]`;
    const it0 = item0((await compile(T10(HT, words))).data);
    expect((it0.warnings || []).some((w: string) => /"vessels".*not in the correct word's paragraph/.test(w))).toBe(true);
  });

  it("warns when the stem contains the excerpt (the passage was pasted into the stem)", async () => {
    const bloated = HT.replace(
      'that carries water."',
      'that carries water. Roman engineers built aqueducts. The aqueduct carried water across long distances."',
    );
    const { data } = await compile(T10(bloated, `words [ word id "w1" text "aqueduct" line 1 {} ]`));
    expect((item0(data).warnings || []).some((w: string) => /stem should be just the instruction/.test(w))).toBe(true);
  });
});

describe("compose — grade level & readability", () => {
  // A deliberately above-grade passage: long sentences, abstract/academic vocabulary. Self-
  // contained (claims/evidence reference only line 1) so the only warning under test is readability.
  const DENSE = `target c1-t4 passage "The Tide Pool" type literary lines [
      "Crouched at the littoral margin, Mara remained ostensibly impervious to the convivial picnic whose paraphernalia her relations had meticulously arranged behind her, an indifference that bordered on the deliberate and a preoccupation she could neither articulate nor entirely comprehend, the juxtaposition of her contemplative absorption against the gregarious festivity epitomizing a profound estrangement."
    ]
    claims [
      claim id "c1" status supported dimension character subject "Mara" text "Mara cares about the tide pool." cites ["e1"] {},
      claim id "c2" status distractor error-type misreads-detail targets ["q1"] text "Mara is angry." rationale "r" cites ["e1"] {},
      claim id "c3" status distractor error-type erroneous-inference targets ["q1"] text "Mara dislikes the outdoors." rationale "r" cites ["e1"] {},
      claim id "c4" status distractor error-type faulty-reasoning targets ["q1"] text "Mara fears her family." rationale "r" cites ["e1"] {}
    ]
    evidence [ source id "e1" line 1 status directly-supports supports ["c1"] {} ]
    outcomes [ ${Q1} ] {}..`;

  it("echoes the target's grade (5) on the output by default", async () => {
    const { item } = await one(Q1);
    expect(item.grade).toBe(5);
  });

  it("does not warn on a grade-appropriate passage (the Tide Pool fixture)", async () => {
    const { item } = await one(Q1);
    expect((item.warnings || []).some((w: string) => /reads above grade/.test(w))).toBe(false);
  });

  it("warns when the passage reads well above the target grade", async () => {
    const { errors, data } = await compile(DENSE);
    expect(errors).toHaveLength(0); // advisory only — never blocks composition
    const it0 = data.kind === "items" ? data.items[0] : data;
    expect((it0.warnings || []).some((w: string) => /reads above grade 5/.test(w))).toBe(true);
  });

  it("an explicit top-level `grade` overrides the target's grade and shifts the threshold", async () => {
    const { data } = await compile(DENSE.replace("target c1-t4", "target c1-t4 grade 8"));
    const it0 = data.kind === "items" ? data.items[0] : data;
    expect(it0.grade).toBe(8);
    expect((it0.warnings || []).some((w: string) => /reads above grade 8/.test(w))).toBe(true);
  });
});

describe("output shape", () => {
  it("a composed item carries the schema's required top-level keys", async () => {
    const required = JSON.parse(
      readFileSync(new URL("../spec/schema.json", import.meta.url), "utf8"),
    ).$defs.item.required;
    const { item } = await one(Q1);
    for (const key of required) expect(item, `missing ${key}`).toHaveProperty(key);
  });
});
