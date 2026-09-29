// SPDX-License-Identifier: MIT
/**
 * The text-entry interaction — fill in the blank.
 *
 * Every scoring statement in L0180 is an `assess` on the thing being scored, and here that thing
 * is each answer a blank recognizes. That is what lets a typed mistake be explained back the way
 * a chosen one is.
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
text-entry [
  prompt "Complete the sentence."
  text "The capital of France is {{capital}}."
  blanks [
    [ id "capital"
      responses [
        [ response "Paris" assess [ correct ] ]
        [ response "Lyon" assess [ rationale "The largest city after Paris, not the capital." ] ]
      ] {} ]
  ] {}
]`;

const TWO = `
text-entry [
  text "The capital of France is {{france}}, and of Italy is {{italy}}."
  blanks [
    [ id "france" responses [ [ response "Paris" assess [ correct ] ] ] {} ]
    [ id "italy" responses [
        [ response "Rome" assess [ correct ] ]
        [ response "Roma" assess [ correct ] ]
      ] {} ]
  ] {}
]`;

/** A numeric blank carrying one extra attribute, for the errors that need one. */
const numeric = (extra: string) => `
text-entry [
  text "Half of one is {{half}}."
  blanks [
    [ id "half" base-type "float" ${extra}
      responses [ [ response "0.5" assess [ correct ] ] ] {} ]
  ] {}
]`;

describe("interaction", () => {
  test("the sentence arrives cut into text and blanks", async () => {
    const { interaction } = await compile(ONE);
    expect(interaction).toEqual({
      type: "text-entry",
      prompt: "Complete the sentence.",
      segments: [
        { text: "The capital of France is " },
        { id: "capital", blank: true },
        { text: "." },
      ],
    });
  });

  test("no recognized answer reaches the half that ships to the browser", async () => {
    const { interaction } = await compile(ONE);
    const shipped = JSON.stringify(interaction);
    expect(shipped).not.toContain("Paris");
    expect(shipped).not.toContain("Lyon");
    expect(shipped).not.toContain("largest city");
  });

  test("nothing in it betrays how long an answer is", async () => {
    const { interaction } = await compile(ONE);
    expect(JSON.stringify(interaction)).not.toContain("Length");
  });
});

describe("validation", () => {
  test("each blank carries what it recognizes, in the shape a choice option has", async () => {
    const { validation } = await compile(ONE);
    expect(validation).toEqual({
      responseProcessing: "map_response",
      cardinality: "single",
      points: 1,
      mapping: {
        capital: {
          baseType: "string",
          points: 1,
          caseSensitive: false,
          responses: [
            { response: "Paris", correct: true, points: 1 },
            { response: "Lyon", points: 0, rationale: "The largest city after Paris, not the capital." },
          ],
        },
      },
    });
  });

  test("the interaction is worth the sum of its blanks", async () => {
    const { validation } = await compile(TWO);
    expect(validation.points).toBe(2);
    expect(validation.mapping.france.points).toBe(1);
    expect(validation.mapping.italy.points).toBe(1);
  });

  test("a blank is worth its best correct answer, not their sum", async () => {
    // Two correct answers worth 2 and 1 make a blank worth 2, because only one can be typed.
    const { validation } = await compile(`
      text-entry [
        text "The capital is {{a}}."
        blanks [ [ id "a" responses [
          [ response "Paris" assess [ correct points 2 ] ]
          [ response "Paree" assess [ correct points 1 ] ]
        ] {} ] ] {}
      ]`);
    expect(validation.mapping.a.points).toBe(2);
    expect(validation.points).toBe(2);
  });

  test("a near-miss, a penalty and an explanation all fit", async () => {
    const { validation } = await compile(`
      text-entry [
        text "The capital is {{a}}."
        blanks [ [ id "a" responses [
          [ response "Paris" assess [ correct ] ]
          [ response "paris france" assess [ points 1 ] ]
          [ response "London" assess [ points -1 rationale "That is the capital of England." ] ]
        ] {} ] ] {}
      ]`);
    const rs = validation.mapping.a.responses;
    expect(rs[1]).toEqual({ response: "paris france", points: 1 });
    expect(rs[2]).toEqual({
      response: "London",
      points: -1,
      rationale: "That is the capital of England.",
    });
  });

  test("case sensitivity resolves onto the blank, overridable", async () => {
    const { validation } = await compile(`
      text-entry [
        text "The agency {{agency}} launched from {{place}}."
        case-sensitive false
        blanks [
          [ id "agency" case-sensitive true
            responses [ [ response "NASA" assess [ correct ] ] ] {} ]
          [ id "place" responses [ [ response "Cape Canaveral" assess [ correct ] ] ] {} ]
        ] {}
      ]`);
    expect(validation.mapping.agency.caseSensitive).toBe(true);
    expect(validation.mapping.place.caseSensitive).toBe(false);
    expect(validation.caseSensitive).toBeUndefined();
  });
});

describe("inside an item", () => {
  test("all-or-nothing across blanks is a conjunctive item, as it is for hottext", async () => {
    const { validation } = await compile(`
      item [ scoring "conjunctive" points 1 parts [ ${TWO} ] {} ]`);
    expect(validation.scoring).toBe("conjunctive");
    expect(validation.points).toBe(1);
    expect(validation.parts["1"].mapping.france.baseType).toBe("string");
  });

  test("it sits beside a choice in one item", async () => {
    const { interaction, validation } = await compile(`
      item [
        parts [
          choice [ prompt "Which continent?" options [ [ text "Europe" assess [ correct ] ] ] {} ]
          ${ONE}
        ] {}
      ]`);
    expect(interaction.parts.map((p: any) => p.type)).toEqual(["choice", "text-entry"]);
    expect(validation.points).toBe(2);
  });
});

describe("errors name the fix, not just the fault", () => {
  test("no text", async () => {
    const msg = await errorOf(
      `text-entry [ blanks [ [ id "a" responses [ [ response "x" assess [ correct ] ] ] {} ] ] {} ]`,
    );
    expect(msg).toContain("needs the sentence it blanks out");
  });

  test("no blanks", async () => {
    const msg = await errorOf(`text-entry [ text "A {{a}}." blanks [] {} ]`);
    expect(msg).toContain("needs at least one blank");
  });

  test("a marker with no blank lists the declared ids", async () => {
    const msg = await errorOf(ONE.replace("{{capital}}", "{{captial}}"));
    expect(msg).toContain("no blank declares that id");
    expect(msg).toContain("declares: capital");
  });

  test("two responses that normalize alike are ambiguous", async () => {
    const msg = await errorOf(
      ONE.replace('[ response "Lyon" assess [ rationale "The largest city after Paris, not the capital." ] ]',
                  '[ response "paris" assess [ correct ] ]'),
    );
    expect(msg).toContain("same answer as response 1");
    expect(msg).toContain("case-sensitive true");
  });

  test("a blank with no correct response cannot be scored", async () => {
    const msg = await errorOf(
      ONE.replace('[ response "Paris" assess [ correct ] ]', '[ response "Paris" assess [ points 1 ] ]'),
    );
    expect(msg).toContain("no response is marked `correct`");
  });

  test("a response with no assess", async () => {
    const msg = await errorOf(
      `text-entry [ text "A {{a}}." blanks [ [ id "a" responses [ [ response "x" ] ] {} ] ] {} ]`,
    );
    expect(msg).toContain("needs an `assess` saying what");
  });

  test("a choice attribute on text-entry lists the legal set", async () => {
    const msg = await errorOf(`
      text-entry [ shuffle true text "A {{a}}."
        blanks [ [ id "a" responses [ [ response "x" assess [ correct ] ] ] {} ] ] {} ]`);
    expect(msg).toContain("is not an attribute of text-entry");
    expect(msg).toContain("It takes: prompt, text, case-sensitive, blanks");
  });

  test("an old-style attribute inside a response lists the legal set", async () => {
    const msg = await errorOf(`
      text-entry [ text "A {{a}}."
        blanks [ [ id "a" responses [ [ text "x" assess [ correct ] ] ] {} ] ] {} ]`);
    expect(msg).toContain("is not an attribute of response");
    expect(msg).toContain("It takes: response, assess");
  });

  test("a form nobody has heard of names the ones that exist", async () => {
    const msg = await errorOf(numeric('input-formats [ "octal" ]'));
    expect(msg).toContain('"octal" is not one of the values `input-formats` takes');
    expect(msg).toContain("numeric, decimal, fraction, scientific");
  });

  test("a bare string says a list is wanted, and shows real values in the example", async () => {
    // A closed set that illustrated itself with `["First." "Second."]` would be teaching the
    // generator to guess, in the one message it reads when it has already guessed wrong.
    const msg = await errorOf(numeric('input-formats "fraction"'));
    expect(msg).toContain("expected a list of strings");
    expect(msg).toContain('input-formats ["numeric" "decimal"]');
  });
});
