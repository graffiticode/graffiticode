// SPDX-License-Identifier: MIT
/**
 * `3/4` means three quarters unless the cell is formatted as a date — and a date written without a
 * year is this year's, never 2001's. A learner answering "½ + ¼ =" typed `3/4` and got a 2001 date.
 */
import { test, expect, describe } from "vitest";
import { evalCell, formatCellValue } from "./index.js";
import { createSheetCache } from "./cache.js";
import { classifyInput, normalizeDateInput, parseFraction, scoreCell } from "../scoring/index.js";

const year = new Date().getFullYear();
const serial = (text: string, dayFirst = false) => String(normalizeDateInput(text, { dayFirst }));

/** Evaluate one typed cell, then display it, the way the grid does. */
const typed = (text: string, format = "", cache = createSheetCache()) => {
  const cells: any = { B1: { text, formula: text, ...(format ? { format } : {}) } };
  cells.B1 = { ...cells.B1, ...evalCell({ env: { cells }, name: "B1", cache }) };
  return { ...cells.B1, shown: formatCellValue({ env: { cells }, name: "B1", cache }) };
};

describe("parseFraction", () => {
  test("reads a/b, a sign, spaces, and Excel's mixed form", () => {
    expect(parseFraction("3/4")).toBe(0.75);
    expect(parseFraction("-3/4")).toBe(-0.75);
    expect(parseFraction("3 / 4")).toBe(0.75);
    expect(parseFraction("1 1/2")).toBe(1.5);
    expect(parseFraction("0 3/4")).toBe(0.75);
  });
  test("is not fooled by dates, division by zero, or text", () => {
    expect(parseFraction("3/4/2026")).toBeNull();
    expect(parseFraction("3/0")).toBeNull();
    expect(parseFraction("three quarters")).toBeNull();
  });
});

describe("a typed 3/4 in the grid", () => {
  test("with no format is the fraction, shown as typed", () => {
    const cell = typed("3/4");
    expect(cell.type).toBe("fraction");
    expect(cell.val).toBe("0.75");
    expect(cell.shown).toBe("3/4");
  });
  test("keeps each spelling on display, though 3/4 and 6/8 are the same value", () => {
    const cache = createSheetCache();
    expect(typed("3/4", "", cache).shown).toBe("3/4");
    expect(typed("6/8", "", cache).shown).toBe("6/8");
  });
  test("in a date-formatted cell is a date in THIS year", () => {
    const cell = typed("3/4", "MM/DD/YYYY");
    expect(cell.type).toBe("date");
    expect(cell.shown).toBe(`03/04/${year}`);
  });
  test("in a day-first date cell is 3 April", () => {
    const cell = typed("3/4", "DD/MM/YYYY");
    expect(cell.val).toBe(serial(`4/3/${year}`));
    expect(cell.shown).toBe(`03/04/${year}`);
  });
  test("a full date is still a date without any format", () => {
    expect(typed("3/4/2026").type).toBe("date");
    expect(typed("0.75").type).toBe("number");
  });
});

describe("a date written without a year", () => {
  test("is this year's, never V8's default 2001", () => {
    expect(serial("3/4")).toBe(serial(`3/4/${year}`));
    expect(normalizeDateInput("Mar 4")).toBe(normalizeDateInput(`3/4/${year}`));
  });
  test("an impossible month-first reading falls back to day-first, as before", () => {
    expect(serial("25/12/2026")).toBe(serial("12/25/2026"));
  });
});

describe("scoring an expected 3/4", () => {
  const assess = { method: "value", expected: "3/4", points: 1 };
  const answer = (text: string, format = "") => {
    const { val, type } = typed(text, format);
    return scoreCell(assess, { val, type, format }).isValid;
  };
  test("accepts 3/4, 6/8 and 0.75, and rejects 1/2", () => {
    expect(answer("3/4")).toBe(true);
    expect(answer("6/8")).toBe(true);
    expect(answer("0.75")).toBe(true);
    expect(answer("1/2")).toBe(false);
  });
  test("in a date cell, 3/4 is the date 4 March both ways", () => {
    expect(answer("3/4", "MM/DD/YYYY")).toBe(true);
    expect(answer(`3/4/${year}`, "MM/DD/YYYY")).toBe(true);
  });
  test("an expected 0.75 accepts a typed fraction", () => {
    const { val, type } = typed("3/4");
    expect(scoreCell({ method: "value", expected: "0.75", points: 1 }, { val, type }).isValid).toBe(true);
  });
  test("classifyInput is the one reading both sides use", () => {
    expect(classifyInput("3/4")).toEqual({ type: "fraction", val: "0.75" });
    expect(classifyInput("3/4", { date: true })?.type).toBe("date");
    expect(classifyInput("hello")).toBeNull();
  });
});

describe("dates inside daylight saving", () => {
  test("display the day that was typed (they used to show a day early)", () => {
    expect(typed("4/3/2026", "MM/DD/YYYY").shown).toBe("04/03/2026");
    expect(typed("7/4/2026", "MM/DD/YYYY").shown).toBe("07/04/2026");
    expect(typed("12/25/2026", "MM/DD/YYYY").shown).toBe("12/25/2026");
  });
});
