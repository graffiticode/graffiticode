// SPDX-License-Identifier: MIT
/**
 * Scoring is the half of this package that decides whether a learner got it right, and it is the
 * half that runs SERVER-side in Learnosity, where nobody sees it go wrong — a mis-scored item
 * just quietly awards the wrong mark. So it is tested directly rather than through the grid.
 *
 * These cases were pinned while transcribing L0166's implementation (see score.ts) and verified
 * against it over all 129 corpus programs before the dependency was removed. They exist so the
 * behaviour cannot drift now that there is nothing left to differential-test against.
 */
import { test, expect, describe } from "vitest";
import {
  scoreCells, getCellsValidation, scoreCell,
  splitKey, splitBySheet, qualify, responseOverlay,
} from "./index.js";

/** The compiled `validation` shape: one region, rows indexed from 1, cells carrying `assess`. */
const validationOf = (rows: any[], extra: any = {}) => ({
  points: 0,
  regions: { "*": { primaryColumn: null, order: "expected", rows, ...extra } },
  cells: {},
});

describe("scoreCell", () => {
  test("a value is compared after normalization, not as raw text", () => {
    // "1,234.56" and "1234.56" are the same number; the response carries the normalized `val`.
    const assess = { method: "value", expected: "1,234.56", points: 3 };
    expect(scoreCell(assess, { val: "1234.56", type: "number" })).toEqual({ points: 3, isValid: true });
  });

  test("a type mismatch fails even when the strings would match", () => {
    const assess = { method: "value", expected: "5", points: 1 };
    expect(scoreCell(assess, { val: "5", type: "text" }).isValid).toBe(false);
  });

  test("points default to 1 and a wrong answer scores 0, not the authored points", () => {
    expect(scoreCell({ method: "value", expected: "7" }, { val: "8", type: "number" }))
      .toEqual({ points: 0, isValid: false });
  });

  test("points 0 is preserved on a CORRECT answer rather than defaulting to 1", () => {
    // An unassessed-but-present cell is authored `points 0`; awarding it 1 would inflate scores.
    expect(scoreCell({ method: "value", expected: "7", points: 0 }, { val: "7", type: "number" }))
      .toEqual({ points: 0, isValid: true });
  });

  test("an undefined response never scores, even against an undefined expectation", () => {
    expect(scoreCell({ method: "value", expected: undefined }, { val: undefined }).isValid).toBe(false);
  });

  test("formula method compares normalized formula text, so case and spacing do not matter", () => {
    const assess = { method: "formula", expected: "=SUM(A1:A3)", points: 2 };
    expect(scoreCell(assess, { formula: "=sum(a1:a3)" })).toEqual({ points: 2, isValid: true });
  });

  test("an expected written with POWER is evaluated exactly, not through Math.pow", () => {
    // 1.05^4 is 1.21550625. A float would make it 1.2155062500000004 and nothing a learner can
    // type would ever match, so scoring is where POWER's use of Decimal earns its keep.
    const assess = { method: "value", expected: "=POWER(A1,4)", points: 1 };
    const interactionCells = { A1: { text: "1.05" } };
    expect(scoreCell(assess, { val: "1.21550625", type: "number" }, interactionCells))
      .toEqual({ points: 1, isValid: true });
  });

  test("an expected dividing by a call grades against the value, not a concatenation", () => {
    // Before function calls next to `*` and `/` were bracketed, this expected evaluated to the
    // text "100B1,B2" and no response could match it. See prepareFormula.
    const assess = { method: "value", expected: "=A1/POWER(B1,B2)", points: 1 };
    const interactionCells = { A1: { text: "100" }, B1: { text: "2" }, B2: { text: "3" } };
    expect(scoreCell(assess, { val: "12.5", type: "number" }, interactionCells))
      .toEqual({ points: 1, isValid: true });
  });

  test("an expected with absolute references and string literals is evaluated", () => {
    const interactionCells = { A1: { text: "21" }, B4: { text: "30" } };
    expect(scoreCell({ method: "value", expected: "=$A$1*2", points: 1 }, { val: "42", type: "number" }, interactionCells))
      .toEqual({ points: 1, isValid: true });
    expect(scoreCell({ method: "value", expected: '=IF(A1>$B$4,"over","under")', points: 1 }, { val: "under", type: "text" }, interactionCells))
      .toEqual({ points: 1, isValid: true });
  });

  test("an expected using <> grades on the comparison, not always the true branch", () => {
    const interactionCells = { A1: { text: "5" }, A2: { text: "5" } };
    expect(scoreCell({ method: "value", expected: '=IF(A1<>A2,"diff","same")', points: 1 }, { val: "same", type: "text" }, interactionCells))
      .toEqual({ points: 1, isValid: true });
  });

  test("formula method treats $B$4 and B4 as the same reference", () => {
    const assess = { method: "formula", expected: "=SUM(A1:A3)*B4", points: 1 };
    expect(scoreCell(assess, { formula: "=SUM($A$1:$A$3)*$B$4" })).toEqual({ points: 1, isValid: true });
  });

  test("an expected written as a formula is evaluated against the authored grid", () => {
    // `expected "=A1*2"` must grade against whatever A1 holds this render.
    const assess = { method: "value", expected: "=A1*2", points: 1 };
    const interactionCells = { A1: { text: "21" } };
    expect(scoreCell(assess, { val: "42", type: "number" }, interactionCells))
      .toEqual({ points: 1, isValid: true });
  });
});

describe("getCellsValidation", () => {
  test("flattens region rows into an address-keyed answer key", () => {
    const validation = validationOf([
      { id: 1, A: { assess: { method: "value", expected: "10" } } },
      { id: 2, A: { assess: { method: "value", expected: "20" } } },
    ]);
    const key = getCellsValidation({ cells: {}, validation });
    expect(Object.keys(key).sort()).toEqual(["A1", "A2"]);
    expect(key.A1.assess.expected).toBe("10");
  });

  test("a row without assess contributes no answer key entry", () => {
    const validation = validationOf([{ id: 1, A: { text: "Header" } }]);
    expect(getCellsValidation({ cells: {}, validation })).toEqual({});
  });

  test('order "actual" re-sorts the key to match what the learner typed', () => {
    // The answer key is authored Apple then Banana; the learner entered Banana first. Their B
    // answers must be graded against the row their A value identifies, not by position.
    const validation = validationOf(
      [
        { A: { text: "Apple" }, B: { assess: { method: "value", expected: "red" } } },
        { A: { text: "Banana" }, B: { assess: { method: "value", expected: "yellow" } } },
      ],
      { primaryColumn: "A", order: "actual" },
    );
    const cells = { A1: { text: "Banana" }, A2: { text: "Apple" } };
    const key = getCellsValidation({ cells, validation });
    expect(key.B1.assess.expected).toBe("yellow");
    expect(key.B2.assess.expected).toBe("red");
  });

  test("reads validation.ranges as well as .regions, for older compiled data", () => {
    const validation: any = { points: 0, cells: {}, ranges: { "*": { rows: [{ id: 1, A: { assess: { method: "value", expected: "1" } } }] } } };
    expect(Object.keys(getCellsValidation({ cells: {}, validation }))).toEqual(["A1"]);
  });
});

describe("scoreCells", () => {
  const validation = validationOf([
    { id: 1, A: { assess: { method: "value", expected: "10", points: 2 } } },
    { id: 2, A: { assess: { method: "value", expected: "20", points: 3 } } },
  ]);

  test("scores each assessed cell and leaves the response otherwise intact", () => {
    const cells = {
      A1: { text: "10", val: "10", type: "number" },
      A2: { text: "99", val: "99", type: "number" },
    };
    const scored = scoreCells({ cells, validation });
    expect(scored.A1.score).toEqual({ points: 2, isValid: true });
    expect(scored.A2.score).toEqual({ points: 0, isValid: false });
    expect(scored.A1.text).toBe("10");
  });

  test("partial credit is the sum of per-cell points, which is what the scorer reports", () => {
    const cells = {
      A1: { text: "10", val: "10", type: "number" },
      A2: { text: "20", val: "20", type: "number" },
    };
    const scored = scoreCells({ cells, validation });
    const total = Object.keys(scored).reduce((n, k) => n + (scored[k]?.score?.points || 0), 0);
    expect(total).toBe(5);
  });

  test("an assessed cell missing from the response is dropped, not scored zero", () => {
    // The Learnosity scorer sums over the returned keys, so a `{points: 0}` here and an absent
    // key are the same score — but the shape is L0166's and is relied on downstream.
    const scored = scoreCells({ cells: { A1: { val: "10", type: "number" } }, validation });
    expect(scored.A2).toBeUndefined();
  });

  test("an empty response scores nothing and does not throw", () => {
    expect(() => scoreCells({ cells: {}, validation })).not.toThrow();
  });
});

// ── Several sheets ─────────────────────────────────────────────────────────
//
// The response is one FLAT map with qualified keys, because the Learnosity lifecycle stores it
// that way and cannot be changed from here. What must not happen is two sheets' `A1` sharing a
// slot — the collision would be silent and would mark one sheet's answer against the other's key.

const oneSheetValidation = (expected: string, points: number) => ({
  points,
  regions: { "*": { primaryColumn: null, order: "expected", rows: [
    { id: 1, A: { assess: { method: "value", expected, points } } },
  ] } },
  cells: {},
});

const twoSheetValidation = {
  ...oneSheetValidation("10", 2),           // flat mirror of sheet 1
  points: 5,                                // the SUM, which is what the scorer reads as the max
  sheets: {
    s1: oneSheetValidation("10", 2),
    s2: oneSheetValidation("20", 3),
  },
};

describe("scoreCells across sheets", () => {
  test("each sheet's A1 is scored against its OWN answer key", () => {
    const cells = {
      "s1!A1": { val: "10", type: "number" },
      "s2!A1": { val: "20", type: "number" },
    };
    const scored = scoreCells({ cells, validation: twoSheetValidation });
    expect(scored["s1!A1"].score).toEqual({ points: 2, isValid: true });
    expect(scored["s2!A1"].score).toEqual({ points: 3, isValid: true });
  });

  test("the same value is right on one sheet and wrong on the other", () => {
    // The sharpest form of the collision: identical input, different verdicts.
    const cells = {
      "s1!A1": { val: "10", type: "number" },
      "s2!A1": { val: "10", type: "number" },
    };
    const scored = scoreCells({ cells, validation: twoSheetValidation });
    expect(scored["s1!A1"].score.isValid).toBe(true);
    expect(scored["s2!A1"].score.isValid).toBe(false);
  });

  test("a fully correct response sums to validation.points, as the scorer requires", () => {
    const cells = {
      "s1!A1": { val: "10", type: "number" },
      "s2!A1": { val: "20", type: "number" },
    };
    const scored = scoreCells({ cells, validation: twoSheetValidation });
    const total = Object.keys(scored).reduce((n, k) => n + (scored[k]?.score?.points || 0), 0);
    expect(total).toBe(twoSheetValidation.points);
  });

  test("an unqualified key still means the first sheet", () => {
    // What every response stored before sheets existed looks like.
    const scored = scoreCells({ cells: { A1: { val: "10", type: "number" } }, validation: twoSheetValidation });
    expect(scored["s1!A1"].score).toEqual({ points: 2, isValid: true });
  });

  test("a single-sheet validation keeps bare keys and the flat path", () => {
    const scored = scoreCells({
      cells: { A1: { val: "10", type: "number" } },
      validation: oneSheetValidation("10", 2),
    });
    expect(scored.A1.score).toEqual({ points: 2, isValid: true });
    expect(scored["s1!A1"]).toBeUndefined();
  });

  test("getCellsValidation keys the answer key the same way the response is keyed", () => {
    const key = getCellsValidation({ cells: {}, validation: twoSheetValidation });
    expect(Object.keys(key).sort()).toEqual(["s1!A1", "s2!A1"]);
    expect(key["s2!A1"].assess.expected).toBe("20");
  });
});

describe("key qualification", () => {
  test("splitKey handles both forms", () => {
    expect(splitKey("s2!A1")).toEqual(["s2", "A1"]);
    expect(splitKey("A1")).toEqual([undefined, "A1"]);
  });

  test("splitBySheet routes unqualified keys to the first sheet", () => {
    const out = splitBySheet({ A1: 1, "s2!B2": 2 }, ["s1", "s2"]);
    expect(out.s1).toEqual({ A1: 1 });
    expect(out.s2).toEqual({ B2: 2 });
  });

  test("qualify is the inverse for one sheet", () => {
    expect(qualify("s2", { A1: 1 })).toEqual({ "s2!A1": 1 });
  });
});

describe("responseOverlay", () => {
  // Regression guard for a real defect: the Learnosity lifecycle restores a saved response by
  // folding it into `interaction.cells` and nowhere else. That is right for one sheet, which
  // renders from exactly that map — but a multi-sheet grid renders from `interaction.sheets[i]`,
  // so without this overlay a learner reopened a two-sheet item and every answer was gone from
  // the screen while still sitting in the response. Verified in a browser before and after.
  const folded = {
    A1: { text: "Q1" },                                   // authored mirror of sheet 1
    B1: { text: "", assess: { expected: "100" } },        // authored mirror of sheet 1
    "revenue!B1": { text: "100", val: "100" },            // the learner's answers
    "costs!B1": { text: "50", val: "50" },
  };

  test("takes the answers belonging to the sheet asked for", () => {
    expect(responseOverlay(folded, "revenue")).toEqual({ B1: { text: "100", val: "100" } });
    expect(responseOverlay(folded, "costs")).toEqual({ B1: { text: "50", val: "50" } });
  });

  test("ignores unqualified keys — they are the authored mirror, not an answer", () => {
    // Treating them as answers would overwrite the first sheet with its own pre-response state.
    expect(responseOverlay(folded, "revenue").A1).toBeUndefined();
  });

  test("a sheet with no saved answers gets nothing", () => {
    expect(responseOverlay(folded, "other")).toEqual({});
    expect(responseOverlay(undefined as any, "revenue")).toEqual({});
  });
});
