// SPDX-License-Identifier: MIT
/**
 * Recalculation: evaluate each affected cell exactly once, in dependency order.
 *
 * WHAT THIS REPLACES. The renderer worked out what to recompute by asking, for every cell, for its
 * transitive dependencies and then evaluating EACH of them — so a cell that five others read was
 * evaluated five times, each with a whole-map spread to carry the result forward
 * (components/form/TableEditor.tsx). Measured on a chained sheet that is 5x the necessary number
 * of parses, and at 3-17 ms a parse it is most of what makes a large sheet slow to paint.
 *
 * The order is what removes the multiplication. Evaluating in topological order means a cell's
 * inputs are already final when it is reached, so it never has to be revisited — no fixpoint loop,
 * no re-evaluation per dependent, one pass.
 *
 * CYCLES FALL OUT OF ORDERING. Kahn's algorithm cannot order a cell caught in a cycle, so whatever
 * it leaves behind IS the cyclic set. Those cells are still evaluated — `evalCell` is what turns a
 * cycle into `#CYCLE!` with its path — but nothing has to go looking for them first.
 */
import { evalCell } from "./formula.js";
import { dependentsOf, topoOrder } from "./graph.js";
import type { DependencyGraph } from "./graph.js";
import type { SheetCache } from "./cache.js";

export interface RecalcResult {
  /** A new cell map. The input is not mutated. */
  cells: any;
  /** The cells whose `val` actually moved — what the `update` action should carry. */
  changed: string[];
}

/**
 * Recompute `changed` and everything that transitively reads them.
 *
 * Pass every non-empty name as `changed` to seed a sheet from cold; pass one name to handle an
 * edit. The two are the same operation, which is the point — there is no separate init path to
 * drift out of step with the edit path.
 */
export const recalculate = (
  { cells, graph, changed, cache }:
  { cells: any; graph: DependencyGraph; changed: Iterable<string>; cache?: SheetCache },
): RecalcResult => {
  const seeds = [...changed];
  // Everything downstream of the edit. The reverse index is what makes this cheap: without it the
  // only way to find these was to walk every cell's dependencies looking for a mention.
  const affected = dependentsOf(graph, seeds);
  const { order, cyclic } = topoOrder(graph, [...seeds, ...affected]);

  // One copy of the map for the whole pass, then mutate. The shape this replaces spread the
  // entire map once per dependency AND once per dependent.
  const next = { ...cells };
  const seeded = new Set(seeds);
  const moved = new Set<string>();
  const env = { cells: next };

  const evaluate = (name: string) => {
    const before = next[name];
    if (before === undefined) return;
    const result = evalCell({ env, name, graph, cache });
    next[name] = { ...before, ...result };
    if (next[name].val !== before.val) moved.add(name);
  };

  // A wavefront, not a blanket sweep. A seed always evaluates and always propagates: the caller
  // is asserting that cell changed, and by the time we are called it has usually already written
  // the new value, so there is nothing left here to compare against. Below the seeds, a cell is
  // evaluated only if one of the cells it READS actually moved — so a formula whose inputs landed
  // on the same values stops the wave there instead of running down the rest of the column.
  // Topological order is what makes that check sufficient: every precedent has been decided by
  // the time the cell is reached.
  //
  // A no-op edit still costs nothing when a cache is supplied, which is the case that matters:
  // the dependents' inputs are unchanged, so their keys are unchanged, so they are all hits.
  const wave = new Set(seeded);
  for (const name of order) {
    if (!wave.has(name) && !(graph.precedents.get(name) || []).some((p) => wave.has(p))) continue;
    evaluate(name);
    if (moved.has(name)) wave.add(name);
  }
  // Cyclic cells are always evaluated: `evalCell` is what reports `#CYCLE!`, and there is no
  // ordering that would let the wavefront decide it. Evaluated last, so any non-cyclic input they
  // read is already final.
  for (const name of cyclic) evaluate(name);

  return { cells: next, changed: [...moved] };
};
