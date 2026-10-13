// SPDX-License-Identifier: MIT
/**
 * The dependency graph, built once and kept.
 *
 * Until now there was no graph. `detectCycles` re-derived a cell's edges by re-parsing its formula
 * every time it visited it, `getCellDependencies` ran a whole fresh DFS per name, and the reverse
 * edge — who reads THIS cell — did not exist at all: the renderer reconstructed it by hand into a
 * `deps` array on each cell record, with a whole-map spread per dependency
 * (components/form/TableEditor.tsx). That is the shape that made a cold mount evaluate a chained
 * sheet five times over.
 *
 * Three things here are load-bearing, and each is pinned by a test:
 *
 *   - `precedents` keeps FORMULA ORDER. `detectCycles`'s reported `cyclePath` and its partial
 *     `dependencies` set both depend on the DFS visiting a cell's references in the order the
 *     formula names them. Sorting or de-duplicating differently rewrites the `#CYCLE!` message.
 *   - Traversal state is NEVER shared between start cells. Edges are shared — that is the whole
 *     point — but a `colors` map carried across starts would mark a cell BLACK from an earlier
 *     walk and suppress the `dependencies.add` that the next start expects, silently changing
 *     `getCellDependencies`'s output.
 *   - `findCycle` returns the same partial `dependencies` as before when it finds a cycle: the
 *     DFS returns early, so what it collected up to that point is what comes back. That is
 *     observable and is not a defect to tidy.
 *
 * `getSingleCellDependencies` moved here from formula.ts with it, because it IS the edge parser and
 * belongs with the structure it feeds. It stays the ONLY thing that derives an edge list — every
 * traversal below reads stored edges and never re-parses.
 */
import { toUpperCase, stripAbsoluteReferences } from "../scoring/index.js";
import { getCellRange } from "./address.js";

/**
 * A cell reference, optionally the start of a range. A function name can never match: it has no
 * trailing digits.
 */
const CELL_REF = /\b([A-Z]+[0-9]+)(?::([A-Z]+[0-9]+))?\b/g;

/**
 * The cells a formula reads, in the order it reads them, ranges expanded and duplicates dropped.
 * A non-formula depends on nothing.
 *
 * WHY THIS IS PARSED DIRECTLY rather than rendered through TransLaTeX, which is what it used to do:
 * the `cellNameRules` rule set is meant to re-emit a formula as nothing but its cell names, and for
 * bare arithmetic it does. For a FUNCTION CALL it has a `fn(cellRange)` case inside its `"=?"`
 * dispatch but no top-level rule for function application, so the expression fell through to the
 * generic `"??": "%1%2"` concatenation and the function's name was glued onto the first cell name:
 *
 *     =SUM(A1:A3)    ->  ["SUMA1", "A2", "A3"]     A1 lost
 *     =ROUND(A1,2)   ->  ["ROUNDA1"]               nothing tracked
 *     =IF(A1,B1,C1)  ->  ["IFA1"]                  B1 and C1 lost
 *
 * That was not cosmetic. This list is the reverse edge that drives recalculation, so a cell reading
 * A1 through a function call was never woken when A1 changed: a learner edited an input and the
 * total below it silently kept a stale value, which in an assessed sheet is the value that gets
 * graded. Confirmed in the browser before the fix — `=ROUND(B1,2)` never updated at all, and
 * `=SUM(B1:B3)` updated only when some OTHER cell in the range was touched.
 *
 * Parsing the references directly is both correct and simpler than teaching the rule set about
 * every call shape. The old code also returned the raw formula STRING when the translator threw,
 * which callers then iterated character by character; this always returns an array.
 */
export const getSingleCellDependencies = ({ env, name }): string[] => {
  const text = env.cells[name]?.text || "";
  if (!text || text.indexOf("=") !== 0) return [];

  // Upper-case outside quoted strings, so `=sum(a1:a3)` resolves like `=SUM(A1:A3)`; then blank the
  // quoted segments, because a cell name inside a string literal is text, not a reference. `$B$4`
  // is B4: without stripping the anchors the pattern below finds no reference in it at all.
  const formula = toUpperCase(stripAbsoluteReferences(text))
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''");

  const deps: string[] = [];
  const seen = new Set<string>();
  CELL_REF.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CELL_REF.exec(formula)) !== null) {
    // `A1:A3` contributes every cell between its corners; a lone `A1` contributes itself.
    for (const cell of (match[2] ? getCellRange(match[1], match[2]) : [match[1]])) {
      if (!seen.has(cell)) {
        seen.add(cell);
        deps.push(cell);
      }
    }
  }
  return deps;
};

export interface DependencyGraph {
  /** name -> the cells it reads, in formula order, ranges expanded. */
  precedents: Map<string, string[]>;
  /** name -> the cells that read it. The reverse index, which did not exist before. */
  dependents: Map<string, Set<string>>;
  /** The formula each edge list was derived from, so `setFormula` can skip unchanged text. */
  text: Map<string, string>;
}

export interface CycleResult {
  hasCycle: boolean;
  cyclePath?: string[];
  dependencies: string[];
}

const textOf = (cells: any, name: string): string => cells[name]?.text || "";

/** Link `name -> deps` into both directions. */
const link = (graph: DependencyGraph, name: string, deps: string[]): void => {
  graph.precedents.set(name, deps);
  for (const dep of deps) {
    let readers = graph.dependents.get(dep);
    if (!readers) graph.dependents.set(dep, (readers = new Set<string>()));
    readers.add(name);
  }
};

/** Drop every edge out of `name`, leaving the edges INTO it alone. */
const unlink = (graph: DependencyGraph, name: string): void => {
  const previous = graph.precedents.get(name);
  if (!previous) return;
  for (const dep of previous) graph.dependents.get(dep)?.delete(name);
  graph.precedents.delete(name);
};

/** One pass over the cells: parse each formula once, record both directions. */
export const buildGraph = (cells: any): DependencyGraph => {
  const graph: DependencyGraph = {
    precedents: new Map(),
    dependents: new Map(),
    text: new Map(),
  };
  const env = { cells };
  for (const name of Object.keys(cells)) {
    const text = textOf(cells, name);
    if (text.indexOf("=") !== 0) continue;
    graph.text.set(name, text);
    link(graph, name, getSingleCellDependencies({ env, name }));
  }
  return graph;
};

/**
 * Re-point one cell's outgoing edges after its text changed. O(deps), not O(cells) — this is what
 * makes an edit cheap, and it is why the graph is kept rather than rebuilt.
 */
export const setFormula = (graph: DependencyGraph, name: string, text: string, cells: any): void => {
  if (graph.text.get(name) === text) return;
  unlink(graph, name);
  if (text.indexOf("=") !== 0) {
    graph.text.delete(name);
    return;
  }
  graph.text.set(name, text);
  link(graph, name, getSingleCellDependencies({ env: { cells }, name }));
};

/** Forget a cell entirely, in both directions. */
export const removeCell = (graph: DependencyGraph, name: string): void => {
  unlink(graph, name);
  graph.text.delete(name);
  graph.dependents.delete(name);
};

/**
 * An edge source that parses a cell's references on FIRST ACCESS and remembers them.
 *
 * This exists so a cycle check does not have to build the whole graph. A walk from one cell
 * touches only its transitive precedents, and for a caller checking one cell — which is what
 * `evalCell` does, once per evaluation — building every edge in the sheet would be O(cells) of
 * regex work per evaluation, i.e. O(cells^2) over a mount. Sharing one of these across several
 * starts is safe and is the point: edges are shared, traversal state is not.
 */
export const lazyPrecedents = (cells: any): ((name: string) => string[]) => {
  const memo = new Map<string, string[]>();
  const env = { cells };
  return (name: string): string[] => {
    let deps = memo.get(name);
    if (deps === undefined) memo.set(name, (deps = getSingleCellDependencies({ env, name })));
    return deps;
  };
};

/**
 * The three-colour DFS, over whatever edge source it is handed.
 *
 * The path is one mutable array pushed and popped rather than `[...path, cell]` per edge, so a
 * deep chain no longer allocates a fresh array for every step; it is sliced only when a cycle is
 * actually found, which is the uncommon case.
 */
export const findCycleWith = (
  precedentsOf: (name: string) => string[],
  startCell: string,
): CycleResult => {
  const GRAY = 1, BLACK = 2;
  const colors = new Map<string, number>();
  const dependencies = new Set<string>();
  const path: string[] = [];
  let cyclePath: string[] | undefined;

  const dfs = (cell: string): boolean => {
    if (colors.get(cell) === GRAY) {
      const cycleStart = path.indexOf(cell);
      cyclePath = path.slice(cycleStart).concat([cell]);
      return true;
    }
    if (colors.get(cell) === BLACK) return false;

    colors.set(cell, GRAY);
    path.push(cell);
    for (const dep of precedentsOf(cell)) {
      dependencies.add(dep);
      if (dfs(dep)) return true;
    }
    path.pop();
    colors.set(cell, BLACK);
    return false;
  };

  const hasCycle = dfs(startCell);
  return {
    hasCycle,
    cyclePath: hasCycle ? cyclePath : undefined,
    dependencies: Array.from(dependencies),
  };
};

/** Cycle detection over a graph that is already built. */
export const findCycle = (graph: DependencyGraph, startCell: string): CycleResult =>
  findCycleWith((name) => graph.precedents.get(name) || [], startCell);

/**
 * Every cell that transitively reads any of `names` — a BFS over the reverse index, each cell
 * enqueued once. The seeds themselves are not included.
 */
export const dependentsOf = (graph: DependencyGraph, names: Iterable<string>): string[] => {
  const seen = new Set<string>(names);
  const queue = [...seen];
  const out: string[] = [];
  while (queue.length) {
    for (const reader of graph.dependents.get(queue.shift() as string) || []) {
      if (seen.has(reader)) continue;
      seen.add(reader);
      out.push(reader);
      queue.push(reader);
    }
  }
  return out;
};

/**
 * Kahn's algorithm over `names` only, counting in-degrees against precedents INSIDE that set — a
 * dependency outside it is already evaluated and does not constrain the order.
 *
 * Cells left with a non-zero in-degree are exactly the ones caught in a cycle, so cycle detection
 * falls out of ordering for free and `findCycle` only has to run on that leftover, and only to
 * recover the path text for the error message.
 */
export const topoOrder = (
  graph: DependencyGraph,
  names: Iterable<string>,
): { order: string[]; cyclic: string[] } => {
  const set = new Set<string>(names);
  const inDegree = new Map<string, number>();
  for (const name of set) {
    let degree = 0;
    for (const dep of graph.precedents.get(name) || []) if (set.has(dep)) degree++;
    inDegree.set(name, degree);
  }

  const ready: string[] = [];
  for (const [name, degree] of inDegree) if (degree === 0) ready.push(name);

  const order: string[] = [];
  while (ready.length) {
    const name = ready.shift() as string;
    order.push(name);
    for (const reader of graph.dependents.get(name) || []) {
      if (!set.has(reader)) continue;
      const degree = (inDegree.get(reader) as number) - 1;
      inDegree.set(reader, degree);
      if (degree === 0) ready.push(reader);
    }
  }

  const cyclic: string[] = [];
  for (const [name, degree] of inDegree) if (degree > 0) cyclic.push(name);
  return { order, cyclic };
};
