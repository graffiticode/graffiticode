// SPDX-License-Identifier: MIT
/**
 * Recalculation.
 *
 * The important test here is the last one: an EQUIVALENCE against the evaluation pattern this
 * replaces. The renderer's version evaluated a cell once per dependent and reached a correct
 * answer by brute force; this one evaluates each cell once and relies on topological order to
 * make that sufficient. That is a real behavioural claim, so it is checked against the old
 * pattern's output rather than assumed.
 */
import { test, expect, describe } from "vitest";
import { recalculate, buildGraph, setFormula, evalCell, createSheetCache } from "./index.js";

const leaf = (v: string) => ({ text: v, formula: v, val: v, type: "number" });
const f = (t: string) => ({ text: t, formula: t });

/** A1 <- B1 <- C1, plus an untouched neighbour. */
const chain = () => ({ A1: leaf("1"), B1: f("=A1+1"), C1: f("=B1+1"), Z9: leaf("99") });

const seed = (cells: any, cache?: any) => {
  const graph = buildGraph(cells);
  return recalculate({ cells, graph, changed: Object.keys(cells), cache });
};

describe("seeding a sheet", () => {
  test("evaluates every cell into dependency order", () => {
    const { cells } = seed(chain());
    expect(cells.B1.val).toBe("2");
    expect(cells.C1.val).toBe("3");
  });

  test("does not mutate the input map", () => {
    const before = chain();
    const snapshot = JSON.stringify(before);
    seed(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test("reports the cells whose value moved", () => {
    const { changed } = seed(chain());
    // A1 and Z9 already carry their own value as `val`; the two formulas move from nothing.
    expect(changed.sort()).toEqual(["B1", "C1"]);
  });
});

describe("recalculating an edit", () => {
  test("propagates down the chain", () => {
    const cells: any = seed(chain()).cells;
    const graph = buildGraph(cells);
    cells.A1 = leaf("10");
    const out = recalculate({ cells, graph, changed: ["A1"] });
    expect(out.cells.B1.val).toBe("11");
    expect(out.cells.C1.val).toBe("12");
    expect(out.changed.sort()).toEqual(["B1", "C1"]);
  });

  test("leaves unrelated cells alone", () => {
    const cells: any = seed(chain()).cells;
    const graph = buildGraph(cells);
    cells.A1 = leaf("10");
    const out = recalculate({ cells, graph, changed: ["A1"] });
    expect(out.cells.Z9).toBe(cells.Z9);
    expect(out.changed).not.toContain("Z9");
  });

  test("an edit that changes nothing reports nothing", () => {
    const cells: any = seed(chain()).cells;
    const graph = buildGraph(cells);
    expect(recalculate({ cells, graph, changed: ["A1"] }).changed).toEqual([]);
  });

  test("follows a formula that was just re-pointed", () => {
    const cells: any = seed(chain()).cells;
    const graph = buildGraph(cells);
    cells.C1 = f("=Z9+1");
    setFormula(graph, "C1", "=Z9+1", cells);
    const out = recalculate({ cells, graph, changed: ["C1"] });
    expect(out.cells.C1.val).toBe("100");
  });

  test("a diamond's join is evaluated once, after both arms", () => {
    const cells: any = seed({
      A1: leaf("1"), B1: f("=A1+1"), C1: f("=A1+2"), D1: f("=B1+C1"),
    }).cells;
    const graph = buildGraph(cells);
    cells.A1 = leaf("10");
    const out = recalculate({ cells, graph, changed: ["A1"] });
    expect(out.cells.B1.val).toBe("11");
    expect(out.cells.C1.val).toBe("12");
    expect(out.cells.D1.val).toBe("23");
  });
});

describe("cycles", () => {
  test("a cyclic cell is reported as #CYCLE!, not skipped", () => {
    const { cells } = seed({ A1: f("=B1"), B1: f("=A1") });
    expect(cells.A1.val).toBe("#CYCLE!");
    expect(cells.B1.val).toBe("#CYCLE!");
  });

  test("cells outside the cycle still evaluate", () => {
    const { cells } = seed({ A1: f("=B1"), B1: f("=A1"), X1: leaf("5"), Y1: f("=X1+1") });
    expect(cells.Y1.val).toBe("6");
    expect(cells.A1.val).toBe("#CYCLE!");
  });

  test("the cycle path message is unchanged", () => {
    const { cells } = seed({ A1: f("=B1"), B1: f("=C1"), C1: f("=A1") });
    expect(cells.A1.error).toBe("Circular dependency: A1 → B1 → C1 → A1");
  });
});

describe("the memo composes with it", () => {
  test("recalculating twice with no change costs nothing the second time", () => {
    const cache = createSheetCache();
    const cells: any = seed(chain(), cache).cells;
    const graph = buildGraph(cells);
    const before = cache.values.size;
    recalculate({ cells, graph, changed: ["A1"], cache });
    expect(cache.values.size).toBe(before);
  });
});

describe("equivalent to the pattern it replaces", () => {
  /**
   * `buildCellPlugin.state.init`'s evaluation, reproduced: for every cell, ask for its transitive
   * dependencies and evaluate each, then evaluate every non-empty cell. Correct by brute force,
   * and the thing `recalculate` has to agree with.
   */
  const initLikeToday = (input: any) => {
    let cells = { ...input };
    for (const name of Object.keys(cells)) {
      const graph = buildGraph(cells);
      const deps = graph.precedents.get(name) || [];
      for (const dep of deps) {
        if (cells[dep]) cells[dep] = { ...cells[dep], ...evalCell({ env: { cells }, name: dep }) };
      }
    }
    for (const name of Object.keys(cells)) {
      if (String(cells[name].text ?? "")) {
        cells = { ...cells, [name]: { ...cells[name], ...evalCell({ env: { cells }, name }) } };
      }
    }
    return cells;
  };

  const sheets: [string, any][] = [
    ["a chain", chain()],
    ["a diamond", { A1: leaf("1"), B1: f("=A1+1"), C1: f("=A1+2"), D1: f("=B1+C1") }],
    ["a fan-in", { A1: leaf("1"), A2: leaf("2"), A3: leaf("3"), S1: f("=SUM(A1:A3)") }],
    ["a function call", { A1: leaf("10"), B1: f("=ROUND(A1/3,2)") }],
    ["all literals", { A1: leaf("1"), B1: leaf("2") }],
    ["an unknown name", { A1: f("=NOPE(1)") }],
    ["a deep chain", (() => {
      const cells: any = { A1: leaf("1") };
      for (let i = 2; i <= 40; i++) cells["A" + i] = f(`=A${i - 1}+1`);
      return cells;
    })()],
  ];

  test.each(sheets)("%s evaluates to the same values", (_label, input) => {
    const mine = seed(input).cells;
    const theirs = initLikeToday(input);
    for (const name of Object.keys(input)) {
      expect([name, mine[name].val]).toEqual([name, theirs[name].val]);
      expect([name, mine[name].type]).toEqual([name, theirs[name].type]);
    }
  });
});
