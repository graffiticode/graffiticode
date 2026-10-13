// SPDX-License-Identifier: MIT
/**
 * The inline-choice interaction — a dropdown cloze.
 *
 * Half text-entry and half choice, and both halves are asserted here: the sentence is cut and
 * the holes are bound by name, exactly as text-entry's are, while what fills a hole is read
 * with `choice`'s rules, so an author who can explain a wrong multiple-choice option can
 * explain a wrong dropdown option the same way.
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

const ONE = `
inline-choice [
  prompt "Complete the sentence."
  text "Plants absorb {{gas}} during photosynthesis."
  dropdowns [
    [ id "gas" options [
        [ text "carbon dioxide" assess [ correct ] ]
        [ text "oxygen" assess [ rationale "Oxygen is what plants release, not what they take in." ] ]
        [ text "nitrogen" ]
      ] {} ]
  ] {}
]`;

const TWO = `
inline-choice [
  text "Plants absorb {{in}} and release {{out}}."
  dropdowns [
    [ id "in" options [ [ text "carbon dioxide" assess [ correct ] ] [ text "oxygen" ] ] {} ]
    [ id "out" options [ [ text "oxygen" assess [ correct ] ] [ text "nitrogen" ] ] {} ]
  ] {}
]`;

describe("interaction — the sentence, and nothing about the answer", () => {
  test("the text is cut at its markers, and a dropdown carries its menu", async () => {
    const { interaction } = await compile(ONE);
    expect(interaction.type).toBe("inline-choice");
    expect(interaction.segments).toEqual([
      { text: "Plants absorb " },
      {
        id: "gas",
        choice: true,
        options: [
          { id: "A", text: "carbon dioxide" },
          { id: "B", text: "oxygen" },
          { id: "C", text: "nitrogen" },
        ],
      },
      { text: " during photosynthesis." },
    ]);
  });

  test("nothing in the half that ships to the browser says which option is right", async () => {
    const { interaction } = await compile(ONE);
    const shipped = JSON.stringify(interaction);
    expect(shipped).not.toContain("correct");
    expect(shipped).not.toContain("points");
    // The rationale is an answer key too — it explains a distractor, so it stays behind.
    expect(shipped).not.toContain("Oxygen is what plants release");
  });

  test("option ids are scoped to their dropdown, so they repeat", async () => {
    const { interaction } = await compile(TWO);
    const menus = interaction.segments.filter((s: any) => s.choice);
    expect(menus.map((m: any) => m.options.map((o: any) => o.id))).toEqual([
      ["A", "B"],
      ["A", "B"],
    ]);
  });
});

describe("presentation", () => {
  test("every menu shuffles by default, under one flag for the sentence", async () => {
    const { interaction } = await compile(ONE);
    expect(interaction.shuffle).toBe(true);
  });

  test("`shuffle false` keeps every menu as authored", async () => {
    const { interaction } = await compile(`
      inline-choice [
        shuffle false
        text "Plants absorb {{gas}}."
        dropdowns [ [ id "gas" options [ [ text "carbon dioxide" assess [ correct ] ] [ text "oxygen" ] ] {} ] ] {}
      ]`);
    expect(interaction.shuffle).toBe(false);
  });

  test("a menu of numbers in sequence is left alone", async () => {
    const { interaction } = await compile(`
      inline-choice [
        text "A triangle has {{n}} sides."
        dropdowns [ [ id "n" options [ [ text "2" ] [ text "3" assess [ correct ] ] [ text "4" ] ] {} ] ] {}
      ]`);
    expect(interaction.shuffle).toBe(false);
  });

  test("one unordered menu beside an ordered one shuffles both", async () => {
    // One flag covers the sentence, so a mixture has to choose. Leaving every menu fixed to
    // protect one gives up the randomization on all the others.
    const { interaction } = await compile(`
      inline-choice [
        text "A triangle has {{n}} sides and is drawn in {{colour}}."
        dropdowns [
          [ id "n" options [ [ text "2" ] [ text "3" assess [ correct ] ] [ text "4" ] ] {} ]
          [ id "colour" options [ [ text "red" assess [ correct ] ] [ text "blue" ] ] {} ]
        ] {}
      ]`);
    expect(interaction.shuffle).toBe(true);
  });

  test("an anchored option in a menu is marked", async () => {
    const { interaction } = await compile(`
      inline-choice [
        text "The answer is {{a}}."
        dropdowns [
          [ id "a" options [
              [ text "Whale" assess [ correct ] ]
              [ text "Shark" ]
              [ text "None of the above" ]
            ] {} ]
        ] {}
      ]`);
    expect(interaction.segments[1].options[2]).toEqual({
      id: "C",
      text: "None of the above",
      anchored: true,
    });
  });
});

describe("validation — a choice key, one per hole", () => {
  test("a dropdown's key is keyed by option id and looks like a choice mapping", async () => {
    const { validation } = await compile(ONE);
    expect(validation).toMatchObject({
      responseProcessing: "map_response",
      cardinality: "single",
      points: 1,
    });
    expect(validation.mapping.gas).toEqual({
      baseType: "identifier",
      points: 1,
      options: {
        A: { correct: true, points: 1 },
        B: { points: 0, rationale: "Oxygen is what plants release, not what they take in." },
      },
    });
  });

  test("the interaction is worth the sum of its dropdowns", async () => {
    const { validation } = await compile(TWO);
    expect(validation.points).toBe(2);
    expect(Object.keys(validation.mapping)).toEqual(["in", "out"]);
  });

  test("a dropdown is worth its BEST correct option, not their sum", async () => {
    // Two right answers in one menu are alternatives — only one can be chosen.
    const { validation } = await compile(`
      inline-choice [
        text "A {{n}} is a whole number."
        dropdowns [
          [ id "n" options [
              [ text "counting number" assess [ correct points 2 ] ]
              [ text "integer" assess [ correct points 1 ] ]
              [ text "fraction" ]
            ] {} ]
        ] {}
      ]`);
    expect(validation.mapping.n.points).toBe(2);
    expect(validation.points).toBe(2);
  });

  test("a penalized distractor keeps its own negative points", async () => {
    const { validation } = await compile(`
      inline-choice [
        text "The capital of France is {{c}}."
        dropdowns [
          [ id "c" options [
              [ text "Paris" assess [ correct ] ]
              [ text "Lyon" assess [ points -1 ] ]
            ] {} ]
        ] {}
      ]`);
    expect(validation.mapping.c.options).toEqual({
      A: { correct: true, points: 1 },
      B: { points: -1 },
    });
    // A penalty must not move the ceiling, or a fully correct response could never equal it.
    expect(validation.points).toBe(1);
  });

  test("an author-named option id overrides the derived letter", async () => {
    const { interaction, validation } = await compile(`
      inline-choice [
        text "Water freezes at {{t}} degrees Celsius."
        dropdowns [
          [ id "t" options [ [ id "zero" text "0" assess [ correct ] ] [ id "hundred" text "100" ] ] {} ]
        ] {}
      ]`);
    expect(interaction.segments[1].options.map((o: any) => o.id)).toEqual(["zero", "hundred"]);
    expect(validation.mapping.t.options.zero).toEqual({ correct: true, points: 1 });
  });
});

describe("inside an item", () => {
  test("it is a part like any other, and scores conjunctively with one", async () => {
    const { interaction, validation } = await compile(`
      item [
        scoring "conjunctive"
        parts [
          choice [ options [ [ text "Yes" assess [ correct ] ] [ text "No" ] ] {} ]
          ${TWO.trim()}
        ] {}
      ]`);
    expect(interaction.parts.map((p: any) => [p.id, p.type])).toEqual([
      ["1", "choice"],
      ["2", "inline-choice"],
    ]);
    expect(validation.points).toBe(1);
    expect(validation.parts["2"].mapping.in.options.A.correct).toBe(true);
  });
});

describe("errors name the fix", () => {
  test("no text", async () => {
    const msg = await errorOf(`inline-choice [ dropdowns [ [ id "a" options [ [ text "x" assess [ correct ] ] ] {} ] ] {} ]`);
    expect(msg).toContain("needs the sentence its dropdowns sit in");
    expect(msg).toContain("{{gas}}");
  });

  test("no dropdowns", async () => {
    const msg = await errorOf(`inline-choice [ text "A {{a}} thing." ]`);
    expect(msg).toContain("needs at least one dropdown");
  });

  test("a marker no dropdown declares names the dropdowns that exist", async () => {
    const msg = await errorOf(`
      inline-choice [
        text "Plants absorb {{gas}} and release {{other}}."
        dropdowns [ [ id "gas" options [ [ text "carbon dioxide" assess [ correct ] ] ] {} ] ] {}
      ]`);
    expect(msg).toContain("{{other}} but no dropdown declares that id");
    expect(msg).toContain("`dropdowns` declares: gas");
  });

  test("a dropdown with no marker says so in its own words", async () => {
    const msg = await errorOf(`
      inline-choice [
        text "Plants absorb {{gas}}."
        dropdowns [
          [ id "gas" options [ [ text "carbon dioxide" assess [ correct ] ] ] {} ]
          [ id "other" options [ [ text "oxygen" assess [ correct ] ] ] {} ]
        ] {}
      ]`);
    expect(msg).toContain('dropdown "other" has no {{other}}');
    expect(msg).toContain("be chosen for it");
  });

  test("the same marker twice", async () => {
    const msg = await errorOf(`
      inline-choice [
        text "{{a}} and {{a}}."
        dropdowns [ [ id "a" options [ [ text "x" assess [ correct ] ] ] {} ] ] {}
      ]`);
    expect(msg).toContain("One dropdown is one menu");
  });

  test("a dropdown with no correct option", async () => {
    const msg = await errorOf(`
      inline-choice [
        text "A {{a}} thing."
        dropdowns [ [ id "a" options [ [ text "x" ] [ text "y" ] ] {} ] ] {}
      ]`);
    expect(msg).toContain("no option is marked `correct`");
    expect(msg).toContain("dropdown 1");
  });

  test("an option with no text", async () => {
    const msg = await errorOf(`
      inline-choice [
        text "A {{a}} thing."
        dropdowns [ [ id "a" options [ [ assess [ correct ] ] ] {} ] ] {}
      ]`);
    expect(msg).toContain("needs the `text` the candidate reads in the menu");
  });

  test("an assess that asserts nothing", async () => {
    const msg = await errorOf(`
      inline-choice [
        text "A {{a}} thing."
        dropdowns [ [ id "a" options [ [ text "x" assess [ ] ] [ text "y" assess [ correct ] ] ] {} ] ] {}
      ]`);
    expect(msg).toContain("assess must say what it asserts");
  });

  test("a misplaced word names the legal set and where it belongs", async () => {
    const msg = await errorOf(`
      inline-choice [
        text "A {{a}} thing."
        dropdowns [ [ id "a" responses [ [ response "x" assess [ correct ] ] ] {} ] ] {}
      ]`);
    expect(msg).toContain("`responses` is not an attribute of dropdown");
    expect(msg).toContain("It takes: id, options");
  });

  test("two dropdowns with the same id", async () => {
    const msg = await errorOf(`
      inline-choice [
        text "{{a}} and {{b}}."
        dropdowns [
          [ id "a" options [ [ text "x" assess [ correct ] ] ] {} ]
          [ id "a" options [ [ text "y" assess [ correct ] ] ] {} ]
        ] {}
      ]`);
    expect(msg).toContain('the id "a" is already used');
  });
});
