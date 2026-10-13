// SPDX-License-Identifier: MIT
/**
 * The study model.
 *
 * This is where L0159's bugs lived — a `nextIndex` that returned -1 instead of wrapping, a
 * `prevIndex` that was written and then commented out, and a filter recomputed inline in
 * three places from three slightly different expressions. So it is tested first.
 */
import { test, describe, expect } from "vitest";
import { advance, counts, filterOrder, inStack, positionIn, shuffled } from "./marks";
import type { Marks } from "./marks";

const ORDER = [0, 1, 2, 3];
const MARKS: Marks = { "0": "known", "2": "practice" };

describe("stacks", () => {
  test("all holds everything, rated or not", () => {
    expect(filterOrder(ORDER, MARKS, "all")).toEqual([0, 1, 2, 3]);
  });

  test("unmarked holds only the unrated", () => {
    expect(filterOrder(ORDER, MARKS, "unmarked")).toEqual([1, 3]);
  });

  test("a rating stack holds only its own rating", () => {
    expect(filterOrder(ORDER, MARKS, "known")).toEqual([0]);
    expect(filterOrder(ORDER, MARKS, "practice")).toEqual([2]);
  });

  test("counts add up over the whole deck", () => {
    expect(counts(ORDER, MARKS)).toEqual({ all: 4, unmarked: 2, practice: 1, known: 1 });
  });

  test("an unrated card is unmarked, not practice", () => {
    expect(inStack("unmarked", undefined)).toBe(true);
    expect(inStack("practice", undefined)).toBe(false);
  });

  test("filterOrder preserves study order, not id order", () => {
    expect(filterOrder([3, 1, 2, 0], MARKS, "unmarked")).toEqual([3, 1]);
  });
});

describe("advance", () => {
  const all = [0, 1, 2, 3];

  test("moves forward", () => {
    expect(advance(ORDER, all, 1, 1)).toBe(2);
  });

  test("moves back", () => {
    expect(advance(ORDER, all, 1, -1)).toBe(0);
  });

  test("wraps at the end — L0159 returned -1 here and stranded the learner", () => {
    expect(advance(ORDER, all, 3, 1)).toBe(0);
  });

  test("wraps at the start", () => {
    expect(advance(ORDER, all, 0, -1)).toBe(3);
  });

  test("skips cards outside the stack", () => {
    expect(advance(ORDER, [1, 3], 1, 1)).toBe(3);
    expect(advance(ORDER, [1, 3], 3, 1)).toBe(1);
  });

  test("finds the next card even when the current one has LEFT the stack", () => {
    // This is every rating while studying "Not yet rated": the card stops belonging to the
    // stack the moment it is rated, and the next card is still the one after it in the deck.
    expect(advance(ORDER, [2, 3], 1, 1)).toBe(2);
  });

  test("a single-card stack stays on that card", () => {
    expect(advance(ORDER, [2], 2, 1)).toBe(2);
    expect(advance(ORDER, [2], 2, -1)).toBe(2);
  });

  test("an empty stack has nowhere to go", () => {
    expect(advance(ORDER, [], 1, 1)).toBeNull();
  });

  test("with no current card, start at the top of the stack", () => {
    expect(advance(ORDER, [1, 3], null, 1)).toBe(1);
  });
});

describe("position", () => {
  test("is 1-based within the stack, not the deck", () => {
    expect(positionIn([1, 3], 3)).toBe(2);
  });

  test("is 0 when the card is not in the stack", () => {
    expect(positionIn([1, 3], 2)).toBe(0);
  });
});

describe("shuffle", () => {
  const ids = [0, 1, 2, 3, 4, 5, 6, 7];

  test("keeps every card exactly once", () => {
    expect(
      shuffled(ids, "seed")
        .slice()
        .sort((a, b) => a - b),
    ).toEqual(ids);
  });

  test("is stable for a deck — a recompile must not reorder it mid-pass", () => {
    expect(shuffled(ids, "hola adiós")).toEqual(shuffled(ids, "hola adiós"));
  });

  test("differs between decks", () => {
    expect(shuffled(ids, "hola adiós")).not.toEqual(shuffled(ids, "perro gato"));
  });

  test("actually shuffles", () => {
    expect(shuffled(ids, "hola adiós")).not.toEqual(ids);
  });
});
