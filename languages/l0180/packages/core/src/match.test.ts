// SPDX-License-Identifier: MIT
/**
 * `match` and `classification` — pairing each thing with somewhere it belongs.
 *
 * One test file for both, because they are one implementation: the same key over pairs of
 * identifiers, differing in vocabulary and in exactly one rule — a match pairs each target with
 * one item, and a classification is the one where sharing is the point.
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

const CAPITALS = `
match [
  prompt "Match each country to its capital."
  targets [
    [ id "paris" text "Paris" ]
    [ id "tokyo" text "Tokyo" ]
    [ id "lima" text "Lima" ]
  ] {}
  match-items [
    [ text "France" assess [ target "paris" ] ]
    [ text "Japan" assess [ target "tokyo" ] ]
  ] {}
]`;

const ANIMALS = `
classification [
  prompt "Sort each animal into its class."
  categories [
    [ id "mammal" text "Mammal" ]
    [ id "reptile" text "Reptile" ]
  ] {}
  classification-items [
    [ text "Blue whale" assess [ category "mammal" ] ]
    [ text "Iguana" assess [ category "reptile" ] ]
    [ text "Bat" assess [ category "mammal" ] ]
  ] {}
]`;

describe("interaction — what the candidate sees", () => {
  test("the items and the targets, and nothing about which goes where", async () => {
    const { interaction } = await compile(CAPITALS);
    expect(interaction.type).toBe("match");
    expect(interaction.items).toEqual([
      { id: "A", text: "France" },
      { id: "B", text: "Japan" },
    ]);
    expect(interaction.targets).toEqual([
      { id: "paris", text: "Paris" },
      { id: "tokyo", text: "Tokyo" },
      { id: "lima", text: "Lima" },
    ]);
    // The half that ships to a graded delivery says nothing about the pairing.
    expect(JSON.stringify(interaction)).not.toContain("paris\",\"correct");
    expect(JSON.stringify(interaction)).not.toContain("assess");
  });

  test("a target no item names is simply a distractor", async () => {
    const { interaction, validation } = await compile(CAPITALS);
    expect(interaction.targets.map((t: any) => t.id)).toContain("lima");
    expect(Object.keys(validation.mapping).join(" ")).not.toContain("lima");
  });

  test("the lists are randomized by default, like every other list", async () => {
    const { interaction } = await compile(CAPITALS);
    expect(interaction.shuffle).toBe(true);
  });
});

describe("validation — a key over pairs", () => {
  test("the mapping is keyed by pairing, in QTI's directedPair spelling", async () => {
    const { validation } = await compile(CAPITALS);
    expect(validation).toEqual({
      responseProcessing: "map_response",
      cardinality: "multiple",
      baseType: "directedPair",
      points: 2,
      mapping: {
        "A paris": { correct: true, points: 1 },
        "B tokyo": { correct: true, points: 1 },
      },
    });
  });

  test("the item is worth the sum of its pairings, so several give partial credit", async () => {
    const { validation } = await compile(`
      match [
        targets [ [ id "a" text "A" ] [ id "b" text "B" ] ] {}
        match-items [
          [ text "one" assess [ target "a" points 2 ] ]
          [ text "two" assess [ target "b" ] ]
        ] {}
      ]`);
    expect(validation.points).toBe(3);
    expect(validation.mapping["A a"]).toEqual({ correct: true, points: 2 });
  });

  test("a rationale rides on the pairing, where the ids that name it are", async () => {
    const { interaction, validation } = await compile(`
      match [
        targets [ [ id "a" text "A" ] [ id "b" text "B" ] ] {}
        match-items [
          [ text "one" assess [ target "a" rationale "A is for one." ] ]
          [ text "two" assess [ target "b" ] ]
        ] {}
      ]`);
    expect(validation.mapping["A a"].rationale).toBe("A is for one.");
    expect(JSON.stringify(interaction)).not.toContain("A is for one");
  });

  test("match-correct carries the pairings as a set and is worth one point", async () => {
    const { validation } = await compile(`
      match [
        response-processing "match-correct"
        targets [ [ id "a" text "A" ] [ id "b" text "B" ] ] {}
        match-items [
          [ text "one" assess [ target "a" ] ]
          [ text "two" assess [ target "b" ] ]
        ] {}
      ]`);
    expect(validation.points).toBe(1);
    expect(validation.correctResponse).toEqual(["A a", "B b"]);
    expect(validation.mapping).toBeUndefined();
  });
});

describe("classification is the same key, and the one rule that differs", () => {
  test("several items share a category, which is the whole point", async () => {
    const { interaction, validation } = await compile(ANIMALS);
    expect(interaction.type).toBe("classification");
    expect(interaction.categories.map((c: any) => c.id)).toEqual(["mammal", "reptile"]);
    expect(validation.mapping).toEqual({
      "A mammal": { correct: true, points: 1 },
      "B reptile": { correct: true, points: 1 },
      "C mammal": { correct: true, points: 1 },
    });
  });

  test("a match refuses the same sharing, and names classification as the fix", async () => {
    const msg = await errorOf(`
      match [
        targets [ [ id "a" text "A" ] [ id "b" text "B" ] ] {}
        match-items [
          [ text "one" assess [ target "a" ] ]
          [ text "two" assess [ target "a" ] ]
        ] {}
      ]`);
    expect(msg).toContain('item 1 already matches "a"');
    expect(msg).toContain("this is a `classification`");
  });
});

describe("inside an item", () => {
  test("a match is a part like any other", async () => {
    const { interaction, validation } = await compile(`
      item [
        scoring "conjunctive"
        parts [
          ${CAPITALS.trim()}
          choice [ options [ [ text "Yes" assess [ correct ] ] [ text "No" ] ] {} ]
        ] {}
      ]`);
    expect(interaction.parts.map((p: any) => [p.id, p.type])).toEqual([
      ["1", "match"],
      ["2", "choice"],
    ]);
    expect(validation.points).toBe(1);
    expect(validation.parts["1"].baseType).toBe("directedPair");
  });
});

describe("errors name the fix", () => {
  test("an item with no target says which targets there are", async () => {
    const msg = await errorOf(`
      match [
        targets [ [ id "paris" text "Paris" ] [ id "tokyo" text "Tokyo" ] ] {}
        match-items [ [ text "France" ] ] {}
      ]`);
    expect(msg).toContain('needs `assess [target "…"]`');
    expect(msg).toContain("paris, tokyo");
  });

  test("a target that does not exist", async () => {
    const msg = await errorOf(`
      match [
        targets [ [ id "paris" text "Paris" ] [ id "tokyo" text "Tokyo" ] ] {}
        match-items [ [ text "Peru" assess [ target "lima" ] ] ] {}
      ]`);
    expect(msg).toContain('no target has the id "lima"');
    expect(msg).toContain("`targets` declares: paris, tokyo");
  });

  test("a target with no id, which is what an item would refer to", async () => {
    const msg = await errorOf(`
      match [
        targets [ [ text "Paris" ] [ id "tokyo" text "Tokyo" ] ] {}
        match-items [ [ text "Japan" assess [ target "tokyo" ] ] ] {}
      ]`);
    expect(msg).toContain("needs an `id`");
    expect(msg).toContain('assess [target "…"]');
  });

  test("one target is nothing to decide between", async () => {
    const msg = await errorOf(`
      match [
        targets [ [ id "a" text "A" ] ] {}
        match-items [ [ text "one" assess [ target "a" ] ] ] {}
      ]`);
    expect(msg).toContain("needs at least two targets");
  });

  test("no items at all", async () => {
    const msg = await errorOf(`
      match [ targets [ [ id "a" text "A" ] [ id "b" text "B" ] ] {} ]`);
    expect(msg).toContain("needs its match-items");
  });

  test("a misplaced word names the legal set", async () => {
    const msg = await errorOf(`
      match [
        targets [ [ id "a" text "A" ] [ id "b" text "B" ] ] {}
        match-items [ [ text "one" quote "no" assess [ target "a" ] ] ] {}
      ]`);
    expect(msg).toContain("`quote` is not an attribute of match-item");
    expect(msg).toContain("It takes: id, text, assess");
  });

  test("`category` in a match's assess, and `target` in a classification's", async () => {
    const wrongWord = await errorOf(`
      match [
        targets [ [ id "a" text "A" ] [ id "b" text "B" ] ] {}
        match-items [ [ text "one" assess [ category "a" ] ] ] {}
      ]`);
    expect(wrongWord).toContain("is not part of an `assess` here");
    expect(wrongWord).toContain("It takes: target, points, rationale");

    const other = await errorOf(`
      classification [
        categories [ [ id "a" text "A" ] [ id "b" text "B" ] ] {}
        classification-items [ [ text "one" assess [ target "a" ] ] ] {}
      ]`);
    expect(other).toContain("It takes: category, points, rationale");
  });

  test("`target` is refused on a choice option, where it would be read by nobody", async () => {
    const msg = await errorOf(`
      choice [ options [ [ text "A" assess [ correct target "x" ] ] [ text "B" ] ] {} ]`);
    expect(msg).toContain("is not part of an `assess` here");
  });
});
