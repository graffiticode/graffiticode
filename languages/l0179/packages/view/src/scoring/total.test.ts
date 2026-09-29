// SPDX-License-Identifier: MIT
/** The Check button's score: the Learnosity scorer's sum, over the live /form model. */
import { test, expect, describe } from "vitest";
import { score } from "./index.js";

const oneSheetValidation = (expected: string, points: number) => ({
  points,
  regions: { "*": { primaryColumn: null, order: "expected", rows: [
    { id: 1, A: { assess: { method: "value", expected, points } } },
  ] } },
  cells: {},
});

describe("score", () => {
  test("is undefined with no answer key — no Check button for a display grid", () => {
    expect(score({ interaction: { type: "table", cells: { A1: { text: "x" } } } })).toBeUndefined();
    expect(score(undefined)).toBeUndefined();
  });

  test("is undefined when the answer key assesses no cell", () => {
    expect(score({ validation: { points: 0, regions: {}, cells: {} } })).toBeUndefined();
  });

  test("scores nothing answered as zero out of the total", () => {
    expect(score({ validation: oneSheetValidation("4", 2) })).toEqual({ score: 0, max: 2, complete: false });
  });

  test("sums the points of the right answers in the response map", () => {
    const data = {
      validation: oneSheetValidation("4", 2),
      cells: { A1: { text: "4", val: "4", type: "number" } },
    };
    expect(score(data)).toEqual({ score: 2, max: 2, complete: true });
    expect(score({ ...data, cells: { A1: { text: "5", val: "5", type: "number" } } }))
      .toEqual({ score: 0, max: 2, complete: true });
  });

  test("with several sheets each sheet's answer counts against its own key", () => {
    const validation = {
      ...oneSheetValidation("10", 2),
      points: 5,
      sheets: { s1: oneSheetValidation("10", 2), s2: oneSheetValidation("20", 3) },
    };
    const cells = {
      "s1!A1": { val: "10", type: "number" },
      "s2!A1": { val: "20", type: "number" },
    };
    expect(score({ validation, cells })).toEqual({ score: 5, max: 5, complete: true });
    expect(score({ validation, cells: { "s2!A1": cells["s2!A1"] } })).toEqual({ score: 3, max: 5, complete: false });
  });

  test("is complete only when every assessed cell holds an answer", () => {
    const validation = oneSheetValidation("4", 2);
    expect(score({ validation, cells: { A1: { text: "  " } } })?.complete).toBe(false);
    expect(score({ validation, cells: { A1: { text: "7" } } })?.complete, "a wrong answer is still an answer").toBe(true);
    // Untouched, but authored with text: nothing is left for the learner to fill.
    expect(score({ validation, interaction: { cells: { A1: { text: "3" } } } })?.complete).toBe(true);
  });
});
