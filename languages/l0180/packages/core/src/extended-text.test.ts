// SPDX-License-Identifier: MIT
/**
 * The extended-text interaction — L0175's short-text, and QTI's extendedTextInteraction.
 *
 * The thing worth guarding is the distinction from an unscored item. Both earn nothing here,
 * but an unscored item has nothing to earn while this has points nobody has awarded yet, and
 * collapsing the two would tell a candidate they scored zero on work no one has read.
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

const WRITTEN = `
extended-text [
  prompt "What inference can be made about Mara? Use details from the passage."
  rubric [
    [ points 0 descriptor "No valid inference, or no support from the text." ]
    [ points 2 descriptor "Makes a valid inference and cites two supporting details." ]
    [ points 1 descriptor "Makes a valid inference with one detail, or a partial inference." ]
  ] {}
  exemplar "Mara is absorbed by the tide pool — she ignores the picnic and does not turn around."
]`;

describe("interaction", () => {
  test("carries the stem and nothing else — there is nothing to present", async () => {
    const { interaction } = await compile(WRITTEN);
    expect(interaction).toEqual({
      type: "extended-text",
      prompt: "What inference can be made about Mara? Use details from the passage.",
    });
  });

  test("the rubric and the exemplar stay in the key", async () => {
    const { interaction } = await compile(WRITTEN);
    expect(JSON.stringify(interaction)).not.toContain("valid inference");
    expect(JSON.stringify(interaction)).not.toContain("absorbed");
  });
});

describe("validation", () => {
  test("is scored by a person, and worth the top band", async () => {
    const { validation } = await compile(WRITTEN);
    expect(validation.responseProcessing).toBe("human");
    expect(validation.points).toBe(2);
    expect(validation.exemplar).toContain("tide pool");
  });

  test("bands come back highest first, however they were authored", async () => {
    // The rubric is read top down, and an author listing 0 first should not produce a rubric
    // that reads backwards.
    const { validation } = await compile(WRITTEN);
    expect(validation.rubric.map((b: any) => b.points)).toEqual([2, 1, 0]);
  });

  test("it is not an unscored item — those have nothing to earn", async () => {
    const { validation } = await compile(WRITTEN);
    const poll = await compile(`choice [ options [ [ text "a" ] [ text "b" ] ] {} ]`);
    expect(validation.points).toBeGreaterThan(0);
    expect(poll.validation.points).toBe(0);
    expect(poll.validation.responseProcessing).toBe("map_response");
  });
});

describe("inside an item", () => {
  const MIXED = `
    item [
      stimulus [ paragraphs [ "Mara crouched at the edge of the tide pool." ] ]
      parts [
        choice [
          prompt "What is Mara doing?"
          options [
            [ text "Watching the tide pool." assess [ correct ] ]
            [ text "Eating the picnic." ]
          ] {}
        ]
        ${WRITTEN}
      ] {}
    ]`;

  test("an additive item is worth its choice part plus the written one", async () => {
    const { validation } = await compile(MIXED);
    expect(validation.scoring).toBe("additive");
    expect(validation.points).toBe(3);
    expect(validation.parts["2"].responseProcessing).toBe("human");
  });

  test("a conjunctive item refuses a written part, and says why", async () => {
    // "Every part correct" cannot be decided over a part nothing here can mark.
    const msg = await errorOf(MIXED.replace("parts [", 'scoring "conjunctive" parts ['));
    expect(msg).toContain("written response scored by a person");
    expect(msg).toContain("additive");
  });
});

describe("errors name the fix, not just the fault", () => {
  test("a rubric is required, because a person needs something to mark against", async () => {
    const msg = await errorOf(`extended-text [ prompt "Explain." ]`);
    expect(msg).toContain("needs a rubric of at least two bands");
    expect(msg).toContain("scored by a person");
  });

  test("one band is not a rubric", async () => {
    const msg = await errorOf(`extended-text [ prompt "Explain." rubric [ [ points 2 descriptor "Good." ] ] {} ]`);
    expect(msg).toContain("at least two bands");
  });

  test("a band without a descriptor tells the marker nothing", async () => {
    const msg = await errorOf(`
      extended-text [ prompt "Explain." rubric [ [ points 2 ] [ points 0 descriptor "No." ] ] {} ]`);
    expect(msg).toContain("needs a `descriptor`");
    expect(msg).toContain("tells the person marking it nothing");
  });

  test("two bands cannot share a points value", async () => {
    const msg = await errorOf(`
      extended-text [ rubric [ [ points 1 descriptor "A." ] [ points 1 descriptor "B." ] ] {} ]`);
    expect(msg).toContain("is already band 1");
  });

  test("a rubric where nothing earns anything is refused", async () => {
    const msg = await errorOf(`
      extended-text [ rubric [ [ points 0 descriptor "A." ] [ points -1 descriptor "B." ] ] {} ]`);
    expect(msg).toContain("no band earns anything");
  });

  test("a choice attribute on extended-text lists the legal set", async () => {
    const msg = await errorOf(`
      extended-text [ shuffle true rubric [ [ points 1 descriptor "A." ] [ points 0 descriptor "B." ] ] {} ]`);
    expect(msg).toContain("is not an attribute of extended-text");
    expect(msg).toContain("It takes: prompt, rubric, exemplar");
  });
});
