// SPDX-License-Identifier: MIT
/**
 * The two payloads the grid sends upward, built from the cell environment.
 *
 * Lifted out of TableEditor.tsx unchanged. They are pure projections of the model, so they belong
 * with the engine rather than with the editor — and having them here means the shapes the host and
 * the scorer depend on can be tested without a DOM.
 *
 * These two are deliberately NOT the same projection, and the difference is the contract:
 *
 *   - `getResponses` is the gradable answer set. It keeps only cells the author marked with
 *     `assess`, and reports `{text, val, formula}` — everything the scorer needs to decide
 *     equivalence, including the raw formula for `method "formula"`.
 *   - `getChangedCells` is what the MODEL keeps. It reports `{text, formattedValue}` for the cells
 *     that changed, and the reducer merges it per cell so each cell's `assess` rules and formatting
 *     survive the edit.
 *
 * Both build their result by mutating one local object rather than by spreading an accumulator
 * through a `reduce`. That is not a style preference: `{...acc, [name]: v}` per cell copies the
 * whole result so far on every iteration, which is O(N^2). `getChangedCells` runs over EVERY cell
 * on the one-time initial `update` at mount, so on a 500-cell sheet the spread form was copying a
 * growing map 500 times. The result is a fresh object either way, which is what callers rely on.
 */
import { formatCellValue } from "./formula.js";

/** Assessed cells only, projected for scoring. */
export const getResponses = (cells: any): any => {
  const responses: any = {};
  for (const name of Object.keys(cells)) {
    const { text, val, formula, assess } = cells[name];
    if (assess) responses[name] = { text, val, formula };
  }
  return responses;
};

/** The named cells, projected for the `update` action. Unknown names are skipped, not nulled. */
export const getChangedCells = (cells: any, changedNames: string[], cache?: any): any => {
  const changed: any = {};
  // Hoisted: the env is the same for every name, and rebuilding it per cell allocated one wrapper
  // object per call for nothing.
  const env = { cells };
  for (const name of changedNames) {
    const cell = cells[name];
    if (!cell) continue;
    changed[name] = { text: cell.text, formattedValue: formatCellValue({ env, name, cache }) };
  }
  return changed;
};
