// SPDX-License-Identifier: MIT
/**
 * The performance gate.
 *
 * This file counts TransLaTeX `translate()` invocations. That is the whole instrument, and the
 * choice is deliberate: one formula evaluation costs 3-17 ms depending on how many cells are
 * handed to the parser as `env`, while a literal cell costs ~0 ms and every other engine
 * operation (dependency extraction, formatting, colour, borders) is under 0.05 ms. So the cost of
 * this system IS the number of times a formula is parsed, and a count is the only measure of it
 * that does not flake on a loaded CI box.
 *
 * There are exactly four call sites in the codebase — `sheet/formula.ts` (evalCell,
 * formatCellValue) and `scoring/score.ts` (normalizeValue, evaluateExpectedFormula) — and they
 * are reached through one factory, so wrapping the factory catches all four with no
 * instrumentation hook in production code.
 *
 * `buildTranslator` itself is NOT counted, because it is free: it returns a closure and does no
 * parsing. Counting it would suggest caching the translator, which measures as worth nothing.
 *
 * WHEN A COUNT CHANGES, that is the finding. Update the number in the same commit that earns it
 * and say why in the message; never relax an assertion to make a suite green.
 */
import { test, expect, describe, beforeEach, vi } from "vitest";

const counters = { translate: 0 };

vi.mock("@graffiticode/translatex", async () => {
  const actual: any = await vi.importActual("@graffiticode/translatex");
  return {
    ...actual,
    TransLaTeX: {
      ...actual.TransLaTeX,
      buildTranslator: (...args: any[]) => {
        const translate = actual.TransLaTeX.buildTranslator(...args);
        return (src: string, resume: any) => {
          counters.translate++;
          return translate(src, resume);
        };
      },
    },
  };
});

// Imported after the mock so the engine picks up the wrapped factory.
const { evalCell, formatCellValue, getCellDependencies, createSheetCache, recalculate, buildGraph } =
  await import("./sheet/index.js");
const { scoreCells } = await import("./scoring/index.js");
const fx = await import("./sheet/fixtures.js");

/** Count `translate` calls made by `fn`. */
const count = (fn: () => void): number => {
  counters.translate = 0;
  fn();
  return counters.translate;
};

/** Evaluate every cell once, the way a cold mount does. */
const evaluateAll = (cells: any, cache?: any) => {
  for (const name of Object.keys(cells)) evalCell({ env: { cells }, name, cache });
};

beforeEach(() => {
  counters.translate = 0;
});

describe("the instrument itself", () => {
  test("counts one translate per formula evaluation and none for a literal", () => {
    const cells = { A1: { text: "1", formula: "1", val: "1" }, B1: { text: "=A1+1", formula: "=A1+1" } };
    expect(count(() => evalCell({ env: { cells }, name: "A1" }))).toBe(0);
    expect(count(() => evalCell({ env: { cells }, name: "B1" }))).toBeGreaterThan(0);
  });
});

describe("cold evaluation", () => {
  // One pass over the engine already costs exactly one parse per formula cell — `detectCycles`
  // and dependency extraction are regex work and never reach the translator. So the engine's own
  // per-call count is not the problem; what a CALLER does with it is. These are the floor every
  // number below should be compared against.
  test("a 500-cell mixed sheet evaluates each formula cell", () => {
    const cells = fx.mixed(50);
    const formulas = fx.formulaCount(cells);
    expect(Object.keys(cells).length).toBe(500);
    expect(formulas).toBe(200);
    const calls = count(() => evaluateAll(cells));
    expect(calls).toBe(200);
  });

  test("a chain sheet costs one translate per formula cell, not one per edge", () => {
    // 30 rows x 9 formula columns, each reading the cell to its left. A per-edge evaluator pays
    // far more than 270 here, because every cell's value is read by the next one along.
    const cells = fx.chain(30);
    expect(fx.formulaCount(cells)).toBe(270);
    expect(count(() => evaluateAll(cells))).toBe(270);
  });

  test("a fan-in sheet does not multiply by dependency count", () => {
    // Every B cell reads all 50 A cells; one pass is still 50 parses.
    const cells = fx.fanIn(50);
    expect(fx.formulaCount(cells)).toBe(50);
    expect(count(() => evaluateAll(cells))).toBe(50);
  });
});

describe("what a mount actually costs today", () => {
  /**
   * The evaluation pattern of `buildCellPlugin.state.init`
   * (components/form/TableEditor.tsx:1715-1762), reproduced here because it is the real cost of
   * a cold mount and it is invisible from the engine's own API.
   *
   * For EVERY cell it asks for the transitive dependencies, then evaluates EACH of them — so a
   * cell that five other cells read is evaluated five times, and the whole pass is
   * O(cells x dependencies). The `evaluateAll` tests above show the engine costs one parse per
   * formula cell; this shows the caller paying many multiples of that.
   *
   * Stage 4 replaces this with a topological pass that evaluates each cell exactly once. When
   * that lands, these numbers drop to the `evaluateAll` numbers and this test moves with it.
   */
  const initLikeToday = (cells: any) => {
    const acc = cells;
    for (const name of Object.keys(cells)) {
      const deps = getCellDependencies({ env: { cells: acc }, names: [name] });
      for (const dep of deps) evalCell({ env: { cells: acc }, name: dep });
    }
    for (const name of Object.keys(cells)) {
      if (String(cells[name].text ?? "")) evalCell({ env: { cells: acc }, name });
    }
    return acc;
  };

  test("a chain sheet is evaluated five times over", () => {
    const cells = fx.chain(20);
    expect(fx.formulaCount(cells)).toBe(180);
    // 180 formula cells, 900 parses — 5x, because each cell's dependencies are themselves
    // formulas and are re-evaluated once per cell that transitively reads them. At ~5 ms a parse
    // that is ~4.5 s of pure evaluation for a 200-cell sheet. This is the number Stage 4 moves.
    expect(count(() => initLikeToday(cells))).toBe(900);
  });

  test("fan-in does NOT multiply, because its dependencies are literals", () => {
    // Worth pinning as the contrast: the multiplication above is not about how MANY dependencies
    // a cell has, it is about whether those dependencies are themselves formulas. Literals cost
    // no parse however often they are re-evaluated, which is why a wide `=SUM(A1:A50)` sheet is
    // cheap and a deep chain is not.
    const cells = fx.fanIn(20);
    expect(fx.formulaCount(cells)).toBe(20);
    expect(count(() => initLikeToday(cells))).toBe(20);
  });
});

describe("recalculation evaluates each cell exactly once", () => {
  const seed = (cells: any, cache?: any) => {
    const graph = buildGraph(cells);
    return recalculate({ cells, graph, changed: Object.keys(cells), cache });
  };

  test("a chain sheet costs one parse per formula cell, not five", () => {
    // The counterpart to "what a mount actually costs today" above, on the same fixture. That
    // pattern costs 900; ordering the pass costs 180, which is the floor.
    const cells = fx.chain(20);
    expect(fx.formulaCount(cells)).toBe(180);
    expect(count(() => seed(cells))).toBe(180);
  });

  test("a 500-cell mixed sheet costs one parse per formula cell", () => {
    const cells = fx.mixed(50);
    expect(count(() => seed(cells))).toBe(200);
  });

  test("an edit re-parses only what transitively reads it", () => {
    // 10 rows of 9 chained formulas. Editing one leaf must touch that row's nine dependents and
    // none of the other ninety cells.
    const cells: any = fx.chain(10);
    const seeded = seed(cells).cells;
    const graph = buildGraph(seeded);
    seeded.A5 = { text: "999", formula: "999", val: "999", type: "number" };
    expect(count(() => recalculate({ cells: seeded, graph, changed: ["A5"] }))).toBe(9);
  });

  test("an edit that changes nothing costs nothing, once a memo is in play", () => {
    // A declared edit always propagates — by the time recalculation is called the caller has
    // usually already written the new value, so there is nothing left to compare against. What
    // makes a no-op edit free is the memo: every dependent's inputs are unchanged, so every key
    // is unchanged, so every lookup is a hit.
    const cells: any = fx.chain(10);
    const cache = createSheetCache();
    const seeded = seed(cells, cache).cells;
    const graph = buildGraph(seeded);
    expect(count(() => recalculate({ cells: seeded, graph, changed: ["A5"], cache }))).toBe(0);
  });

  test("seeding twice with a shared memo is free the second time", () => {
    const cells = fx.mixed(50);
    const cache = createSheetCache();
    expect(count(() => seed(cells, cache))).toBe(200);
    expect(count(() => seed(cells, cache))).toBe(0);
  });
});

describe("the memo", () => {
  test("a second pass over an unchanged sheet costs nothing", () => {
    // The assertion that pins memoisation itself. Nothing pinned this before, so there was no
    // test anywhere that would have noticed a value being recomputed.
    const cells = fx.mixed(50);
    const cache = createSheetCache();
    expect(count(() => evaluateAll(cells, cache))).toBe(200);
    expect(count(() => evaluateAll(cells, cache))).toBe(0);
  });

  test("only the cells whose inputs changed are re-parsed", () => {
    // Written back into the map as it goes, the way recalculation does. That write-back is what
    // makes invalidation propagate at all: the key holds the VALUES of a cell's dependencies, so
    // a dependent is only re-parsed once its input's new value is actually stored.
    const evaluateAndStore = (cells: any, cache: any) => {
      for (const name of Object.keys(cells)) {
        cells[name] = { ...cells[name], ...evalCell({ env: { cells }, name, cache }) };
      }
    };
    const cells: any = fx.chain(10);
    const cache = createSheetCache();
    count(() => evaluateAndStore(cells, cache));
    // One leaf changes. Its row's nine dependents follow it down the chain; the other nine rows
    // are untouched and must not be re-parsed.
    cells.A5 = { text: "999", formula: "999", val: "999", type: "number" };
    expect(count(() => evaluateAndStore(cells, cache))).toBe(9);
  });

  test("no cache means no memo — behaviour is exactly as before", () => {
    const cells = fx.mixed(50);
    expect(count(() => evaluateAll(cells))).toBe(200);
    expect(count(() => evaluateAll(cells))).toBe(200);
  });
});

describe("dependency extraction never reaches the parser", () => {
  // A regression pin. Dependency extraction used to go through TransLaTeX, which had cycle
  // detection walking a mangled formula character by character. It is a regex now, and must stay
  // one — this is the assertion that says so.
  test("getCellDependencies over 500 names is zero translate calls", () => {
    const cells = fx.mixed(50);
    const names = Object.keys(cells);
    expect(count(() => getCellDependencies({ env: { cells }, names }))).toBe(0);
  });
});

describe("formatting", () => {
  /** `rows` x 10 formatted numeric cells, the shape a real authored sheet has. */
  const formatted = (rows: number) => {
    const cells: any = {};
    const fmts = ["$#,##0", "0.0%"];
    let i = 0;
    for (const name of Object.keys(fx.literal(rows))) {
      cells[name] = { val: String(1000 + i), type: "number", format: fmts[i % 2] };
      i++;
    }
    return cells;
  };

  test("formatting an unformatted cell does not reach the parser", () => {
    const cells = fx.literal(10);
    const names = Object.keys(cells);
    expect(count(() => {
      for (const name of names) formatCellValue({ env: { cells }, name });
    })).toBe(0);
  });

  test("a FORMATTED cell does reach the parser — once per distinct value", () => {
    // The cost missed by the fixtures above, and found on a real 336-cell item: 266 of its cells
    // carried a format, and formatting them was 111 ms of parsing. Uncached it is one parse per
    // cell; the memo keys on (val, type, format), and these 200 cells all differ in value, so
    // this is the honest worst case rather than a flattering one.
    const cells = formatted(20);
    const names = Object.keys(cells);
    expect(names.length).toBe(200);
    expect(count(() => {
      for (const name of names) formatCellValue({ env: { cells }, name });
    })).toBe(200);
  });

  test("repeated values collapse to one parse each", () => {
    // The realistic case: a column of the same formatted figure, or a second pass over a sheet
    // that has not changed. Two distinct (val, format) pairs here, so two parses however many
    // cells there are.
    const cells: any = {};
    for (let i = 1; i <= 100; i++) {
      cells["A" + i] = { val: "1000", type: "number", format: "$#,##0" };
      cells["B" + i] = { val: "0.5", type: "number", format: "0.0%" };
    }
    const names = Object.keys(cells);
    const cache = createSheetCache();
    expect(count(() => {
      for (const name of names) formatCellValue({ env: { cells }, name, cache });
    })).toBe(2);
  });

  test("a second formatting pass over an unchanged sheet is free", () => {
    const cells = formatted(20);
    const names = Object.keys(cells);
    const cache = createSheetCache();
    count(() => { for (const name of names) formatCellValue({ env: { cells }, name, cache }); });
    expect(count(() => {
      for (const name of names) formatCellValue({ env: { cells }, name, cache });
    })).toBe(0);
  });
});

describe("scoring", () => {
  const respond = (rows: number) => {
    const cells: any = {};
    for (let r = 1; r <= rows; r++) cells["A" + r] = { text: "0", val: "0", type: "number", assess: {} };
    return cells;
  };

  test("a literal expected is compared without parsing", () => {
    const cells = respond(200);
    const validation = fx.assessColumn(200);
    expect(count(() => scoreCells({ cells, validation }))).toBe(0);
  });

  test("a formula expected shared down a column is parsed once, not once per cell", () => {
    // Was 100 — one parse per assessed cell, even though the `expected` is byte-identical in all
    // 100 rows and every response carries the same value. Memoising `normalizeValue` on its
    // stringified input collapses it: the actual and the expected here normalize to the same
    // text, so the whole column costs a single parse.
    const cells = respond(100);
    const validation = fx.assessColumn(100, { expected: "=1+1", method: "formula" });
    const calls = count(() => scoreCells({ cells, validation, interactionCells: cells }));
    expect(calls).toBe(1);
  });

  test("a formula expected resolved against the grid is parsed once per distinct formula", () => {
    // The `evaluateExpectedFormula` path: `expected "=A1*2"` grades against the authored grid, and
    // used to clone every interaction cell into a fresh env AND re-parse, per assessed cell.
    const cells = respond(100);
    const validation = fx.assessColumn(100, { expected: "=A1*2", method: "value" });
    const calls = count(() => scoreCells({ cells, validation, interactionCells: cells }));
    expect(calls).toBe(1);
  });
});

describe("wall clock, as an alarm only", () => {
  // Deliberately loose. This exists to catch a reintroduced quadratic, not to measure anything.
  // The call-count assertions above are the real gate.
  test("a cold 500-cell evaluation finishes inside 5s", () => {
    const cells = fx.mixed(50);
    const t0 = Date.now();
    evaluateAll(cells);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
