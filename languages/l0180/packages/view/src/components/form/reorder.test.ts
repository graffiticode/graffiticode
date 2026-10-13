// SPDX-License-Identifier: MIT
/**
 * The half of dragging that can be wrong without looking wrong.
 *
 * Dropping downward is the case worth the tests: removing the dragged entry shifts everything
 * after it up by one, so "insert at index 3" means two different positions depending on which
 * direction the drag went. An off-by-one here does not throw or render oddly — it mis-scores.
 */
import { test, describe, expect } from "vitest";
import { reorder } from "./reorder";

const L = ["a", "b", "c", "d"];

describe("reorder", () => {
  test("moving up puts the entry at the target index", () => {
    expect(reorder(L, 2, 0)).toEqual(["c", "a", "b", "d"]);
    expect(reorder(L, 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  test("moving down lands where the candidate dropped it, not one short", () => {
    expect(reorder(L, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(reorder(L, 0, 3)).toEqual(["b", "c", "d", "a"]);
    expect(reorder(L, 1, 3)).toEqual(["a", "c", "d", "b"]);
  });

  test("an adjacent move is the swap the buttons always did", () => {
    expect(reorder(L, 1, 0)).toEqual(["b", "a", "c", "d"]);
    expect(reorder(L, 1, 2)).toEqual(["a", "c", "b", "d"]);
  });

  test("a move to where it already is changes nothing", () => {
    expect(reorder(L, 2, 2)).toBe(L);
  });

  test("out of range is a no-op, not a crash or a lost entry", () => {
    expect(reorder(L, -1, 2)).toBe(L);
    expect(reorder(L, 0, 9)).toBe(L);
    expect(reorder(L, 4, 0)).toBe(L);
  });

  test("every entry survives exactly once, wherever it went", () => {
    for (let from = 0; from < L.length; from++) {
      for (let to = 0; to < L.length; to++) {
        expect(reorder(L, from, to).slice().sort(), `${from}->${to}`).toEqual(["a", "b", "c", "d"]);
      }
    }
  });

  test("the input is not mutated", () => {
    const list = [...L];
    reorder(list, 0, 3);
    expect(list).toEqual(L);
  });
});
