// SPDX-License-Identifier: MIT
/**
 * The formula engine had NO TESTS until it was lifted out of TableEditor.tsx — evaluation, the
 * dependency graph, cycle detection and every number and date format were pinned only by the
 * source. These are the first.
 *
 * Written by characterizing the real implementation rather than from the documentation — which is
 * how the dependency-extraction defect at the bottom of this file was found. Writing the first
 * tests for code by asserting what you assume it does would have reproduced the bug as a test.
 */
import { test, expect, describe } from "vitest";
import {
  evalCell,
  formatCellValue,
  getSingleCellDependencies,
  detectCycles,
  getCellDependencies,
  getCellRange,
  getColumnRange,
  getRowRange,
  columnToNumber,
  numberToColumn,
  getCellColor,
  mergeBorders,
  getResponses,
  getChangedCells,
} from "./index.js";

/** A leaf cell, as it looks after evaluation: it carries a `val`, which is what refs read. */
const leaf = (v: string) => ({ text: v, formula: v, val: v, type: "number" });
/** An unevaluated formula cell. */
const f = (t: string) => ({ text: t, formula: t });
const sheet = (cells: any) => ({ cells });

const base = () => sheet({ A1: leaf("10"), A2: leaf("20"), A3: leaf("30") });
const evalIn = (cells: any, text: string) =>
  evalCell({ env: sheet({ ...cells.cells, X: f(text) }), name: "X" });

describe("evalCell", () => {
  test.each([
    ["=SUM(A1:A3)", "60"],
    ["=AVERAGE(A1:A3)", "20"],
    ["=ROUND(A1/3,2)", "3.33"],
    ["=A1+A2", "30"],
    ["=A2-A1", "10"],
    ["=A1*A2", "200"],
    ["=SUM(A1:A3)+A1", "70"],
  ])("%s evaluates to %s", (formula, expected) => {
    expect(evalIn(base(), formula).val).toBe(expected);
  });

  test("a plain value is not a formula and is passed through", () => {
    const r = evalCell({ env: sheet({ A1: { text: "hello", formula: "hello" } }), name: "A1" });
    expect(r.val).toBe("hello");
  });

  test("an unknown function is #NAME! and says which name", () => {
    const r = evalIn(base(), "=NOPE(1)");
    expect(r.val).toBe("#NAME!");
    expect(r.type).toBe("error");
    expect(r.error).toContain("NOPE");
  });

  describe("POWER", () => {
    // Integer exponents have to be EXACT: `Math.pow(1.05, 4)` is 1.2155062500000004, and a scored
    // cell compares the learner's typed value against this string.
    const rates = () => sheet({ A1: leaf("2"), A2: leaf("3"), B8: leaf("0.05"), B10: leaf("0.1"), B2: leaf("1"), B3: leaf("5") });

    test.each([
      ["=POWER(A1,A2)", "8"],
      ["=POWER(2,10)", "1024"],
      ["=POWER(1+B8,B3-B2)", "1.21550625"],
      ["=POWER(A1,-A2)", "0.125"],
      ["=POWER(-A1,A2)", "-8"],
      ["=POWER(SUM(A1,A2),2)", "25"],
      ["=power(a1,a2)", "8"],
    ])("%s evaluates to %s", (formula, expected) => {
      expect(evalIn(rates(), formula).val).toBe(expected);
    });

    test("POWER is a known name, so it is never #NAME!", () => {
      expect(evalIn(rates(), "=POWER(A1,A2)").type).toBe("number");
    });

    test("a missing argument is a #NUM! error rather than a thrown one", () => {
      expect(evalIn(rates(), "=POWER(A1)").val).toBe("#NUM!");
      expect(evalIn(rates(), "=POWER(A1)").type).toBe("error");
    });
  });

  describe("MAX, MIN, ABS", () => {
    const vals = () => sheet({
      A1: leaf("10"), A2: leaf("-20"), A3: leaf("5"), F43: leaf("-2.57"),
      W1: { text: "hello", formula: "hello", val: "hello", type: "text" },
    });

    test.each([
      ["=MAX(A1:A3)", "10"],
      ["=MIN(A1:A3)", "-20"],
      ["=MAX(A1,A2,A3)", "10"],
      ["=MIN(A1,7)", "7"],
      ["=MAX(0,F43)", "0"],
      ["=MAX(1.5,1.25)", "1.5"],
      ["=MAX(W1,A2)", "-20"],        // text is skipped
      ["=MIN(A4:A6)", "0"],          // no numbers at all
      ["=max($a$1:$a$3)", "10"],
      ["=ABS(A2)", "20"],
      ["=ABS(-3.5)", "3.5"],
      ["=ABS(A1-A3*4)", "10"],
      ["=A1/MAX(A3,1)", "2"],
      ["=MAX(A1,A3)^2", "100"],
      ["=MIN(POWER(2,3),ABS(A2))", "8"],
    ])("%s evaluates to %s", (formula, expected) => {
      expect(evalIn(vals(), formula).val).toBe(expected);
    });

    test("ABS of text is a #VALUE! error", () => {
      const r = evalIn(vals(), "=ABS(W1)");
      expect(r.val).toBe("#VALUE!");
      expect(r.type).toBe("error");
    });
  });

  describe("a sign before a function call", () => {
    // The same parser defect as `*` and `/`: `=-SUM(A1,A2)` was the text "0A1…A2" and
    // `=A1+-SUM(A1,A2)` dropped the call. Bracketed in prepareFormula.
    const vals = () => sheet({ A1: leaf("10"), A2: leaf("-20"), A3: leaf("5") });

    test.each([
      ["=-SUM(A1,A3)", "-15"],
      ["=-POWER(2,3)", "-8"],
      ["=-ABS(A2)", "-20"],
      ["=+ABS(A2)", "20"],
      ["=A1+-SUM(A1,A3)", "-5"],
      ["=1-SUM(A1,A3)", "-14"],
      ["=-MAX(A1:A3)+1", "-9"],
      ["=A1-ABS(A2)*2", "-30"],
    ])("%s evaluates to %s", (formula, expected) => {
      expect(evalIn(vals(), formula).val).toBe(expected);
    });
  });

  describe("^", () => {
    // parselatex reads `^` as a LaTeX superscript and the rule set had no pattern for it, so the
    // exponent was dropped: `=2^3` was 2. It is spelled POWER(a,b) before parsing, by Excel's rules.
    const pow = () => sheet({ A1: leaf("2"), A2: leaf("3"), A3: leaf("4"), B7: leaf("0.005"), B8: leaf("360") });

    test.each([
      ["=2^3", "8"],
      ["=2^10", "1024"],
      ["=A1^A2", "8"],
      ["=A1 ^ A2", "8"],
      ["=$A$1^$A$2", "8"],
      ["=(1+B7)^(12*A1)", "1.1271597762053917414"],
      ["=12*A1^2", "48"],
      ["=A1^2*3", "12"],
      ["=A1^A2+1", "9"],
      ["=2^3^2", "64"],        // left-associative, as in Excel
      ["=-2^2", "4"],          // unary minus belongs to the base, as in Excel
      ["=0-2^2", "-4"],        // binary minus does not
      ["=A1*-A2^2", "18"],
      ["=2^-1", "0.5"],
      ["=50%^2", "0.25"],
      ["=SUM(A1:A3)^2", "81"],
      ["=POWER(A1,2)^2", "16"],
      ["=A1/(1+B7)^2", "1.980149006212717507"],
    ])("%s evaluates to %s", (formula, expected) => {
      expect(evalIn(pow(), formula).val).toBe(expected);
    });

    test("^ in a comparison and inside a string", () => {
      expect(evalIn(pow(), '=IF(A1^2>3,"big","small")').val).toBe("big");
      expect(evalIn(pow(), '="2^3"').val).toBe("2^3");
    });

    test("a payment formula written with ^ matches the one written with POWER", () => {
      const env = sheet({ ...pow().cells, B6: leaf("320000") });
      expect(evalIn(env, "=ROUND(B6*B7*(1+B7)^B8/((1+B7)^B8-1),2)").val)
        .toBe(evalIn(env, "=ROUND(B6*B7*POWER(1+B7,B8)/(POWER(1+B7,B8)-1),2)").val);
    });
  });

  // A function call on the RIGHT of `*` or `/` parses as (lhs x NAME) applied to a separate
  // argument list -- the call is lost and the formula evaluates to a concatenation. Bracketing it
  // in prepareFormula is the fix; these pin it for every function, not just POWER, because the
  // defect was never specific to POWER.
  describe("a function call as the right operand of * or /", () => {
    const rates = () => sheet({ A1: leaf("2"), A2: leaf("3"), A3: leaf("4"), B10: leaf("0.1"), B2: leaf("1"), A28: leaf("3"), H28: leaf("100") });

    test.each([
      ["=A1/SUM(A1,A2)", "0.4"],
      ["=A1*SUM(A1,A2)", "10"],
      ["=A1*ROUND(A2,0)", "6"],
      ["=A1/AVERAGE(A1:A3)", "0.66666666666666666667"],
      ["=H28/POWER(1+B10,A28-B2)", "82.644628099173553719"],
      ["=SUM(A1,A2)/A1", "2.5"],
      ["=AVERAGE(A1:A3)/A1", "1.5"],
      ["=A1/SUM(A1,A2)*A3", "1.6"],
      ["=A1/POWER(SUM(A1,A3)/A2,2)", "0.5"],
    ])("%s evaluates to %s", (formula, expected) => {
      expect(evalIn(rates(), formula).val).toBe(expected);
    });

    test("the operators it does not affect keep parsing as they did", () => {
      expect(evalIn(rates(), "=A1+SUM(A1,A2)").val).toBe("7");
      expect(evalIn(rates(), "=A1-SUM(A1,A2)").val).toBe("-3");
      expect(evalIn(rates(), "=SUM(A1,A2)*A1").val).toBe("10");
    });
  });

  describe("comparison operators in IF", () => {
    // L0179 had NO test for these, which is how it shipped for so long with
    // every comparison IF taking the true branch regardless: the rule set had
    // no pattern for the comparison node, so the second operand was DISCARDED
    // and the condition was the non-empty string "A1". Half the cases looked
    // right, because the true branch was often the right answer.
    const cmp = () => sheet({ A1: leaf("10"), A2: leaf("20") });

    test.each([
      ["=IF(A1>99,100,200)", "200"],
      ["=IF(A1>1,100,200)", "100"],
      ["=IF(A1<1,100,200)", "200"],
      ["=IF(A1<99,100,200)", "100"],
      ["=IF(A1>=10,100,200)", "100"],
      ["=IF(A1>=11,100,200)", "200"],
      ["=IF(A1<=10,100,200)", "100"],
      ["=IF(A1<=9,100,200)", "200"],
      ["=IF(A1=10,100,200)", "100"],
      ["=IF(A1=11,100,200)", "200"],
      ["=IF(A1!=10,100,200)", "200"],
      ["=IF(A1!=11,100,200)", "100"],
      // `<>` is Excel's spelling, and it lexed as `<` then `>`: always the true branch.
      ["=IF(A1<>10,100,200)", "200"],
      ["=IF(A1<>11,100,200)", "100"],
      ["=IF(A1<>A2,100,200)", "100"],
      ["=IF(A1 <> 10,100,200)", "200"],
      ["=IF(A1>A2,100,200)", "200"],
      ["=IF(A2>A1,100,200)", "100"],
    ])("%s evaluates to %s", (formula, expected) => {
      expect(evalIn(cmp(), formula).val).toBe(expected);
    });

    test("a bare truthy value still works, which was the only form that ever did", () => {
      expect(evalIn(cmp(), "=IF(A1,100,200)").val).toBe("100");
    });
  });

  describe("#NAME! detection does not read inside string literals", () => {
    test("the words inside a string are not called undefined names", () => {
      // It used to scan the raw text, so `=IF(A1,"Yes","No")` reported
      // `Undefined names: Yes, No`.
      const r = evalIn(base(), '=IF(A1,"Yes","No")');
      expect(r.val).toBe("Yes");
      expect(r.type).toBe("text");
    });

    test("a genuinely unknown function is still caught", () => {
      const r = evalIn(base(), "=NOPE(1)");
      expect(r.val).toBe("#NAME!");
      expect(r.error).toContain("NOPE");
    });
  });

  test("a translation error is reported, not silently blank", () => {
    // The callback used to log the error and fall through to `val`, which is ""
    // on the error path — so an unparseable formula produced an EMPTY cell with
    // no indication anything was wrong.
    const r = evalIn(base(), "=A1<=A2");
    expect(r.val).not.toBe("");
    expect(r.type).toBe("error");
  });

  describe("absolute references", () => {
    // A sheet is authored cell by cell and never filled, so `$B$4` always means B4. Before this,
    // the name scan read `$B$6` as the undefined name `B`, and `$B6` evaluated to the text "$B6".
    const refs = () => sheet({ A1: leaf("10"), B4: leaf("30"), B6: leaf("320000") });

    test.each([
      ["=$B$6", "320000"],
      ["=B$6", "320000"],
      ["=$B6", "320000"],
      ["=12*$B$4", "360"],
      ["=SUM($A$1,B$4)", "40"],
      ["=IF(A1<=$B$4,$B$6,0)", "320000"],
      ["=$b$6", "320000"],
    ])("%s evaluates to %s", (formula, expected) => {
      expect(evalIn(refs(), formula).val).toBe(expected);
    });

    test("a $ inside a string literal is text", () => {
      expect(evalIn(refs(), '="$B$6"').val).toBe("$B$6");
    });
  });

  describe("string literals", () => {
    // The parser rejects `"`, so each literal is bound to a synthetic reference first.
    const strs = () => sheet({ A1: leaf("10"), A2: leaf("20"), W1: { text: "hello", formula: "hello", val: "hello", type: "text" } });

    test.each([
      ['=IF(A1>A2,5,"")', "", "text"],
      ['=IF(A1<A2,5,"")', "5", "number"],
      ['=IF(A1>A2,"",A2-A1)', "10", "number"],
      ['=IF(A1<A2,"Yes","No")', "Yes", "text"],
      ['=IF(A1>A2,"Yes","No")', "No", "text"],
      ['=IF(W1="hello",1,0)', "1", "number"],
      ['=IF(W1="bye",1,0)', "0", "number"],
      ['=IF(W1<>"hello",1,0)', "0", "number"],
      ['=IF(W1<>"bye",1,0)', "1", "number"],
      ['="a<>b"', "a<>b", "text"],
      ['=""', "", "text"],
      ['="abc"', "abc", "text"],
      ['="say ""hi"""', 'say "hi"', "text"],
      ['=IF(A1,"B1","C1")', "B1", "text"],
      ['=A1+"5"', "15", "number"],
    ])("%s evaluates to %j", (formula, val, type) => {
      const r = evalIn(strs(), formula);
      expect(r.val).toBe(val);
      expect(r.type).toBe(type);
    });

    test.each(['=A1+"x"', '="x"*2', '=A1-""'])("%s is #VALUE!, not a silently dropped operand", (formula) => {
      // The reducers skip a value that isn't a number, so `=A1+"x"` would otherwise be 10.
      const r = evalIn(strs(), formula);
      expect(r.val).toBe("#VALUE!");
      expect(r.type).toBe("error");
    });
  });

  test("a circular reference is #CYCLE! and reports the path", () => {
    const env = sheet({ A1: f("=B1"), B1: f("=A1") });
    const r = evalCell({ env, name: "A1" });
    expect(r.val).toBe("#CYCLE!");
    expect(r.type).toBe("error");
    expect(r.error).toContain("A1 → B1 → A1");
  });
});

describe("detectCycles", () => {
  test("finds a two-cell cycle and returns the path", () => {
    const env = sheet({ A1: f("=B1"), B1: f("=A1") });
    const r = detectCycles({ env, startCell: "A1" });
    expect(r.hasCycle).toBe(true);
    expect(r.cyclePath).toEqual(["A1", "B1", "A1"]);
  });

  test("a plain dependency chain is not a cycle", () => {
    const env = sheet({ A1: leaf("1"), B1: f("=A1"), C1: f("=B1") });
    expect(detectCycles({ env, startCell: "C1" }).hasCycle).toBe(false);
  });

  test("getCellDependencies unions the dependencies of several cells", () => {
    const env = sheet({ ...base().cells, B1: f("=A1+A2"), C1: f("=A2+A3") });
    const deps = getCellDependencies({ env, names: ["B1", "C1"] });
    expect([...deps].sort()).toEqual(["A1", "A2", "A3"]);
  });
});

describe("formatCellValue", () => {
  test("applies a number format", () => {
    const env = sheet({ A1: { text: "1234.5", val: "1234.5", type: "number", format: "#,##0.00" } });
    expect(formatCellValue({ env, name: "A1" })).toBe("1,234.50");
  });

  test("leaves unformatted text alone", () => {
    const env = sheet({ A1: { text: "plain", val: "plain", type: "text" } });
    expect(formatCellValue({ env, name: "A1" })).toBe("plain");
  });

  // A percent format used to render 0.75 as "1" and 0.10 as "0" — rounded to a whole number,
  // never scaled, no sign. The defect was in `@graffiticode/translatex`'s parseFormatString (fixed
  // in 0.24.1), but it surfaced HERE, in a deployed sheet whose six input rows all showed "0". So
  // it is pinned from the consumer's side too: this is where a future regression would bite.
  test.each([
    ["0.75", "0.0%", "75.0%"],
    ["0.10", "0.0%", "10.0%"],
    ["0.025", "0.0%", "2.5%"],
    ["1", "0.0%", "100.0%"],
    ["0.07", "0.00%", "7.00%"],
  ])("formats %s as %s -> %s", (val, format, expected) => {
    const env = sheet({ A1: { text: val, val, type: "number", format } });
    expect(formatCellValue({ env, name: "A1" })).toBe(expected);
  });

  test("a currency format is unaffected by the percent handling", () => {
    const env = sheet({ A1: { text: "100000", val: "100000", type: "number", format: "$#,##0" } });
    expect(formatCellValue({ env, name: "A1" })).toBe("$100,000");
  });

  test("renders a date serial through its pattern, on the 1904 epoch", () => {
    // 1904 rather than 1900 — chosen to sidestep Excel's 1900 leap-year bug. See ../scoring.
    const env = sheet({ A1: { text: "", val: "44016", type: "date", format: "MM/DD/YYYY" } });
    expect(formatCellValue({ env, name: "A1" })).toBe("07/04/2024");
  });
});

describe("addresses and ranges", () => {
  test("column names convert both ways, past Z", () => {
    expect(columnToNumber("A")).toBe(1);
    expect(columnToNumber("Z")).toBe(26);
    expect(columnToNumber("AA")).toBe(27);
    expect(numberToColumn(27)).toBe("AA");
  });

  test("ranges are inclusive and order-insensitive", () => {
    expect(getColumnRange("A", "C")).toEqual(["A", "B", "C"]);
    expect(getColumnRange("C", "A")).toEqual(["A", "B", "C"]);
    expect(getRowRange("2", "4")).toEqual(["2", "3", "4"]);
  });

  test("a cell range walks row-major", () => {
    expect(getCellRange("A1", "B2")).toEqual(["A1", "B1", "A2", "B2"]);
  });

  test("a malformed name yields no range rather than throwing", () => {
    expect(getCellRange("nope", "B2")).toEqual([]);
  });
});

describe("presentation policy", () => {
  const cell = (o: any) => ({ row: 2, col: 2, name: "B2", ...o });

  test("assess feedback: green when valid, red when not", () => {
    expect(getCellColor(cell({ score: { isValid: true } }))).toBe("#efe");
    expect(getCellColor(cell({ score: { isValid: false } }))).toBe("#fee");
  });

  test("the cell being edited shows no verdict", () => {
    // Telling a learner they are wrong while they are still typing the answer.
    expect(getCellColor(cell({ score: { isValid: false }, lastFocusedCell: "B2" }))).toBeNull();
  });

  test("headers are never coloured", () => {
    expect(getCellColor(cell({ row: 1, score: { isValid: false } }))).toBeNull();
    expect(getCellColor(cell({ col: 1, score: { isValid: false } }))).toBeNull();
  });

  test("falls back to the authored background", () => {
    expect(getCellColor(cell({ "background-color": "#eee" }))).toBe("#eee");
  });

  test("side-list borders UNION but css borders OVERRIDE", () => {
    expect(mergeBorders("top", "left")).toBe("top,left");
    expect(mergeBorders("top,left", "bottom,right")).toBe("all");
    expect(mergeBorders("1px solid black", "2px solid red")).toBe("2px solid red");
  });
});

describe("outgoing payloads", () => {
  test("getResponses keeps only assessed cells, with the scorer's three fields", () => {
    const cells = {
      A1: { text: "10", val: "10", formula: "10" },
      B1: { text: "20", val: "20", formula: "20", assess: { expected: "20" } },
    };
    expect(getResponses(cells)).toEqual({ B1: { text: "20", val: "20", formula: "20" } });
  });

  test("getChangedCells reports text plus the formatted value, and skips unknown names", () => {
    const cells = { A1: { text: "1234.5", val: "1234.5", type: "number", format: "#,##0.00" } };
    expect(getChangedCells(cells, ["A1", "ZZ99"]))
      .toEqual({ A1: { text: "1234.5", formattedValue: "1,234.50" } });
  });
});

// ── Dependency extraction ─────────────────────────────────────────────────
//
// This suite began by documenting a defect and now pins its fix. `cellNameRules` rendered a
// function call through the generic `"??": "%1%2"` concatenation, gluing the function's name onto
// the first cell name — `=SUM(A1:A3)` reported `["SUMA1","A2","A3"]` and `=ROUND(A1,2)` reported
// `["ROUNDA1"]`, so nothing woke those cells when A1 changed. Verified in a browser: a learner
// edited an input and the total below it kept a stale value, which is the value an assessed sheet
// would grade. References are now parsed directly; see getSingleCellDependencies.
describe("getSingleCellDependencies", () => {
  const depsOf = (text: string) =>
    getSingleCellDependencies({ env: sheet({ ...base().cells, X: f(text) }), name: "X" });

  test.each([
    ["=A1+A2", ["A1", "A2"]],
    ["=SUM(A1:A3)", ["A1", "A2", "A3"]],
    ["=ROUND(A1,2)", ["A1"]],
    ["=AVERAGE(A1:A3)", ["A1", "A2", "A3"]],
    ["=IF(A1,B1,C1)", ["A1", "B1", "C1"]],
    ["=SUM(A1:A3)+B1", ["A1", "A2", "A3", "B1"]],
    ["=ROUND(A1/3,2)", ["A1"]],
  ])("%s depends on %j", (formula, expected) => {
    expect(depsOf(formula)).toEqual(expected);
  });

  test("a lower-case formula resolves like an upper-case one", () => {
    expect(depsOf("=sum(a1:a3)")).toEqual(["A1", "A2", "A3"]);
  });

  test("a repeated reference is listed once", () => {
    expect(depsOf("=A1+A1+A2")).toEqual(["A1", "A2"]);
  });

  test("an absolute reference is a reference", () => {
    // CELL_REF found nothing in `$B$6`, so the cell was never recalculated when B6 changed.
    expect(depsOf("=$A$1+A$2+$A3")).toEqual(["A1", "A2", "A3"]);
    expect(depsOf("=SUM($A$1:$A$3)")).toEqual(["A1", "A2", "A3"]);
  });

  test("a cell name inside a string literal is text, not a reference", () => {
    expect(depsOf('=IF(A1,"B1","C1")')).toEqual(["A1"]);
  });

  test("a non-formula depends on nothing", () => {
    expect(depsOf("42")).toEqual([]);
    expect(getSingleCellDependencies({ env: sheet({}), name: "nope" })).toEqual([]);
  });

  test("always an array, so callers can iterate it safely", () => {
    // The old implementation returned the raw formula STRING when the translator threw, which
    // callers then walked character by character.
    for (const t of ["=SUM(", "=)))", "=", "=@@@"]) {
      expect(Array.isArray(depsOf(t))).toBe(true);
    }
  });

  test("a function call now takes part in cycle detection", () => {
    // Previously invisible: the self-reference hid behind the mangled name.
    const env = sheet({ A1: f("=ROUND(A1,2)") });
    expect(detectCycles({ env, startCell: "A1" }).hasCycle).toBe(true);
  });
});
