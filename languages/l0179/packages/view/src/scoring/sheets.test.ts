// SPDX-License-Identifier: MIT
/** A sheet's grid scores its bare cells against that sheet's own key, or it colours nothing. */
import { describe, expect, test } from "vitest";
import { scoreCells } from "./score.js";
import { sheetValidation } from "./sheets.js";

const key = (expected: string, points: number) => ({
  points,
  regions: { "*": { primaryColumn: null, order: "expected", rows: [
    { id: 1, A: { assess: { method: "value", expected, points } } },
  ] } },
  cells: {},
});
const validation = { ...key("10", 2), points: 5, sheets: { s1: key("10", 2), s2: key("20", 3) } };

describe("sheetValidation", () => {
  test("gives a sheet's grid its own key, so its bare cells score by bare name", () => {
    // Sheet 2's grid holds a bare A1. Against the whole key its score came back as `s2!A1` or
    // `s1!A1` and the grid, looking up `A1`, coloured nothing.
    const whole = scoreCells({ cells: { A1: { text: "20", val: "20" } }, validation });
    expect(whole.A1?.score).toBeUndefined();
    const own = scoreCells({ cells: { A1: { text: "20", val: "20" } }, validation: sheetValidation(validation, "s2") });
    expect(own.A1?.score?.isValid).toBe(true);
  });

  test("leaves a one-sheet key alone", () => {
    const one = key("4", 1);
    expect(sheetValidation(one, "s1")).toBe(one);
  });
});
