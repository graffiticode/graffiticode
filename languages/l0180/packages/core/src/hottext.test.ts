// SPDX-License-Identifier: MIT
/**
 * The hottext interaction: the three shapes L0175 delivers, and the errors an author will hit.
 *
 * The interesting seam is that a `within "stimulus"` hottext cannot resolve itself — children
 * transform before parents, so the stimulus does not exist when HOTTEXT runs and ITEM finishes
 * the job. Both paths must produce the same shape, which is what most of this file checks.
 */
import { test, describe, expect } from "vitest";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "./index.js";

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

async function errorOf(src: string): Promise<string> {
  try {
    const val = await compile(src);
    throw new Error(`expected a compile error, got ${JSON.stringify(val)}`);
  } catch (e: any) {
    if (e instanceof Error) throw e;
    const first = Array.isArray(e) ? e[0] : e;
    return String(first?.message ?? first);
  }
}

/** A two-part evidence item whose Part B is a click in the passage — L0175's T4 Task Model 2. */
const TWO_PART = `
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
    hottext [
      prompt "Click the sentence that best supports your answer to Part A."
      within "stimulus"
      granularity "sentence"
      selections [
        [ quote "She did not turn around." assess [ correct ] ]
      ] {}
    ]
  ] {}
]`;

describe("sentence granularity, within the stimulus", () => {
  test("the passage becomes the units, addressed off the paragraph ids", async () => {
    const { interaction } = await compile(TWO_PART);
    const hot = interaction.parts[1];
    expect(hot.type).toBe("hottext");
    expect(hot.granularity).toBe("sentence");
    expect(hot.within).toBe("stimulus");
    expect(hot.units.map((u: any) => u.id)).toEqual(["p1.1", "p2.1", "p2.2"]);
    expect(hot.units.every((u: any) => u.selectable)).toBe(true);
  });

  test("the answer key names a unit, and never reaches the interaction", async () => {
    const { interaction, validation } = await compile(TWO_PART);
    expect(validation.parts["2"]).toEqual({
      responseProcessing: "map_response",
      cardinality: "single",
      baseType: "identifier",
      points: 1,
      mapping: { "p2.2": { correct: true, points: 1 } },
    });
    expect(JSON.stringify(interaction)).not.toContain("correct");
  });

  test("one correct selection means click exactly one", async () => {
    const { interaction, validation } = await compile(TWO_PART);
    expect(interaction.parts[1]).toMatchObject({ minChoices: 1, maxChoices: 1 });
    expect(validation.parts["2"].cardinality).toBe("single");
  });

  test("the item still scores conjunctively over a choice and a hottext", async () => {
    const { validation } = await compile(TWO_PART);
    expect(validation.scoring).toBe("conjunctive");
    expect(validation.points).toBe(1);
    expect(Object.keys(validation.parts)).toEqual(["1", "2"]);
  });
});

describe("select N from a valid superset", () => {
  const SUPERSET = `
    item [
      stimulus [
        paragraphs [
          "Bees live in colonies. Every bee does a job. Workers gather nectar."
          "Guard bees defend the entrance. The queen lays every egg."
        ]
      ]
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
    ]`;

  test("the ceiling is the bound, not the number of correct answers", async () => {
    // Four sentences are valid; the candidate picks three. This is L0175's hot-text shape, where
    // selectCount is deliberately one less than the valid set.
    const { validation } = await compile(SUPERSET);
    expect(validation.parts["1"]).toMatchObject({ points: 3, upperBound: 3 });
    expect(Object.keys(validation.parts["1"].mapping)).toHaveLength(4);
  });

  test("the candidate is asked for exactly that many", async () => {
    const { interaction, validation } = await compile(SUPERSET);
    expect(interaction.parts[0]).toMatchObject({ minChoices: 3, maxChoices: 3 });
    expect(validation.parts["1"].cardinality).toBe("multiple");
  });

  test("a bound above what the correct selections are worth is refused", async () => {
    const msg = await errorOf(SUPERSET.replace("upper-bound 3", "upper-bound 9"));
    expect(msg).toContain("upper-bound is 9");
    expect(msg).toContain("only worth 4");
  });

  test("without a bound, every correct selection must be clicked", async () => {
    const { interaction, validation } = await compile(SUPERSET.replace("upper-bound 3\n", ""));
    expect(interaction.parts[0]).toMatchObject({ minChoices: 4, maxChoices: 4 });
    expect(validation.parts["1"].points).toBe(4);
    expect(validation.parts["1"].upperBound).toBeUndefined();
  });
});

describe("word granularity", () => {
  const WORD = `
    hottext [
      prompt "Click the word that means a channel that carries water."
      text "The aqueduct carried water across long distances."
      granularity "word"
      selections [
        [ quote "aqueduct" assess [ correct ] ]
        [ quote "water" assess [ rationale "Water is what it carries, not what the word means." ] ]
        [ quote "distances" ]
      ] {}
    ]`;

  test("only the authored words are clickable", async () => {
    const { interaction } = await compile(WORD);
    const selectable = interaction.units.filter((u: any) => u.selectable).map((u: any) => u.text);
    expect(selectable).toEqual(["aqueduct", "water", "distances"]);
    expect(interaction.units).toHaveLength(7);
  });

  test("punctuation is kept beside the clickable core", async () => {
    const { interaction } = await compile(WORD);
    const last = interaction.units[interaction.units.length - 1];
    expect(last).toMatchObject({ text: "distances", post: "." });
  });

  test("it is single-select, and the rationale rides in the key", async () => {
    const { interaction, validation } = await compile(WORD);
    expect(interaction).toMatchObject({ maxChoices: 1 });
    expect(validation.cardinality).toBe("single");
    expect(validation.mapping).toEqual({ w2: { correct: true, points: 1 } });
    expect(validation.feedback.w4).toContain("not what the word means");
    expect(JSON.stringify(interaction)).not.toContain("not what the word means");
  });
});

describe("a bare hottext is a whole program", () => {
  test("its own text is segmented into sentences", async () => {
    const { interaction } = await compile(`
      hottext [
        prompt "Click the sentence that states the central idea."
        text "Bees live in colonies. Every bee does a job that helps the group."
        selections [ [ quote "Every bee does a job that helps the group." assess [ correct ] ] ] {}
      ]`);
    expect(interaction.units.map((u: any) => u.id)).toEqual(["p1.1", "p1.2"]);
    expect(interaction.within).toBeUndefined();
  });
});

describe("errors name the fix, not just the fault", () => {
  test("text and within together", async () => {
    const msg = await errorOf(`
      hottext [ text "One." within "stimulus" selections [ [ quote "One." assess [ correct ] ] ] {} ]`);
    expect(msg).toContain("takes `text` or `within`, not both");
  });

  test("neither text nor within", async () => {
    const msg = await errorOf(`hottext [ selections [ [ quote "One." assess [ correct ] ] ] {} ]`);
    expect(msg).toContain("needs the text it selects within");
    expect(msg).toContain('within "stimulus"');
  });

  test("within stimulus outside an item", async () => {
    const msg = await errorOf(`
      hottext [ within "stimulus" selections [ [ quote "One." assess [ correct ] ] ] {} ]`);
    expect(msg).toContain("needs the hottext to be a part of an item");
    expect(msg).toContain("item [ stimulus");
  });

  test("within stimulus in an item that has no stimulus", async () => {
    const msg = await errorOf(`
      item [ parts [
        hottext [ within "stimulus" selections [ [ quote "One." assess [ correct ] ] ] {} ]
      ] {} ]`);
    expect(msg).toContain("the item has no stimulus");
    expect(msg).toContain("give the hottext its own `text`");
  });

  test("two parts cannot both own the passage", async () => {
    const one = `hottext [ within "stimulus" selections [ [ quote "One." assess [ correct ] ] ] {} ]`;
    const two = `hottext [ within "stimulus" selections [ [ quote "Two." assess [ correct ] ] ] {} ]`;
    const msg = await errorOf(`
      item [ stimulus [ paragraphs [ "One. Two." ] ] parts [ ${one} ${two} ] {} ]`);
    expect(msg).toContain("already does");
    expect(msg).toContain("One passage cannot be two interactions");
  });

  test("a quote that is not in the passage names the closest text", async () => {
    const msg = await errorOf(TWO_PART.replace("She did not turn around.", "She did not turn round."));
    expect(msg).toContain("does not appear in the text");
    expect(msg).toContain("She did not turn around.");
  });

  test("no selection marked correct", async () => {
    const msg = await errorOf(`
      hottext [ text "One. Two." selections [ [ quote "One." assess [ points 2 ] ] ] {} ]`);
    expect(msg).toContain("no selection is marked `correct`");
  });

  test("hottext with no selections", async () => {
    const msg = await errorOf(`hottext [ text "One." selections [] {} ]`);
    expect(msg).toContain("needs at least one selection");
  });

  test("a choice attribute written on hottext lists the legal set", async () => {
    const msg = await errorOf(`
      hottext [ text "One." shuffle true selections [ [ quote "One." assess [ correct ] ] ] {} ]`);
    expect(msg).toContain("is not an attribute of hottext");
    expect(msg).toContain("prompt, text, within, granularity");
  });

  test("an unknown granularity names the legal set", async () => {
    const msg = await errorOf(`
      hottext [ text "One." granularity "phrase" selections [ [ quote "One." assess [ correct ] ] ] {} ]`);
    expect(msg).toContain("is not a granularity mode");
    expect(msg).toContain("sentence, word");
  });
});
