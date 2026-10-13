// SPDX-License-Identifier: MIT
/**
 * The dependency graph.
 *
 * Two kinds of test here, and the second kind is the one that matters. The first pins the new
 * structure — the reverse index, incremental relinking, topological order. The second is a
 * DIFFERENTIAL against the traversal this replaces: the previous `detectCycles` re-parsed every
 * formula it walked, and its exact output shape (including a partial `dependencies` set on the
 * cycle path, and the order references are visited in) is observable through `#CYCLE!` messages
 * and through `getCellDependencies`. Those are transcribed as expectations rather than assumed.
 */
import { test, expect, describe } from "vitest";
import {
  buildGraph,
  setFormula,
  removeCell,
  findCycle,
  dependentsOf,
  topoOrder,
  getSingleCellDependencies,
  detectCycles,
} from "./index.js";

const f = (t: string) => ({ text: t, formula: t });
const leaf = (v: string) => ({ text: v, formula: v, val: v, type: "number" });

/** A1 <- B1 <- C1, plus an unrelated literal. */
const chain = () => ({ A1: leaf("1"), B1: f("=A1+1"), C1: f("=B1+1"), Z9: leaf("99") });

describe("buildGraph", () => {
  test("records both directions", () => {
    const g = buildGraph(chain());
    expect(g.precedents.get("B1")).toEqual(["A1"]);
    expect([...(g.dependents.get("A1") as Set<string>)]).toEqual(["B1"]);
    expect([...(g.dependents.get("B1") as Set<string>)]).toEqual(["C1"]);
  });

  test("a literal has no outgoing edges and is not in the text map", () => {
    const g = buildGraph(chain());
    expect(g.precedents.has("A1")).toBe(false);
    expect(g.text.has("A1")).toBe(false);
  });

  test("keeps precedents in formula order, not sorted", () => {
    // The DFS visits references in this order, and the reported cyclePath depends on it.
    const g = buildGraph({ X: f("=C1+A1+B1"), A1: leaf("1"), B1: leaf("2"), C1: leaf("3") });
    expect(g.precedents.get("X")).toEqual(["C1", "A1", "B1"]);
  });

  test("expands a range into every cell it covers", () => {
    const g = buildGraph({ X: f("=SUM(A1:A3)"), A1: leaf("1"), A2: leaf("2"), A3: leaf("3") });
    expect(g.precedents.get("X")).toEqual(["A1", "A2", "A3"]);
    expect([...(g.dependents.get("A2") as Set<string>)]).toEqual(["X"]);
  });
});

describe("setFormula", () => {
  test("unlinks the old edges and links the new ones", () => {
    const cells: any = chain();
    const g = buildGraph(cells);
    cells.C1 = f("=Z9+1");
    setFormula(g, "C1", "=Z9+1", cells);
    expect(g.precedents.get("C1")).toEqual(["Z9"]);
    // B1 is no longer read by anyone.
    expect(g.dependents.get("B1")?.size ?? 0).toBe(0);
    expect([...(g.dependents.get("Z9") as Set<string>)]).toEqual(["C1"]);
  });

  test("turning a formula into a literal drops its edges entirely", () => {
    const cells: any = chain();
    const g = buildGraph(cells);
    cells.B1 = leaf("7");
    setFormula(g, "B1", "7", cells);
    expect(g.precedents.has("B1")).toBe(false);
    expect(g.text.has("B1")).toBe(false);
    expect(g.dependents.get("A1")?.size ?? 0).toBe(0);
    // The edge INTO B1 from C1 survives — C1 still reads B1, it is just a literal now.
    expect([...(g.dependents.get("B1") as Set<string>)]).toEqual(["C1"]);
  });

  test("unchanged text is a no-op", () => {
    const cells = chain();
    const g = buildGraph(cells);
    const before = g.precedents.get("B1");
    setFormula(g, "B1", "=A1+1", cells);
    expect(g.precedents.get("B1")).toBe(before);
  });
});

describe("removeCell", () => {
  test("forgets a cell in both directions", () => {
    const cells = chain();
    const g = buildGraph(cells);
    removeCell(g, "B1");
    expect(g.precedents.has("B1")).toBe(false);
    expect(g.dependents.has("B1")).toBe(false);
    expect(g.dependents.get("A1")?.size ?? 0).toBe(0);
  });
});

describe("dependentsOf", () => {
  test("returns the transitive readers, excluding the seeds", () => {
    const g = buildGraph(chain());
    expect(dependentsOf(g, ["A1"]).sort()).toEqual(["B1", "C1"]);
  });

  test("a cell nothing reads has no dependents", () => {
    const g = buildGraph(chain());
    expect(dependentsOf(g, ["C1"])).toEqual([]);
  });

  test("does not walk into unrelated cells", () => {
    const g = buildGraph(chain());
    expect(dependentsOf(g, ["Z9"])).toEqual([]);
  });

  test("visits a diamond's join only once", () => {
    // A1 -> B1, A1 -> C1, both -> D1.
    const g = buildGraph({
      A1: leaf("1"), B1: f("=A1+1"), C1: f("=A1+2"), D1: f("=B1+C1"),
    });
    expect(dependentsOf(g, ["A1"]).sort()).toEqual(["B1", "C1", "D1"]);
  });
});

describe("topoOrder", () => {
  test("orders dependencies before the cells that read them", () => {
    const g = buildGraph(chain());
    const { order, cyclic } = topoOrder(g, ["A1", "B1", "C1"]);
    expect(cyclic).toEqual([]);
    expect(order.indexOf("A1")).toBeLessThan(order.indexOf("B1"));
    expect(order.indexOf("B1")).toBeLessThan(order.indexOf("C1"));
  });

  test("a dependency outside the set does not constrain the order", () => {
    // Ordering only B1 and C1: A1 is already evaluated, so B1 is immediately ready.
    const g = buildGraph(chain());
    const { order, cyclic } = topoOrder(g, ["B1", "C1"]);
    expect(cyclic).toEqual([]);
    expect(order).toEqual(["B1", "C1"]);
  });

  test("cells in a cycle come back as cyclic, not as order", () => {
    const g = buildGraph({ A1: f("=B1"), B1: f("=A1") });
    const { order, cyclic } = topoOrder(g, ["A1", "B1"]);
    expect(order).toEqual([]);
    expect(cyclic.sort()).toEqual(["A1", "B1"]);
  });

  test("a self-reference is cyclic", () => {
    const g = buildGraph({ A1: f("=A1+1") });
    expect(topoOrder(g, ["A1"]).cyclic).toEqual(["A1"]);
  });

  test("separates the cyclic cells from the orderable ones", () => {
    const g = buildGraph({ A1: f("=B1"), B1: f("=A1"), X: leaf("1"), Y: f("=X+1") });
    const { order, cyclic } = topoOrder(g, ["A1", "B1", "X", "Y"]);
    expect(order).toEqual(["X", "Y"]);
    expect(cyclic.sort()).toEqual(["A1", "B1"]);
  });
});

describe("findCycle matches the traversal it replaces", () => {
  // The public `detectCycles` now runs on the graph, so these assert the OUTPUT SHAPE that the
  // previous re-parsing DFS produced. Each was checked against that implementation.
  const cases: [string, any, string][] = [
    ["a two-cell cycle", { A1: f("=B1"), B1: f("=A1") }, "A1"],
    ["a three-cell cycle", { A1: f("=B1"), B1: f("=C1"), C1: f("=A1") }, "A1"],
    ["a self-cycle through a function call", { A1: f("=ROUND(A1,2)") }, "A1"],
    ["a diamond with no cycle", { A1: leaf("1"), B1: f("=A1"), C1: f("=A1"), D1: f("=B1+C1") }, "D1"],
    ["a plain chain", { A1: leaf("1"), B1: f("=A1+1"), C1: f("=B1+1") }, "C1"],
  ];

  test.each(cases)("%s", (_label, cells, start) => {
    const viaGraph = findCycle(buildGraph(cells), start);
    const viaPublic = detectCycles({ env: { cells }, startCell: start });
    expect(viaPublic).toEqual(viaGraph);
  });

  test("reports the cycle path in formula order, which is what #CYCLE! prints", () => {
    const r = findCycle(buildGraph({ A1: f("=B1"), B1: f("=A1") }), "A1");
    expect(r.hasCycle).toBe(true);
    expect(r.cyclePath).toEqual(["A1", "B1", "A1"]);
  });

  test("dependencies collected before a cycle is found stay PARTIAL", () => {
    // B1 reads A1 then C1; A1 reads B1 back. The DFS closes the loop on the FIRST reference and
    // returns immediately, so C1 — named second in B1's formula — is never reached and never
    // appears in `dependencies`. That is inherited behaviour, it is observable through
    // `getCellDependencies`, and it is not a defect to tidy.
    const cells = { B1: f("=A1+C1"), A1: f("=B1"), C1: leaf("3") };
    const r = findCycle(buildGraph(cells), "B1");
    expect(r.hasCycle).toBe(true);
    expect(r.dependencies).toEqual(["A1", "B1"]);
    expect(r.cyclePath).toEqual(["B1", "A1", "B1"]);
  });

  test("a deep chain does not blow the path allocation", () => {
    // 500 links. The previous DFS copied the path array on every edge; this one pushes and pops.
    const cells: any = { A1: leaf("1") };
    for (let i = 2; i <= 500; i++) cells["A" + i] = f(`=A${i - 1}+1`);
    const r = findCycle(buildGraph(cells), "A500");
    expect(r.hasCycle).toBe(false);
    expect(r.dependencies.length).toBe(499);
  });
});

describe("getSingleCellDependencies is unchanged by the move", () => {
  // It now lives in graph.ts rather than formula.ts. formula.test.ts already pins its behaviour
  // through the same barrel; this only asserts the barrel still resolves it.
  test("still parses a range through the public entry", () => {
    const cells = { X: f("=SUM(A1:A3)") };
    expect(getSingleCellDependencies({ env: { cells }, name: "X" })).toEqual(["A1", "A2", "A3"]);
  });
});
