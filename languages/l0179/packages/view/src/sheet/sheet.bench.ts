// SPDX-License-Identifier: MIT
/**
 * Wall-clock bench for the sheet engine. DIAGNOSTIC, never a required check — CI wall clock is
 * noise, and the gate is the call counts in `../perf.test.ts`.
 *
 * `vitest run` does not collect `*.bench.ts`, so this costs `npm test` nothing. Run it with
 * `npm run -w packages/view bench`, and record the table in the commit message of any change that
 * claims a speedup.
 *
 * Vitest 5 moved `bench` off the top-level exports: it is a test-context fixture, so each group
 * below is one `test` that destructures `bench` and either compares its registrations
 * (`bench.compare`, which needs two or more) or runs a lone one (`bench().run()`). The explicit
 * timeout is because a benchmark runs many iterations and would otherwise hit the default 5s.
 *
 * What the numbers mean: one formula parse costs 3-17 ms depending on how many cells are handed
 * to the parser as `env`, so these times are very nearly a count of parses multiplied by env
 * size. That is why the shapes are here — `chain` and `mixed` differ by an order of magnitude at
 * the same cell count.
 */
import { describe, test } from "vitest";
import {
  evalCell, formatCellValue, getCellDependencies, getResponses, getChangedCells,
  buildGraph, recalculate,
} from "./index.js";
import { chain, fanIn, literal, mixed } from "./fixtures.js";

const BENCH_TIMEOUT = 300_000;

const evaluateAll = (cells: any) => {
  for (const name of Object.keys(cells)) evalCell({ env: { cells }, name });
};

/**
 * The evaluation pattern of `buildCellPlugin.state.init`
 * (../components/form/TableEditor.tsx:1715-1762): for every cell, ask for its transitive
 * dependencies and evaluate each one. Kept here beside the one-pass bench so the gap between
 * them is visible as a time, not only as a count.
 */
const initLikeToday = (cells: any) => {
  for (const name of Object.keys(cells)) {
    for (const dep of getCellDependencies({ env: { cells }, names: [name] })) {
      evalCell({ env: { cells }, name: dep });
    }
  }
  for (const name of Object.keys(cells)) {
    if (String(cells[name].text ?? "")) evalCell({ env: { cells }, name });
  }
};

describe("cold evaluation, one pass", () => {
  const l = literal(50);
  const m10 = mixed(1);
  const m100 = mixed(10);
  const m500 = mixed(50);
  const c = chain(30);
  const f = fanIn(50);

  test("shapes", { timeout: BENCH_TIMEOUT }, async ({ bench }) => {
    await bench.compare(
      bench("literal 500 cells (no formulas — the floor)", () => evaluateAll(l)),
      bench("mixed 10 cells (corpus p90)", () => evaluateAll(m10)),
      bench("mixed 100 cells", () => evaluateAll(m100)),
      bench("mixed 500 cells", () => evaluateAll(m500)),
      bench("chain 300 cells (deep dependencies)", () => evaluateAll(c)),
      bench("fan-in 100 cells (wide dependencies)", () => evaluateAll(f)),
    );
  });
});

describe("cold evaluation, the way a mount does it today", () => {
  const c = chain(20);
  const m = mixed(10);

  test("init pattern", { timeout: BENCH_TIMEOUT }, async ({ bench }) => {
    await bench.compare(
      bench("chain 200 cells, init pattern", () => initLikeToday(c)),
      bench("mixed 100 cells, init pattern", () => initLikeToday(m)),
    );
  });
});

describe("cold evaluation, the way a mount does it NOW", () => {
  // The same fixtures as the block above, through `recalculate`. The gap between the two blocks
  // is what ordering the pass bought.
  const seed = (cells: any) => {
    const graph = buildGraph(cells);
    recalculate({ cells, graph, changed: Object.keys(cells) });
  };
  const c = chain(20);
  const m = mixed(10);
  const m500 = mixed(50);

  test("ordered", { timeout: BENCH_TIMEOUT }, async ({ bench }) => {
    await bench.compare(
      bench("chain 200 cells, ordered", () => seed(c)),
      bench("mixed 100 cells, ordered", () => seed(m)),
      bench("mixed 500 cells, ordered", () => seed(m500)),
    );
  });
});

describe("the payloads a mount sends", () => {
  const m500 = mixed(50);
  const names = Object.keys(m500);
  const assessed = Object.keys(m500).reduce((acc: any, n: string, i: number) => (
    acc[n] = i % 5 === 0 ? { ...m500[n], assess: {} } : m500[n], acc
  ), {});

  // The one-time initial `update` covers EVERY cell, so this runs at 500 cells on every mount.
  test("payloads", { timeout: BENCH_TIMEOUT }, async ({ bench }) => {
    await bench.compare(
      bench("getChangedCells over all 500 names", () => { getChangedCells(m500, names); }),
      bench("getResponses over 500 cells, 100 assessed", () => { getResponses(assessed); }),
    );
  });
});

describe("dependency extraction", () => {
  const m500 = mixed(50);
  const names = Object.keys(m500);

  test("getCellDependencies", { timeout: BENCH_TIMEOUT }, async ({ bench }) => {
    await bench("getCellDependencies over 500 names", () => {
      getCellDependencies({ env: { cells: m500 }, names });
    }).run();
  });
});

describe("formatting", () => {
  const l = literal(50);
  const names = Object.keys(l);

  test("formatCellValue", { timeout: BENCH_TIMEOUT }, async ({ bench }) => {
    await bench("formatCellValue over 500 cells", () => {
      for (const name of names) formatCellValue({ env: { cells: l }, name });
    }).run();
  });
});
