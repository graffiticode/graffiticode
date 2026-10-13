// SPDX-License-Identifier: MIT
/**
 * The item wrapper and the stimulus.
 *
 * The shape under test is the one an EBSR-style item needs: a passage, two parts, and
 * conjunctive scoring — both parts right for one point, not one point each.
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

/** A two-part evidence item: infer a claim, then cite the line supporting it. */
const EBSR = `
item [
  stimulus [
    title "The Loose Board"
    paragraphs [
      "Nina had walked past the crooked porch a hundred times."
      "Then she knelt down and set the first nail without anyone asking her to."
    ]
  ]
  scoring "conjunctive"
  parts [
    choice [
      prompt "What can the reader conclude about Nina?"
      options [
        [ text "She takes care of a problem on her own." assess [ correct ] ]
        [ text "She is afraid of the neighbours." ]
      ] {}
    ]
    choice [
      prompt "Which line best supports your answer to Part A?"
      options [
        [ text "Nina had walked past the crooked porch a hundred times." ]
        [ text "Then she knelt down and set the first nail." assess [ correct ] ]
      ] {}
    ]
  ] {}
]..
`;

describe("stimulus", () => {
  test("paragraphs are addressable, in authored order", async () => {
    const { interaction } = await compile(EBSR);
    expect(interaction.stimulus).toEqual({
      title: "The Loose Board",
      paragraphs: [
        { id: "p1", text: "Nina had walked past the crooked porch a hundred times." },
        { id: "p2", text: "Then she knelt down and set the first nail without anyone asking her to." },
      ],
    });
  });

  test("is optional, and a title is optional within it", async () => {
    const a = await compile(`item [ parts [ choice [ options [ [ text "x" ] ] {} ] ] {} ]`);
    expect(a.interaction.stimulus).toBeUndefined();
    const b = await compile(`
      item [ stimulus [ paragraphs [ "One." ] ] parts [ choice [ options [ [ text "x" ] ] {} ] ] {} ]
    `);
    expect(b.interaction.stimulus).toEqual({ paragraphs: [{ id: "p1", text: "One." }] });
  });

  test("the answer key does not leak into the half that ships", async () => {
    const { interaction } = await compile(EBSR);
    expect(JSON.stringify(interaction)).not.toContain("correct");
  });
});

describe("parts", () => {
  test("carry stable numeric ids, distinct from letter option ids", async () => {
    const { interaction, validation } = await compile(EBSR);
    expect(interaction.parts.map((p: any) => p.id)).toEqual(["1", "2"]);
    expect(Object.keys(validation.parts)).toEqual(["1", "2"]);
    // Options inside a part keep their own letters, so the two namespaces cannot be confused.
    expect(interaction.parts[0].options.map((o: any) => o.id)).toEqual(["A", "B"]);
  });

  test("each part keeps its own interaction shape", async () => {
    const { interaction } = await compile(EBSR);
    expect(interaction.parts[0].type).toBe("choice");
    expect(interaction.parts[0].prompt).toBe("What can the reader conclude about Nina?");
  });
});

describe("scoring modes", () => {
  test("conjunctive is worth one point for the whole item, not one per part", async () => {
    const { validation } = await compile(EBSR);
    expect(validation.scoring).toBe("conjunctive");
    expect(validation.points).toBe(1);
    // ...while each part still carries its own key, which is what the scorer walks.
    expect(validation.parts["1"]).toEqual({
      responseProcessing: "map_response",
      cardinality: "single",
      baseType: "identifier",
      points: 1,
      mapping: { A: { correct: true, points: 1 } },
    });
    expect(validation.parts["2"]).toEqual({
      responseProcessing: "map_response",
      cardinality: "single",
      baseType: "identifier",
      points: 1,
      mapping: { B: { correct: true, points: 1 } },
    });
  });

  test("conjunctive takes an authored points override", async () => {
    const { validation } = await compile(EBSR.replace('scoring "conjunctive"', 'scoring "conjunctive" points 3'));
    expect(validation.points).toBe(3);
  });

  test("additive is the default and sums the parts", async () => {
    const { validation } = await compile(EBSR.replace('scoring "conjunctive"', ""));
    expect(validation.scoring).toBe("additive");
    expect(validation.points).toBe(2);
  });
});

describe("errors name the fix", () => {
  test("an item with no parts", async () => {
    expect(await errorOf(`item [ stimulus [ paragraphs [ "One." ] ] ]`)).toContain(
      "needs at least one part",
    );
  });

  test("points on an additive item, where it would be a second disagreeing answer", async () => {
    const msg = await errorOf(`item [ points 5 parts [ choice [ options [ [ text "x" assess [ correct ] ] ] {} ] ] {} ]`);
    expect(msg).toContain('only meaningful with `scoring "conjunctive"`');
  });

  test("conjunctive scoring over a part that earns nothing", async () => {
    const msg = await errorOf(`
      item [
        scoring "conjunctive"
        parts [
          choice [ options [ [ text "a" assess [ correct ] ] ] {} ]
          choice [ options [ [ text "b" ] ] {} ]
        ] {}
      ]
    `);
    expect(msg).toContain("every part to be scoreable");
    expect(msg).toContain("part 2");
  });

  test("an unknown scoring mode lists the legal ones", async () => {
    const msg = await errorOf(`item [ scoring "average" parts [ choice [ options [ [ text "x" ] ] {} ] ] {} ]`);
    expect(msg).toContain("is not a scoring mode");
    expect(msg).toContain("additive, conjunctive");
  });

  test("a part that is not an interaction", async () => {
    expect(await errorOf(`item [ parts [ [ text "not an interaction" ] ] {} ]`)).toContain(
      "entry 1 is not an interaction",
    );
  });

  test("a stimulus attribute written on the item says where it belongs", async () => {
    const msg = await errorOf(`item [ title "oops" parts [ choice [ options [ [ text "x" ] ] {} ] ] {} ]`);
    expect(msg).toContain("is not an attribute of item");
    expect(msg).toContain("It takes: stimulus, scoring, points, parts");
    expect(msg).toContain("belongs inside `stimulus`");
  });

  test("paragraphs must be a list of non-empty strings", async () => {
    expect(await errorOf(`item [ stimulus [ paragraphs "just one" ] parts [ choice [ options [ [ text "x" ] ] {} ] ] {} ]`))
      .toContain("expected a list of strings");
    expect(await errorOf(`item [ stimulus [ paragraphs [ "ok" 42 ] ] parts [ choice [ options [ [ text "x" ] ] {} ] ] {} ]`))
      .toContain("entry 2");
  });
});
