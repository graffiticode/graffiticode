// SPDX-License-Identifier: MIT
/**
 * L0175 conformance: does an L0180 item score the way L0175's does?
 *
 * L0175 is the content language — it composes the passage, the claims and the error-typed
 * distractors. L0180 is the assessment language that delivers the result. The bar is that any
 * item an L0175 spec describes is expressible here AND scores identically, so this compiles a
 * real program per delivered shape and runs candidate responses through the scorer.
 *
 * The rules asserted are L0175's own, from its `SCORING` map
 * (`l0175/packages/core/src/compiler.ts:1257-1263`):
 *
 *   multiple-choice  "Correct option = 1 point; otherwise 0."
 *   multi-select     "All correct selections (and no others) = 1 point; otherwise 0."
 *   ebsr             "Both parts correct = 1 point; otherwise 0."
 *
 * Asserting on SCORING BEHAVIOUR rather than on shape is deliberate. L0175's own coverage
 * check substring-matches string literals, which an EBSR item collapsed into a single choice
 * still passes — structure and answer keys are invisible to it. A response that scores
 * differently is the failure that actually matters.
 *
 * The scorer is imported across the workspace by relative path, which works only because
 * `score.ts` has no imports at all — the same DOM-free discipline that lets it run server-side.
 * Core's tsconfig excludes `*.test.ts`, so this never reaches `tsc`.
 */
import { test, describe, expect } from "vitest";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "./index.js";
import { scoreInteraction } from "../../view/src/scoring/score.js";

async function compile(src: string): Promise<any> {
  const code: any = await parser.parse(180, src.trim().endsWith("..") ? src : `${src}..`, lexicon);
  const perr: any = Object.values(code).find((n: any) => n && n.tag === "ERROR");
  if (perr) throw new Error(`parse error: ${JSON.stringify(perr.elts)}`);
  return await new Promise((resolve, reject) =>
    compiler.compile(code, {}, {}, (e: any, v: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) reject(errs);
      else resolve(v);
    }),
  );
}

/** Compile once, then score a response against it the way a delivery would. */
async function scorer(src: string) {
  const { interaction, validation } = await compile(src);
  return (response: unknown) => scoreInteraction({ interaction, validation, response });
}

describe("multiple-choice — correct option = 1 point, otherwise 0", () => {
  const SRC = `
    choice [
      prompt "Which inference about Mara is supported by the passage?"
      options [
        [ text "Mara cares more about the tide pool than the picnic." assess [ correct ] ]
        [ text "Mara is angry at her brother for calling her twice."
          assess [ rationale "Not turning around shows absorption, not anger." ] ]
        [ text "Mara is bored by the beach." ]
        [ text "Mara wants to go home." ]
      ] {}
    ]
  `;

  test("the key earns the point; every distractor earns zero", async () => {
    const score = await scorer(SRC);
    expect(score(["A"])).toMatchObject({ points: 1, maxPoints: 1, correct: true });
    for (const wrong of ["B", "C", "D"]) {
      expect(score([wrong]), wrong).toMatchObject({ points: 0, correct: false });
    }
    expect(score([])).toMatchObject({ points: 0, correct: false });
  });

  test("a distractor rationale rides in the key, not the presentation", async () => {
    const { interaction, validation } = await compile(SRC);
    expect(validation.feedback.B).toContain("absorption");
    expect(JSON.stringify(interaction)).not.toContain("absorption");
  });
});

describe("multi-select — all correct and nothing else = 1 point, otherwise 0", () => {
  const SRC = `
    choice [
      prompt "Choose the two sentences that belong in a summary of the passage."
      response-processing "match-correct"
      min-choices 2
      max-choices 2
      options [
        [ text "Bees live together in large groups called colonies." assess [ correct ] ]
        [ text "Every bee in a colony does a job that helps the group survive." assess [ correct ] ]
        [ text "Some bees are yellow and black." ]
        [ text "A hive can be kept in a wooden box." ]
      ] {}
    ]
  `;

  test("the exact set earns the point", async () => {
    const score = await scorer(SRC);
    expect(score(["A", "B"])).toMatchObject({ points: 1, maxPoints: 1, correct: true });
    expect(score(["B", "A"])).toMatchObject({ correct: true });
  });

  test("a subset earns zero, not half — the case per-option scoring gets wrong", async () => {
    const score = await scorer(SRC);
    expect(score(["A"])).toMatchObject({ points: 0, correct: false });
    expect(score(["B"])).toMatchObject({ points: 0, correct: false });
  });

  test("a superset earns zero, and so does the wrong pair", async () => {
    const score = await scorer(SRC);
    expect(score(["A", "B", "C"])).toMatchObject({ points: 0, correct: false });
    expect(score(["C", "D"])).toMatchObject({ points: 0, correct: false });
    expect(score([])).toMatchObject({ points: 0, correct: false });
  });
});

describe("ebsr — both parts correct = 1 point, otherwise 0", () => {
  const SRC = `
    item [
      stimulus [
        title "The Tide Pool"
        paragraphs [
          "Mara crouched at the edge of the tide pool, ignoring the picnic behind her."
          "Her brother called twice. She did not turn around."
        ]
      ]
      scoring "conjunctive"
      parts [
        choice [
          prompt "What can the reader conclude about Mara?"
          options [
            [ text "She is absorbed by the tide pool." assess [ correct ] ]
            [ text "She is angry at her brother." ]
          ] {}
        ]
        choice [
          prompt "Which sentence best supports your answer to Part A?"
          options [
            [ text "Her brother called twice." ]
            [ text "She did not turn around." assess [ correct ] ]
          ] {}
        ]
      ] {}
    ]
  `;

  test("both parts right earns one point for the item, not one per part", async () => {
    const score = await scorer(SRC);
    expect(score({ "1": ["A"], "2": ["B"] })).toMatchObject({
      points: 1,
      maxPoints: 1,
      correct: true,
    });
  });

  test("the right claim with the wrong evidence earns zero, not half", async () => {
    // This is the requirement the item wrapper exists for: naming the right idea while citing
    // the wrong line is not partial credit in an EBSR item.
    const score = await scorer(SRC);
    expect(score({ "1": ["A"], "2": ["A"] })).toMatchObject({ points: 0, correct: false });
    expect(score({ "1": ["B"], "2": ["B"] })).toMatchObject({ points: 0, correct: false });
    expect(score({ "1": ["A"] })).toMatchObject({ points: 0, correct: false });
    expect(score({})).toMatchObject({ points: 0, correct: false });
  });
});

describe("hot-text, sentence granularity — both parts correct = 1 point, otherwise 0", () => {
  const SRC = `
    item [
      stimulus [
        title "The Tide Pool"
        paragraphs [
          "Mara crouched at the edge of the tide pool, ignoring the picnic behind her."
          "Her brother called twice. She did not turn around."
        ]
      ]
      scoring "conjunctive"
      parts [
        choice [
          prompt "Click on the statement that best describes Mara."
          options [
            [ text "She is absorbed by the tide pool." assess [ correct ] ]
            [ text "She is angry at her brother." ]
          ] {}
        ]
        hottext [
          prompt "Click the sentence that best supports your answer to Part A."
          within "stimulus"
          selections [ [ quote "She did not turn around." assess [ correct ] ] ] {}
        ]
      ] {}
    ]
  `;

  test("the right statement with the right sentence earns the point", async () => {
    const score = await scorer(SRC);
    expect(score({ "1": ["A"], "2": ["p2.2"] })).toMatchObject({ points: 1, maxPoints: 1, correct: true });
  });

  test("the right statement with the wrong sentence earns zero, not half", async () => {
    const score = await scorer(SRC);
    expect(score({ "1": ["A"], "2": ["p1.1"] })).toMatchObject({ points: 0, correct: false });
    expect(score({ "1": ["B"], "2": ["p2.2"] })).toMatchObject({ points: 0, correct: false });
    expect(score({ "1": ["A"] })).toMatchObject({ points: 0, correct: false });
  });
});

describe("hot-text, select N from a valid superset", () => {
  // L0175 asks for one fewer than the valid set, so any N of them is right. Wrapping the single
  // interaction in a conjunctive item is what makes it worth one point rather than N, matching
  // L0175's "1 point; otherwise 0".
  const SRC = `
    item [
      stimulus [
        paragraphs [
          "Bees live in colonies. Every bee does a job. Workers gather nectar."
          "Guard bees defend the entrance. The queen lays every egg."
        ]
      ]
      scoring "conjunctive"
      points 1
      parts [
        hottext [
          prompt "Click the three sentences that show how the colony works together."
          within "stimulus"
          upper-bound 3
          selections [
            [ quote "Every bee does a job." assess [ correct ] ]
            [ quote "Workers gather nectar." assess [ correct ] ]
            [ quote "Guard bees defend the entrance." assess [ correct ] ]
            [ quote "The queen lays every egg." assess [ correct ] ]
          ] {}
        ]
      ] {}
    ]
  `;

  test("any three of the four valid sentences earn the point", async () => {
    const score = await scorer(SRC);
    expect(score({ "1": ["p1.2", "p1.3", "p2.1"] })).toMatchObject({ points: 1, correct: true });
    expect(score({ "1": ["p1.3", "p2.1", "p2.2"] })).toMatchObject({ points: 1, correct: true });
  });

  test("two of the four is not enough, and a wrong sentence spoils it", async () => {
    const score = await scorer(SRC);
    expect(score({ "1": ["p1.2", "p1.3"] })).toMatchObject({ points: 0, correct: false });
    expect(score({ "1": ["p1.1", "p1.2", "p1.3"] })).toMatchObject({ points: 0, correct: false });
  });
});

describe("hot-text, word granularity — one click, 1 point or 0", () => {
  const SRC = `
    hottext [
      prompt "Read the sentence. Click the word that means a channel that carries water."
      text "The aqueduct carried water across long distances."
      granularity "word"
      selections [
        [ quote "aqueduct" assess [ correct ] ]
        [ quote "water" assess [ rationale "Water is what it carries, not what the word means." ] ]
        [ quote "distances" ]
      ] {}
    ]
  `;

  test("the right word earns the point; the other candidates earn nothing", async () => {
    const score = await scorer(SRC);
    expect(score(["w2"])).toMatchObject({ points: 1, maxPoints: 1, correct: true });
    expect(score(["w4"])).toMatchObject({ points: 0, correct: false });
    expect(score(["w7"])).toMatchObject({ points: 0, correct: false });
    expect(score([])).toMatchObject({ points: 0, correct: false });
  });
});

describe("short-text — hand-scored against the rubric, never auto-scored", () => {
  // L0175's SCORING says "0-2 points; hand-scored against the rubric", and its scope.json puts
  // auto-scoring of short-text explicitly out of scope. The conformance requirement is therefore
  // that L0180 does NOT score it either — and does not report zero as though it had.
  const SRC = `
    extended-text [
      prompt "What inference can be made about Mara? Explain using key details from the passage."
      rubric [
        [ points 2 descriptor "Makes a valid inference and cites two supporting details." ]
        [ points 1 descriptor "Makes a valid inference with one detail, or a partial inference." ]
        [ points 0 descriptor "No valid inference, or no support from the text." ]
      ] {}
      exemplar "Mara is absorbed by the tide pool — she ignores the picnic and does not turn around."
    ]
  `;

  test("a response is held pending, not marked", async () => {
    const score = await scorer(SRC);
    const s = score("Mara cares more about the tide pool than the picnic.");
    expect(s).toMatchObject({ points: 0, maxPoints: 2, correct: false, pending: true });
  });

  test("the 0-2 rubric reaches delivery, highest band first", async () => {
    const { validation } = await compile(SRC);
    expect(validation.responseProcessing).toBe("human");
    expect(validation.rubric.map((b: any) => b.points)).toEqual([2, 1, 0]);
    expect(validation.points).toBe(2);
  });

  test("the rubric and exemplar are withheld from the presentation", async () => {
    const { interaction } = await compile(SRC);
    expect(JSON.stringify(interaction)).not.toContain("supporting details");
    expect(JSON.stringify(interaction)).not.toContain("absorbed");
  });
});

describe("every L0175 delivered item type is now expressible", () => {
  test("nothing is left on the list", () => {
    // multiple-choice, multi-select, ebsr, hot-text (three shapes) and short-text all have
    // conformance cases above. If a new L0175 item type appears, this is where it lands.
    for (const word of ["choice", "hottext", "extended-text", "item"]) {
      expect(lexicon[word], `${word} is missing from the lexicon`).toBeDefined();
    }
  });
});
