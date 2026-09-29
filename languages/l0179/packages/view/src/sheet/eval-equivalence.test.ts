// SPDX-License-Identifier: MIT
/**
 * Differentials for the two optimisations in `evalCell` that could silently change an ANSWER
 * rather than merely a timing: narrowing the parser env, and memoising the result.
 *
 * Both are asserted the same way — run the same formula both ways and require the outputs to be
 * identical — because for these two the risk is not that they are slow, it is that they are
 * subtly wrong in a way no existing test would notice.
 */
import { test, expect, describe } from "vitest";
import { evalCell, formatCellValue, buildGraph } from "./index.js";
import { createSheetCache } from "./cache.js";
import { TransLaTeX, spreadsheetExpanders } from "@graffiticode/translatex";
import { evalRules } from "../scoring/translatex-extensions.js";
import { toUpperCase } from "../scoring/index.js";

const leaf = (v: string) => ({ text: v, formula: v, val: v, type: "number" });
const f = (t: string) => ({ text: t, formula: t });

/** Evaluate `text` the OLD way: the entire cell map handed to the parser as env. */
const evalWideEnv = (cells: any, text: string) => {
  let out: any;
  const options = { keepTextWhitespace: true, env: cells, ...evalRules };
  TransLaTeX.buildTranslator(options as any, spreadsheetExpanders)(
    toUpperCase(text), (_e: any, v: any) => { out = String(v); },
  );
  return out;
};

const base = () => ({
  A1: leaf("10"), A2: leaf("20"), A3: leaf("30"),
  B1: leaf("2"), C1: leaf("3"),
  Q7: leaf("1"),
  Z99: leaf("999"),        // never referenced — the key case for narrowing
  D1: leaf("1,234.56"),
  E1: leaf(""),            // empty val, which must not read as "absent"
});

describe("narrowing the env cannot change a value", () => {
  const formulas = [
    "=A1+A2", "=A2-A1", "=A1*B1", "=A1/B1",
    "=SUM(A1:A3)", "=AVERAGE(A1:A3)", "=SUM(A1:A3)+B1", "=SUM(A1:A3)+Q7",
    "=ROUND(A1/3,2)", "=ROUND(A1,2)",
    "=IF(A1,B1,C1)", "=IF(B1,A1,C1)",
    "=A1", "=B1+C1", "=1+1", "=1",
    "=A1+Q7",           // the reference that exists
    "=A1*2+A3",
    "=SUM(A1:A3)*B1",
    "=sum(a1:a3)",      // lower case must resolve the same way
  ];

  test.each(formulas)("%s", (text) => {
    const cells: any = { ...base(), X: f(text) };
    const narrow = evalCell({ env: { cells }, name: "X" }).val;
    expect(narrow).toBe(evalWideEnv(cells, text));
  });

  test("a reference to a cell that does not exist stays absent", () => {
    // THE case. Env membership changes the parse, not just the lookup: with Q7 present this is
    // 11, without it the parser reads `Q7` as something else entirely and it is 10. Narrowing
    // includes a referenced name exactly when the map has it, which reproduces both.
    const withQ7: any = { A1: leaf("10"), Q7: leaf("1"), X: f("=A1+Q7") };
    const withoutQ7: any = { A1: leaf("10"), X: f("=A1+Q7") };
    expect(evalCell({ env: { cells: withQ7 }, name: "X" }).val).toBe("11");
    expect(evalCell({ env: { cells: withoutQ7 }, name: "X" }).val).toBe("10");
    // And both agree with the whole-map parse.
    expect(evalCell({ env: { cells: withQ7 }, name: "X" }).val).toBe(evalWideEnv(withQ7, "=A1+Q7"));
    expect(evalCell({ env: { cells: withoutQ7 }, name: "X" }).val)
      .toBe(evalWideEnv(withoutQ7, "=A1+Q7"));
  });

  test("a hole inside a range behaves as it always did", () => {
    const sparse: any = { A1: leaf("1"), A3: leaf("3"), X: f("=SUM(A1:A3)") };
    expect(evalCell({ env: { cells: sparse }, name: "X" }).val)
      .toBe(evalWideEnv(sparse, "=SUM(A1:A3)"));
  });

  test("an unreferenced cell changing does not change the result", () => {
    // The half that buys the speed: names the formula never mentions cannot affect its parse.
    const a: any = { A1: leaf("10"), Z99: leaf("999"), X: f("=A1*2") };
    const b: any = { A1: leaf("10"), Z99: leaf("111"), X: f("=A1*2") };
    expect(evalCell({ env: { cells: a }, name: "X" }).val)
      .toBe(evalCell({ env: { cells: b }, name: "X" }).val);
  });

  test("using a prebuilt graph gives the same answer as parsing the deps inline", () => {
    const cells: any = { ...base(), X: f("=SUM(A1:A3)+B1") };
    const graph = buildGraph(cells);
    expect(evalCell({ env: { cells }, name: "X", graph }).val)
      .toBe(evalCell({ env: { cells }, name: "X" }).val);
  });
});

describe("the cache returns what evaluation would have returned", () => {
  const formulas = ["=A1+A2", "=SUM(A1:A3)", "=ROUND(A1/3,2)", "=IF(A1,B1,C1)", "=A1+Q7", "=1"];

  test.each(formulas)("%s", (text) => {
    const cells: any = { ...base(), X: f(text) };
    const cache = createSheetCache();
    const cold = evalCell({ env: { cells }, name: "X", cache });
    const warm = evalCell({ env: { cells }, name: "X", cache });
    expect(warm).toEqual(cold);
    expect(warm).toEqual(evalCell({ env: { cells }, name: "X" }));
  });

  test("a changed dependency value is a different key", () => {
    const cache = createSheetCache();
    const cells: any = { A1: leaf("10"), X: f("=A1*2") };
    expect(evalCell({ env: { cells }, name: "X", cache }).val).toBe("20");
    cells.A1 = leaf("50");
    expect(evalCell({ env: { cells }, name: "X", cache }).val).toBe("100");
  });

  test("a changed formula is a different key", () => {
    const cache = createSheetCache();
    const cells: any = { A1: leaf("10"), X: f("=A1*2") };
    expect(evalCell({ env: { cells }, name: "X", cache }).val).toBe("20");
    cells.X = f("=A1*3");
    expect(evalCell({ env: { cells }, name: "X", cache }).val).toBe("30");
  });

  test("a dependency that disappears is a different key", () => {
    // Distinguishing ABSENT from an empty value is exactly what the sentinel in `evalKey` is for.
    const cache = createSheetCache();
    const cells: any = { A1: leaf("10"), Q7: leaf("1"), X: f("=A1+Q7") };
    expect(evalCell({ env: { cells }, name: "X", cache }).val).toBe("11");
    delete cells.Q7;
    expect(evalCell({ env: { cells }, name: "X", cache }).val).toBe("10");
  });

  test("a dependency whose val is empty is not confused with an absent one", () => {
    const cache = createSheetCache();
    const present: any = { A1: leaf("10"), Q7: { text: "", formula: "", val: "" }, X: f("=A1+Q7") };
    const absent: any = { A1: leaf("10"), X: f("=A1+Q7") };
    const withEmpty = evalCell({ env: { cells: present }, name: "X", cache }).val;
    const withNone = evalCell({ env: { cells: absent }, name: "X", cache }).val;
    // Whatever each evaluates to, the cache must not serve one for the other.
    expect(withEmpty).toBe(evalWideEnv(present, "=A1+Q7"));
    expect(withNone).toBe(evalWideEnv(absent, "=A1+Q7"));
  });

  test("a cache shared across two sheets does not leak between them", () => {
    const cache = createSheetCache();
    const one: any = { A1: leaf("10"), X: f("=A1*2") };
    const two: any = { A1: leaf("99"), X: f("=A1*2") };
    expect(evalCell({ env: { cells: one }, name: "X", cache }).val).toBe("20");
    expect(evalCell({ env: { cells: two }, name: "X", cache }).val).toBe("198");
  });

  test("evictions do not change answers, only cost", () => {
    const cache = createSheetCache(2);
    const cells: any = { A1: leaf("1"), A2: leaf("2"), A3: leaf("3"),
      X: f("=A1+1"), Y: f("=A2+1"), Z: f("=A3+1") };
    const cold = ["X", "Y", "Z"].map((n) => evalCell({ env: { cells }, name: n }).val);
    const warm = ["X", "Y", "Z"].map((n) => evalCell({ env: { cells }, name: n, cache }).val);
    expect(warm).toEqual(cold);
    expect(cache.values.size).toBeLessThanOrEqual(2);
  });
});

describe("the format memo returns what formatting would have returned", () => {
  // formatCellValue is a pure function of the cell's val, type and format. Real sheets repeat
  // formats heavily — a 336-cell item measured 266 formatted cells and TWO distinct format
  // strings — so this is nearly all hits, and it must be exactly transparent.
  const cases: [string, any][] = [
    ["currency", { val: "1234.5", type: "number", format: "$#,##0" }],
    ["percent", { val: "0.256", type: "number", format: "0.0%" }],
    ["thousands", { val: "1234567", type: "number", format: "#,##0.00" }],
    ["no format", { val: "42", type: "number", format: "" }],
    ["text", { val: "hello", type: "text", format: "" }],
    ["date serial", { val: "40000", type: "date", format: "MM/DD/YYYY" }],
    ["date, other pattern", { val: "40000", type: "date", format: "DD MMM YYYY" }],
    ["empty value", { val: "", type: "text", format: "$#,##0" }],
    ["error value", { val: "#CYCLE!", type: "error", format: "$#,##0" }],
  ];

  test.each(cases)("%s", (_label, cell) => {
    const cells: any = { X: cell };
    const cache = createSheetCache();
    const cold = formatCellValue({ env: { cells }, name: "X" });
    const warm1 = formatCellValue({ env: { cells }, name: "X", cache });
    const warm2 = formatCellValue({ env: { cells }, name: "X", cache });
    expect(warm1).toEqual(cold);
    expect(warm2).toEqual(cold);
  });

  test("the same format with a different value is a different key", () => {
    const cache = createSheetCache();
    const cells: any = { X: { val: "1000", type: "number", format: "$#,##0" } };
    const a = formatCellValue({ env: { cells }, name: "X", cache });
    cells.X = { val: "2000", type: "number", format: "$#,##0" };
    const b = formatCellValue({ env: { cells }, name: "X", cache });
    expect(b).not.toEqual(a);
    expect(b).toEqual(formatCellValue({ env: { cells }, name: "X" }));
  });

  test("the same value with a different format is a different key", () => {
    const cache = createSheetCache();
    const cells: any = { X: { val: "0.5", type: "number", format: "0.0%" } };
    const pct = formatCellValue({ env: { cells }, name: "X", cache });
    cells.X = { val: "0.5", type: "number", format: "$#,##0.00" };
    const money = formatCellValue({ env: { cells }, name: "X", cache });
    expect(money).not.toEqual(pct);
  });

  test("a numeric val is not confused with the same digits as a string", () => {
    // formatCellValue branches on `typeof result === "number"`, so the key carries the JS type.
    const cache = createSheetCache();
    const asNum: any = { X: { val: 1234, type: "number", format: "$#,##0" } };
    const asStr: any = { X: { val: "1234", type: "number", format: "$#,##0" } };
    const n = formatCellValue({ env: { cells: asNum }, name: "X", cache });
    const t = formatCellValue({ env: { cells: asStr }, name: "X", cache });
    expect(n).toEqual(formatCellValue({ env: { cells: asNum }, name: "X" }));
    expect(t).toEqual(formatCellValue({ env: { cells: asStr }, name: "X" }));
  });
});

describe("errors are still produced with a narrowed env", () => {
  test("#NAME! for an unknown function", () => {
    const cells: any = { ...base(), X: f("=NOPE(1)") };
    expect(evalCell({ env: { cells }, name: "X" }).val).toBe("#NAME!");
  });

  test("#CYCLE! still sees the whole graph, not just the direct references", () => {
    // The narrowing applies to what the PARSER is handed. Cycle detection walks the full cell map
    // and must keep doing so, or a loop deeper than one hop would stop being reported.
    const cells: any = { A1: f("=B1"), B1: f("=C1"), C1: f("=A1") };
    const r = evalCell({ env: { cells }, name: "A1" });
    expect(r.val).toBe("#CYCLE!");
    expect(r.error).toBe("Circular dependency: A1 → B1 → C1 → A1");
  });

  test("a cycle is reported the same way with a prebuilt graph", () => {
    const cells: any = { A1: f("=B1"), B1: f("=C1"), C1: f("=A1") };
    const graph = buildGraph(cells);
    expect(evalCell({ env: { cells }, name: "A1", graph }).error)
      .toBe(evalCell({ env: { cells }, name: "A1" }).error);
  });
});
