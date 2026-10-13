// SPDX-License-Identifier: MIT
/**
 * The compile-time passes that build L0166's output contract, ported VERBATIM from L0166
 * (packages/api/src/compiler.js). L0179 emits the same `validation` and the same resolved
 * `cells`, so these are transcribed rather than rewritten — including `rowInRegion`'s
 * `||`-should-be-`&&`, which is load-bearing for existing programs and is pinned by the
 * differential test in tools/differential-test.ts. Do not "fix" it here; fixing it is a
 * behaviour change for both languages and belongs in its own change.
 */

export const rowInRegion = (region, cellName) => {
  const [min, max] = region.split("..");
  const row = cellName.slice(1);
  return +row >= +min || +row <= +max;
};

export const getPrimaryColumn = (rows, cellName) => {
  // Check rows to see if cellName is included.
  // If so, return the index col.
  const region = rows && Object.keys(rows).find(key =>
    (key === "*" || rowInRegion(key, cellName)) && key
  ) || "*";
  return [region, rows && rows[region]?.assess?.index || null];
};

export const getIndexCell = (cells, colName, cellName) => (
  // Get the cell of the index col for the same row as cellName.
  // If there is an assess field, return it.
  // If not, then return null.
  cells[colName + cellName.slice(1)]
);

// TODO Scoring will find a match for the index assess and then score the
// current cell with its assess.
// If there is no assess in the index cell, then the cell is scored as is.

// `points` may be authored on a cell's own assess, or on the assess of the row
// region or column the cell belongs to. Resolve inheritance here, at compile
// time, so that every assessed cell carries a concrete `points` value.
//
// This is a correctness requirement, not a convenience: the deployed Learnosity
// scorer computes the earned score by summing each cell's `assess.points` while
// taking the maximum from `validation.points` (which getValidation sums from
// the same cells). If an inherited value reached only one of the two, a fully
// correct response could never equal the maximum.
//
// Precedence: cell > row > column.
export const hasOwnPoints = (assess) => (
  assess !== null &&
    typeof assess === "object" &&
    Object.prototype.hasOwnProperty.call(assess, "points") &&
    assess.points !== undefined
);

export const resolveInheritedPoints = (val) => {
  const { rows = {}, columns = {}, cells = {} } = val || {};
  const resolvedCells = Object.keys(cells).reduce((acc, key) => {
    const cell = cells[key];
    const assess = cell && cell.assess;
    // Unassessed cells score nothing, and an explicit `points` always wins —
    // including `points 0`, which is why this tests for the key rather than
    // for truthiness.
    if (!assess || hasOwnPoints(assess)) {
      acc[key] = cell;
      return acc;
    }
    const [rowRegion] = getPrimaryColumn(rows, key);
    const rowPoints = rows[rowRegion]?.assess?.points;
    const columnPoints = columns[key.slice(0, 1)]?.assess?.points;
    // Explicit typeof tests, not `||` — an inherited `points 0` is falsy and
    // would otherwise fall through to the next level or be dropped entirely.
    const inherited =
          typeof rowPoints === "number" ? rowPoints :
          typeof columnPoints === "number" ? columnPoints :
          undefined;
    acc[key] = inherited === undefined ? cell : {
      ...cell,
      assess: { ...assess, points: inherited },
    };
    return acc;
  }, {});
  return { ...val, cells: resolvedCells };
};

export const getValidation = ({rows = {}, cells = {}}) => (
  // TODO compile the index column and value for each validated cell.
  Object.keys(cells).reduce((obj, key) => {
    const [rowRegion, primaryColumn] = getPrimaryColumn(rows, key);
    const cell = cells[key];
    const col = key.slice(0, 1);
    const rowIndex = +key.slice(1) - 1;
    const order = rows[rowRegion]?.assess?.order || "expected";  // "actual", "asc", "desc", "expected" (default)
    const row = obj.regions[rowRegion]?.rows[rowIndex] || {}
    // Replace the current row in rows
    const newRows = obj.regions[rowRegion]?.rows || [];
    newRows[rowIndex] = {
      ...row,
      id: order !== "actual" && rowIndex + 1 || undefined,
      [col]: cell,
    };
    const points = cells[key]?.assess
          ? cells[key]?.assess?.points
          : 0;  // No validation so no points counted.
    return {
      ...obj,
      points: obj.points + (typeof points === "number" ? points : 1),
      regions: {
        ...obj.regions,
        [rowRegion]: {
          primaryColumn: primaryColumn,
          order,
          rows: newRows,
        },
      },
    }
  }, {points: 0, regions: {}, cells: {}})
);
