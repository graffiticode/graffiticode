// SPDX-License-Identifier: MIT
/**
 * The order interaction — put these in the right sequence.
 *
 * The property worth testing hardest is not the scoring but the SPLIT: the elements ship in the
 * order the candidate sees them, and the right order lives only in the key. Get that wrong and
 * a graded delivery hands the browser the answer in array order while every scoring test still
 * passes.
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

const CYCLE = `
order [
  prompt "Put the stages of the water cycle in order."
  elements [
    [ text "Condensation" assess [ position 2 ] ]
    [ text "Evaporation" assess [ position 1 ] ]
    [ text "Collection" assess [ position 4 ] ]
    [ text "Precipitation" assess [ position 3 ] ]
  ] {}
]`;

describe("interaction — what the candidate sees", () => {
  test("the elements ship in the order they were authored, which is the order presented", async () => {
    const { interaction } = await compile(CYCLE);
    expect(interaction.type).toBe("order");
    expect(interaction.elements).toEqual([
      { id: "A", text: "Condensation" },
      { id: "B", text: "Evaporation" },
      { id: "C", text: "Collection" },
      { id: "D", text: "Precipitation" },
    ]);
  });

  test("nothing in it says where anything belongs", async () => {
    // The whole reason `position` exists. If the compiler sorted the elements, this half —
    // which is exactly what a graded delivery ships — would BE the answer key.
    const { interaction } = await compile(CYCLE);
    expect(JSON.stringify(interaction)).not.toContain("position");
    const order = interaction.elements.map((e: any) => e.text);
    expect(order).not.toEqual(["Evaporation", "Condensation", "Precipitation", "Collection"]);
  });
});

describe("presentation", () => {
  test("the starting order is randomized by default", async () => {
    const { interaction } = await compile(CYCLE);
    expect(interaction.shuffle).toBe(true);
  });

  test("`shuffle false` presents them exactly as authored", async () => {
    const { interaction } = await compile(`
      order [
        shuffle false
        elements [
          [ text "First" assess [ position 1 ] ]
          [ text "Second" assess [ position 2 ] ]
        ] {}
      ]`);
    expect(interaction.shuffle).toBe(false);
    expect(interaction.elements.map((e: any) => e.text)).toEqual(["First", "Second"]);
  });

  test("shuffling does not weaken the reason `position` exists", async () => {
    // The renderer shuffles; the ARRAY still ships in authored order, so an author who listed
    // the elements correctly would still be shipping the answer inside `interaction` if the
    // key were the order rather than `position`.
    const { interaction, validation } = await compile(CYCLE);
    expect(interaction.elements.map((e: any) => e.text)).toEqual([
      "Condensation",
      "Evaporation",
      "Collection",
      "Precipitation",
    ]);
    expect(validation.correctResponse).toEqual(["B", "A", "D", "C"]);
  });
});

describe("validation — the sequence", () => {
  test("the key is the ids in the right order, all or nothing", async () => {
    const { validation } = await compile(CYCLE);
    expect(validation).toEqual({
      responseProcessing: "match_correct",
      cardinality: "ordered",
      baseType: "identifier",
      points: 1,
      correctResponse: ["B", "A", "D", "C"],
    });
  });

  test("author-named ids come through instead of the derived letters", async () => {
    const { interaction, validation } = await compile(`
      order [
        elements [
          [ id "second" text "Then this" assess [ position 2 ] ]
          [ id "first" text "This first" assess [ position 1 ] ]
        ] {}
      ]`);
    expect(interaction.elements.map((e: any) => e.id)).toEqual(["second", "first"]);
    expect(validation.correctResponse).toEqual(["first", "second"]);
  });
});

describe("inside an item", () => {
  test("it is a part like any other", async () => {
    const { interaction, validation } = await compile(`
      item [
        parts [
          ${CYCLE.trim()}
          choice [ options [ [ text "Yes" assess [ correct ] ] [ text "No" ] ] {} ]
        ] {}
      ]`);
    expect(interaction.parts.map((p: any) => [p.id, p.type])).toEqual([
      ["1", "order"],
      ["2", "choice"],
    ]);
    // Additive: the sequence is worth 1 and the choice is worth 1.
    expect(validation.points).toBe(2);
    expect(validation.parts["1"].correctResponse).toEqual(["B", "A", "D", "C"]);
  });
});

describe("errors name the fix", () => {
  test("an element with no position says why every element needs one", async () => {
    const msg = await errorOf(`
      order [ elements [ [ text "First" assess [ position 1 ] ] [ text "Second" ] ] {} ]`);
    expect(msg).toContain("element 2");
    expect(msg).toContain("assess [position N]");
    expect(msg).toContain("the order the candidate sees, not the answer");
  });

  test("two elements claiming one position name each other", async () => {
    const msg = await errorOf(`
      order [
        elements [
          [ text "First" assess [ position 1 ] ]
          [ text "Also first" assess [ position 1 ] ]
        ] {}
      ]`);
    expect(msg).toContain("position 1 is already taken by element 1");
  });

  test("a position outside the range says how many there are to place", async () => {
    const msg = await errorOf(`
      order [
        elements [
          [ text "First" assess [ position 1 ] ]
          [ text "Second" assess [ position 5 ] ]
        ] {}
      ]`);
    expect(msg).toContain("position 5 is outside 1…2");
  });

  test("a fractional position", async () => {
    const msg = await errorOf(`
      order [
        elements [
          [ text "First" assess [ position 1 ] ]
          [ text "Second" assess [ position 1.5 ] ]
        ] {}
      ]`);
    expect(msg).toContain("is not a whole number");
  });

  test("one element is already in order", async () => {
    const msg = await errorOf(`order [ elements [ [ text "Alone" assess [ position 1 ] ] ] {} ]`);
    expect(msg).toContain("needs at least two elements");
  });

  test("no elements at all", async () => {
    const msg = await errorOf(`order [ prompt "Put these in order." ]`);
    expect(msg).toContain("needs the things to be put in order");
  });

  test("an element with no text", async () => {
    const msg = await errorOf(`
      order [ elements [ [ assess [ position 1 ] ] [ text "Second" assess [ position 2 ] ] ] {} ]`);
    expect(msg).toContain("needs the `text` the candidate reads and moves");
  });

  test("a misplaced word names the legal set", async () => {
    const msg = await errorOf(`
      order [ elements [ [ text "First" quote "no" assess [ position 1 ] ] ] {} ]`);
    expect(msg).toContain("`quote` is not an attribute of element");
    expect(msg).toContain("It takes: id, text, assess");
  });
});

describe("`position` belongs to order alone", () => {
  // `assess` is checked under that one name wherever it appears, so nothing in validAttributes
  // can tell an order element from a choice option. Without a check of its own, `position` on
  // an option would merge, be read by nobody, and compile clean.
  test("on a choice option it is refused, and told where it belongs", async () => {
    const msg = await errorOf(`
      choice [ options [ [ text "A" assess [ correct position 1 ] ] [ text "B" ] ] {} ]`);
    expect(msg).toContain("is not part of an `assess` here");
    expect(msg).toContain("It takes: correct, points, rationale");
    expect(msg).toContain("`position` belongs on an `order` element");
  });

  test("on a text-entry response", async () => {
    const msg = await errorOf(`
      text-entry [
        text "The capital of France is {{c}}."
        blanks [ [ id "c" responses [ [ response "Paris" assess [ correct position 1 ] ] ] {} ] ] {}
      ]`);
    expect(msg).toContain("is not part of an `assess` here");
  });

  test("and `correct` is refused on an order element, where position is the answer", async () => {
    const msg = await errorOf(`
      order [
        elements [
          [ text "First" assess [ correct position 1 ] ]
          [ text "Second" assess [ position 2 ] ]
        ] {}
      ]`);
    expect(msg).toContain("is not part of an `assess` here");
    expect(msg).toContain("It takes: position");
  });
});

describe("two elements that read the same are one answer", () => {
  // The sentence-building item: "the cat sat on the mat" has two elements reading "the". They
  // are different ids, so an id-by-id comparison marks a candidate wrong for building the
  // identical sentence with the other "the" first — right answer, no mark, no explanation.
  const SENTENCE = `
    order [
      prompt "Put the words in order to make a correct sentence."
      elements [
        [ text "the" assess [ position 1 ] ]
        [ text "cat" assess [ position 2 ] ]
        [ text "sat" assess [ position 3 ] ]
        [ text "on" assess [ position 4 ] ]
        [ text "the" assess [ position 5 ] ]
        [ text "mat" assess [ position 6 ] ]
      ] {}
    ]`;

  test("the key names the ids that stand for each other", async () => {
    const { validation } = await compile(SENTENCE);
    expect(validation.correctResponse).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(validation.interchangeable).toEqual([["A", "E"]]);
  });

  test("the field is absent when every element reads differently", async () => {
    const { validation } = await compile(CYCLE);
    expect(validation.interchangeable).toBeUndefined();
  });

  test("case matters — swapping The and the would capitalize the wrong word", async () => {
    const { validation } = await compile(`
      order [
        elements [
          [ text "The" assess [ position 1 ] ]
          [ text "cat" assess [ position 2 ] ]
          [ text "the" assess [ position 3 ] ]
        ] {}
      ]`);
    expect(validation.interchangeable).toBeUndefined();
  });

  test("three of a kind are one group", async () => {
    const { validation } = await compile(`
      order [
        elements [
          [ text "na" assess [ position 1 ] ]
          [ text "na" assess [ position 2 ] ]
          [ text "na" assess [ position 3 ] ]
          [ text "batman" assess [ position 4 ] ]
        ] {}
      ]`);
    expect(validation.interchangeable).toEqual([["A", "B", "C"]]);
  });
});
