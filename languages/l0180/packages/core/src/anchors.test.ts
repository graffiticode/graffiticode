// SPDX-License-Identifier: MIT
/**
 * The two rules that decide when a list keeps its authored order.
 *
 * Both only apply when the author said nothing about `shuffle`, so the cost of a false positive
 * is an item that does not randomize when it could — and the cost of a false negative is an
 * item whose meaning was in its order and lost it. The near-misses matter more than the hits.
 */
import { test, describe, expect } from "vitest";
import { isAnchored, keepsOrder } from "./anchors.js";

describe("isAnchored", () => {
  test("the phrases that only make sense last", () => {
    for (const t of [
      "All of the above",
      "all of the above",
      "All of the above.",
      "None of the above",
      "none of these",
      "Both of the above",
      "  All of the answers above  ",
    ]) {
      expect(isAnchored(t), t).toBe(true);
    }
  });

  test("near-misses that are ordinary answers, and must shuffle like any other", () => {
    for (const t of [
      "None of these apply",
      "All of the following",
      "The above ground portion of the plant",
      "Above",
      "All of them were present at the signing",
      "Neither Paris nor Lyon",
      "",
    ]) {
      expect(isAnchored(t), t).toBe(false);
    }
  });
});

describe("keepsOrder", () => {
  test("numbers in ascending or descending order are a chosen order", () => {
    expect(keepsOrder(["2", "4", "5", "9", "11"])).toBe(true);
    expect(keepsOrder(["11", "9", "5", "4", "2"])).toBe(true);
    expect(keepsOrder(["0.5", "1/2 is not this", "2"])).toBe(false);
    expect(keepsOrder(["-3", "0", "0.5", "1/2"])).toBe(false); // 0.5 then 1/2 is not ascending
    expect(keepsOrder(["1/4", "1/2", "3/4"])).toBe(true);
  });

  test("numbers out of order are evidence nobody chose one", () => {
    expect(keepsOrder(["9", "2", "11", "4", "5"])).toBe(false);
    expect(keepsOrder(["2", "2"])).toBe(false);
  });

  test("a list that is not numbers at all is shuffled", () => {
    expect(keepsOrder(["Paris", "Lyon", "Marseille"])).toBe(false);
    expect(keepsOrder(["2", "4", "Paris"])).toBe(false);
  });

  test("true/false and yes/no keep their conventional order", () => {
    expect(keepsOrder(["True", "False"])).toBe(true);
    expect(keepsOrder(["Yes", "No"])).toBe(true);
    // Only in that order, and only as the whole list: reversed, the author chose the reversal.
    expect(keepsOrder(["False", "True"])).toBe(false);
    expect(keepsOrder(["True", "False", "It depends"])).toBe(false);
  });

  test("a list too short to have an order keeps it", () => {
    expect(keepsOrder([])).toBe(true);
    expect(keepsOrder(["Only one"])).toBe(true);
  });
});
