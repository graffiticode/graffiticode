// SPDX-License-Identifier: MIT
/**
 * The spreadsheet engine — everything the grid does that is not drawing.
 *
 * Renderer-agnostic by construction: nothing here imports React, ProseMirror, or the DOM. That is
 * the point. It was extracted from TableEditor.tsx, where roughly half the surrounding code exists
 * only to make a rich-text editor behave like a grid; keeping the engine out of that makes a future
 * renderer a re-skin rather than a rewrite, and makes the engine testable, which it was not before.
 *
 * Not to be confused with ../scoring, which decides whether an answer is RIGHT. This decides what a
 * cell IS. Scoring stays separate because Learnosity loads it server-side in bare Node.
 */
export {
  evalCell,
  formatCellValue,
  fixText,
  isDateFormat,
  getCellDependencies,
  detectCycles,
} from "./formula.js";
export type { CycleDetectionResult, CellValue } from "./formula.js";

// The dependency graph. `getSingleCellDependencies` is re-exported from here rather than from
// formula.ts because it moved to sit with the structure it feeds; the name and behaviour are
// unchanged, which is what keeps formula.test.ts importing it from this barrel untouched.
export {
  getSingleCellDependencies,
  buildGraph,
  setFormula,
  removeCell,
  findCycle,
  dependentsOf,
  topoOrder,
} from "./graph.js";
export type { DependencyGraph, CycleResult } from "./graph.js";

// The evaluation memo. There is no shared instance on purpose: the caller owns its lifetime, and
// a module-level one would leak across sheets and across scorer invocations. See cache.ts.
export { createSheetCache } from "./cache.js";
export type { SheetCache } from "./cache.js";

// Recalculation: one topologically-ordered pass, each affected cell evaluated exactly once.
export { recalculate } from "./recalc.js";
export type { RecalcResult } from "./recalc.js";

export { getResponses, getChangedCells } from "./payload.js";

export {
  columnToNumber,
  numberToColumn,
  getColumnRange,
  getRowRange,
  getCellRange,
} from "./address.js";

export { getCellColor, mergeBorders, ASSESS_VALID, ASSESS_INVALID } from "./presentation.js";
