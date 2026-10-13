// SPDX-License-Identifier: MIT
/**
 * Sheet builders for the performance gate (`../perf.test.ts`) and the bench (`sheet.bench.ts`).
 *
 * TEST AND BENCH ONLY. Deliberately not re-exported from `index.ts`: the library build bundles
 * whatever is reachable from `src/index.ts` and `src/scoring/index.ts`, and nothing here belongs
 * in a published bundle.
 *
 * The corpus these sheets stand in for has a median of 4 cells and a p90 of 14, but the reported
 * pain is at 100-500, so both ends are covered. The SHAPES matter as much as the sizes, because
 * they stress different parts of the engine:
 *
 *   - `literal`  no formulas at all — the floor. Any cost here is not evaluation.
 *   - `chain`    each cell reads the one before it — worst case for topological DEPTH, and the
 *                shape where evaluating a cell per dependency edge blows up worst.
 *   - `fanIn`    many cells reading one range — worst case for dependency COUNT.
 *   - `mixed`    60/40 literal/formula, the realistic shape.
 */

/** A leaf cell as it looks after evaluation: it carries a `val`, which is what refs read. */
const leaf = (v: string) => ({ text: v, formula: v, val: v, type: "number" });
/** An unevaluated formula cell. */
const formula = (t: string) => ({ text: t, formula: t });

const COLS = "ABCDEFGHIJ".split("");

/** `rows` x 10 columns of plain numbers. No formula ever runs. */
export const literal = (rows: number): any => {
  const cells: any = {};
  for (let r = 1; r <= rows; r++) {
    for (let c = 0; c < COLS.length; c++) cells[COLS[c] + r] = leaf(String(r * 10 + c));
  }
  return cells;
};

/**
 * Column A is literal; every other column reads the cell to its left. Depth 9 per row, so a
 * single edit to A(r) must recompute exactly 9 cells — and no others. That "and no others" is the
 * assertion the reverse index exists to make true.
 */
export const chain = (rows: number): any => {
  const cells: any = {};
  for (let r = 1; r <= rows; r++) {
    cells["A" + r] = leaf(String(r));
    for (let c = 1; c < COLS.length; c++) {
      cells[COLS[c] + r] = formula("=" + COLS[c - 1] + r + "+1");
    }
  }
  return cells;
};

/**
 * Column A is literal; column B of every row sums the whole of column A. Every B cell therefore
 * depends on every A cell, which is the shape that makes "re-evaluate each dependency once per
 * dependent" quadratic.
 */
export const fanIn = (rows: number): any => {
  const cells: any = {};
  for (let r = 1; r <= rows; r++) cells["A" + r] = leaf(String(r));
  for (let r = 1; r <= rows; r++) cells["B" + r] = formula(`=SUM(A1:A${rows})`);
  return cells;
};

/** 60% literal, 40% formula reading its own row's column A. The realistic case. */
export const mixed = (rows: number): any => {
  const cells: any = {};
  for (let r = 1; r <= rows; r++) {
    for (let c = 0; c < COLS.length; c++) {
      const name = COLS[c] + r;
      cells[name] = c < 6 ? leaf(String(r * 10 + c)) : formula("=A" + r + "*" + (c + 1));
    }
  }
  return cells;
};

/** How many cells in the sheet actually carry a formula — the count evaluation should match. */
export const formulaCount = (cells: any): number =>
  Object.keys(cells).filter((n) => String(cells[n].text ?? "").startsWith("=")).length;

/**
 * A `validation` marking one cell per row assessed, in the compiled shape `scoreCells` reads:
 * one region, rows indexed from 1, each carrying `assess` under a column letter.
 *
 * `expected` is a literal by default. Pass one starting with `=` to exercise
 * `evaluateExpectedFormula`, which is the path that clones the entire cell map into a fresh env
 * once per assessed cell.
 */
export const assessColumn = (
  rows: number,
  { column = "A", expected = "0", method = "value", points = 1 } = {},
): any => ({
  points: rows * points,
  regions: {
    "*": {
      primaryColumn: null,
      order: "expected",
      rows: Array.from({ length: rows }, (_, i) => ({
        id: i + 1,
        [column]: { assess: { method, expected, points } },
      })),
    },
  },
  cells: {},
});
