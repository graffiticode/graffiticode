// SPDX-License-Identifier: MIT
/**
 * `gap-match` — a sentence filled from a shared bank.
 *
 * Assembled from two halves that already existed, so most of what could break is the seam: the
 * sentence is cut by `text-entry`'s marker machinery and the key is `match`'s mapping over
 * pairs. The tests that matter are the ones about the bank, which is the thing that makes this
 * a different question from `inline-choice` rather than a second spelling of it.
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

const ORBIT = `
gap-match [
  prompt "Complete the sentence."
  text "The {{a}} orbits the {{b}}."
  tokens [
    [ id "moon" text "Moon" ]
    [ id "earth" text "Earth" ]
    [ id "sun" text "Sun" ]
  ] {}
  gaps [
    [ id "a" assess [ token "moon" ] ]
    [ id "b" assess [ token "earth" ] ]
  ] {}
]`;

describe("interaction — the sentence and the bank", () => {
  test("the text is cut at its markers and the bank ships whole", async () => {
    const { interaction } = await compile(ORBIT);
    expect(interaction.type).toBe("gap-match");
    expect(interaction.segments).toEqual([
      { text: "The " },
      { id: "a", gap: true },
      { text: " orbits the " },
      { id: "b", gap: true },
      { text: "." },
    ]);
    expect(interaction.tokens).toEqual([
      { id: "moon", text: "Moon" },
      { id: "earth", text: "Earth" },
      { id: "sun", text: "Sun" },
    ]);
  });

  test("nothing in the half that ships says which token fills which gap", async () => {
    const { interaction } = await compile(ORBIT);
    const shipped = JSON.stringify(interaction);
    expect(shipped).not.toContain("correct");
    expect(shipped).not.toContain("a moon");
  });

  test("a token no gap names is a distractor, and stays in the bank", async () => {
    const { interaction, validation } = await compile(ORBIT);
    expect(interaction.tokens.map((t: any) => t.id)).toContain("sun");
    expect(Object.keys(validation.mapping).join(" ")).not.toContain("sun");
  });
});

describe("validation — match's key, unchanged", () => {
  test("a mapping over pairs, in QTI's directedPair spelling", async () => {
    const { validation } = await compile(ORBIT);
    expect(validation).toEqual({
      responseProcessing: "map_response",
      cardinality: "multiple",
      baseType: "directedPair",
      points: 2,
      mapping: {
        "a moon": { correct: true, points: 1 },
        "b earth": { correct: true, points: 1 },
      },
    });
  });

  test("a point per gap, summed, so several gaps give partial credit", async () => {
    const { validation } = await compile(`
      gap-match [
        text "{{a}} then {{b}} then {{c}}."
        tokens [ [ id "x" text "X" ] [ id "y" text "Y" ] [ id "z" text "Z" ] ] {}
        gaps [
          [ id "a" assess [ token "x" points 2 ] ]
          [ id "b" assess [ token "y" ] ]
          [ id "c" assess [ token "z" ] ]
        ] {}
      ]`);
    expect(validation.points).toBe(4);
    expect(validation.mapping["a x"]).toEqual({ correct: true, points: 2 });
  });

  test("match-correct makes the whole sentence one point", async () => {
    const { validation } = await compile(`
      gap-match [
        response-processing "match-correct"
        text "The {{a}} orbits the {{b}}."
        tokens [ [ id "moon" text "Moon" ] [ id "earth" text "Earth" ] ] {}
        gaps [ [ id "a" assess [ token "moon" ] ] [ id "b" assess [ token "earth" ] ] ] {}
      ]`);
    expect(validation.points).toBe(1);
    expect(validation.correctResponse).toEqual(["a moon", "b earth"]);
  });
});

describe("a token is spent when it is used", () => {
  test("two gaps wanting the same token is refused, and names the way out", async () => {
    // A token is dragged, not copied. An item asking for the same one twice cannot be finished.
    const msg = await errorOf(`
      gap-match [
        text "{{a}} and {{b}}."
        tokens [ [ id "x" text "X" ] [ id "y" text "Y" ] ] {}
        gaps [ [ id "a" assess [ token "x" ] ] [ id "b" assess [ token "x" ] ] ] {}
      ]`);
    expect(msg).toContain('gap 1 already takes "x"');
    expect(msg).toContain("use `inline-choice`");
  });
});

describe("inside an item", () => {
  test("it is a part like any other", async () => {
    const { interaction, validation } = await compile(`
      item [
        parts [
          ${ORBIT.trim()}
          choice [ options [ [ text "Yes" assess [ correct ] ] [ text "No" ] ] {} ]
        ] {}
      ]`);
    expect(interaction.parts.map((p: any) => [p.id, p.type])).toEqual([
      ["1", "gap-match"],
      ["2", "choice"],
    ]);
    expect(validation.parts["1"].baseType).toBe("directedPair");
  });
});

describe("errors name the fix", () => {
  test("a marker no gap declares", async () => {
    const msg = await errorOf(`
      gap-match [
        text "The {{a}} orbits the {{c}}."
        tokens [ [ id "moon" text "Moon" ] [ id "earth" text "Earth" ] ] {}
        gaps [ [ id "a" assess [ token "moon" ] ] ] {}
      ]`);
    expect(msg).toContain("{{c}} but no gap declares that id");
  });

  test("a gap with no marker", async () => {
    const msg = await errorOf(`
      gap-match [
        text "The {{a}} orbits."
        tokens [ [ id "moon" text "Moon" ] [ id "earth" text "Earth" ] ] {}
        gaps [
          [ id "a" assess [ token "moon" ] ]
          [ id "b" assess [ token "earth" ] ]
        ] {}
      ]`);
    expect(msg).toContain('gap "b" has no {{b}}');
    expect(msg).toContain("be dragged into it");
  });

  test("a gap naming a token that is not in the bank", async () => {
    const msg = await errorOf(`
      gap-match [
        text "The {{a}} orbits."
        tokens [ [ id "moon" text "Moon" ] [ id "earth" text "Earth" ] ] {}
        gaps [ [ id "a" assess [ token "mars" ] ] ] {}
      ]`);
    expect(msg).toContain('no token has the id "mars"');
    expect(msg).toContain("`tokens` declares: moon, earth");
  });

  test("a gap with no token at all", async () => {
    const msg = await errorOf(`
      gap-match [
        text "The {{a}} orbits."
        tokens [ [ id "moon" text "Moon" ] [ id "earth" text "Earth" ] ] {}
        gaps [ [ id "a" ] ] {}
      ]`);
    expect(msg).toContain('needs `assess [token "…"]`');
    expect(msg).toContain("moon, earth");
  });

  test("a token with no id, which is what a gap refers to", async () => {
    const msg = await errorOf(`
      gap-match [
        text "The {{a}} orbits."
        tokens [ [ text "Moon" ] [ id "earth" text "Earth" ] ] {}
        gaps [ [ id "a" assess [ token "earth" ] ] ] {}
      ]`);
    expect(msg).toContain("needs an `id`");
  });

  test("no text, and no tokens", async () => {
    const noText = await errorOf(`
      gap-match [ tokens [ [ id "a" text "A" ] [ id "b" text "B" ] ] {} gaps [ [ id "a" assess [ token "a" ] ] ] {} ]`);
    expect(noText).toContain("needs the sentence its gaps sit in");
    const noBank = await errorOf(`gap-match [ text "A {{a}} thing." gaps [ [ id "a" assess [ token "x" ] ] ] {} ]`);
    expect(noBank).toContain("needs the bank its gaps are filled from");
  });

  test("a misplaced word names the legal set", async () => {
    const msg = await errorOf(`
      gap-match [
        text "The {{a}} orbits."
        tokens [ [ id "moon" text "Moon" ] [ id "earth" text "Earth" ] ] {}
        gaps [ [ id "a" text "no" assess [ token "moon" ] ] ] {}
      ]`);
    expect(msg).toContain("`text` is not an attribute of gap");
    expect(msg).toContain("It takes: id, assess");
  });

  test("`token` is refused in any other assess", async () => {
    const msg = await errorOf(`
      choice [ options [ [ text "A" assess [ correct token "x" ] ] [ text "B" ] ] {} ]`);
    expect(msg).toContain("is not part of an `assess` here");
  });
});
