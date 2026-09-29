// SPDX-License-Identifier: MIT
/**
 * The deck, end to end: source -> the record the renderer consumes.
 *
 * Assertions are on COMPILED OUTPUT, never on source shape. The surface syntax may change;
 * what the player reads is the contract.
 */
import { test, describe, expect } from "vitest";
import { compile } from "./testing.js";

const CANONICAL = `
cards [
  ["hola"  "hello"]
  ["adiós" "goodbye"]
  ["$x^2$" "x squared"]
] title "Spanish Vocab"
  instructions "Flip to reveal"
  theme LIGHT
  {}..
`;

describe("cards", () => {
  test("the canonical program compiles to the documented shape", async () => {
    expect(await compile(CANONICAL)).toEqual({
      title: "Spanish Vocab",
      instructions: "Flip to reveal",
      theme: "light",
      cards: [
        { id: 0, front: "hola", back: "hello" },
        { id: 1, front: "adiós", back: "goodbye" },
        { id: 2, front: "$x^2$", back: "x squared" },
      ],
    });
  });

  test("a bare deck needs no attributes at all", async () => {
    expect(await compile('cards [["a" "b"]] {}')).toEqual({
      cards: [{ id: 0, front: "a", back: "b" }],
    });
  });

  test("front is the prompt and back is the answer", async () => {
    const { cards } = await compile('cards [["photosynthesis" "plants convert light"]] {}');
    expect(cards[0].front).toBe("photosynthesis");
    expect(cards[0].back).toBe("plants convert light");
  });

  test("ids number the deck in authored order", async () => {
    const { cards } = await compile('cards [["a" "1"] ["b" "2"] ["c" "3"]] {}');
    expect(cards.map((c: any) => c.id)).toEqual([0, 1, 2]);
    expect(cards.map((c: any) => c.front)).toEqual(["a", "b", "c"]);
  });

  test("a card may be a URL on either side", async () => {
    const { cards } = await compile('cards [["https://example.com/dog.png" "dog"]] {}');
    expect(cards[0].front).toBe("https://example.com/dog.png");
  });
});

describe("attributes", () => {
  test("the chain order does not matter", async () => {
    const a = await compile('cards [["a" "b"]] title "T" instructions "I" theme DARK {}');
    const b = await compile('cards [["a" "b"]] theme DARK instructions "I" title "T" {}');
    expect(a).toEqual(b);
  });

  test("theme lowercases its tag", async () => {
    expect((await compile('cards [["a" "b"]] theme DARK {}')).theme).toBe("dark");
    expect((await compile('cards [["a" "b"]] theme LIGHT {}')).theme).toBe("light");
  });

  test("an absent attribute is absent, not null", async () => {
    const out = await compile('cards [["a" "b"]] {}');
    expect("title" in out).toBe(false);
    expect("instructions" in out).toBe(false);
    expect("theme" in out).toBe(false);
  });
});

describe("text passes through as authored", () => {
  // L0159 wrapped titles in `\text{}` and stripped `$…$` from card text, so the renderer
  // could not tell prose from math and ran everything through KaTeX. The compiler emits what
  // the author wrote; deciding what is math is the renderer's job.
  test("math delimiters survive", async () => {
    const { cards } = await compile('cards [["$x^2 + 2x + 1$" "$(x+1)^2$"]] {}');
    expect(cards[0].front).toBe("$x^2 + 2x + 1$");
    expect(cards[0].back).toBe("$(x+1)^2$");
  });

  test("prose is not wrapped", async () => {
    expect((await compile('cards [["a" "b"]] title "Math Facts" {}')).title).toBe("Math Facts");
  });
});

describe("data merges over the compiled deck", () => {
  // Every recompile carries the learner's state back in; it must ride over the deck, not
  // under it, or a rating would be erased by the compile it triggered.
  test("a response survives the recompile", async () => {
    const response = { marks: { "0": "known" }, cardId: 1, stack: "practice" };
    const out = await compile('cards [["a" "b"] ["c" "d"]] {}', { response });
    expect(out.response).toEqual(response);
    expect(out.cards).toHaveLength(2);
  });
});
