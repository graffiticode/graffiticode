// SPDX-License-Identifier: MIT
/**
 * Cell addresses and ranges — `"B2"` in, `{col: "B", row: "2"}` out, and the ranges between them.
 *
 * Lifted out of TableEditor.tsx unchanged. None of it ever touched ProseMirror: these operate on
 * names and produce names. They live here so the grid's arithmetic can be tested without mounting
 * an editor, and so a future renderer inherits them rather than reinventing them.
 *
 * NOTE the ceiling that is NOT here: `columnToNumber`/`numberToColumn` handle `AA`, `AB`, … but the
 * renderer caps the sheet at 26 columns, because `makeEditorState` derives the grid width with
 * `cellName.slice(0, 1)` against a 27-character alphabet. The compiler agrees — its address lexicon
 * entry is `^[A-Z][0-9]+$`, a single letter — so the limit is real and consistent, just not
 * expressed in this file.
 */

/** `"A"` → 1, `"Z"` → 26, `"AA"` → 27. */
export const columnToNumber = (col: string): number => {
  let num = 0;
  for (let i = 0; i < col.length; i++) {
    num = num * 26 + (col.charCodeAt(i) - "A".charCodeAt(0) + 1);
  }
  return num;
};

/** The inverse: 1 → `"A"`, 27 → `"AA"`. */
export const numberToColumn = (num: number): string => {
  let col = "";
  while (num > 0) {
    num--;
    col = String.fromCharCode("A".charCodeAt(0) + (num % 26)) + col;
    num = Math.floor(num / 26);
  }
  return col;
};

/** Inclusive, and order-insensitive — `("C","A")` gives the same span as `("A","C")`. */
export const getColumnRange = (startCol: string, endCol: string): string[] => {
  const start = columnToNumber(startCol);
  const end = columnToNumber(endCol);
  const min = Math.min(start, end);
  const max = Math.max(start, end);
  const columns: string[] = [];
  for (let i = min; i <= max; i++) {
    columns.push(numberToColumn(i));
  }
  return columns;
};

/** Inclusive, order-insensitive, and returns row numbers as STRINGS — they are used as keys. */
export const getRowRange = (startRow: string, endRow: string): string[] => {
  const start = parseInt(startRow);
  const end = parseInt(endRow);
  const min = Math.min(start, end);
  const max = Math.max(start, end);
  const rows: string[] = [];
  for (let i = min; i <= max; i++) {
    rows.push(String(i));
  }
  return rows;
};

/** The rectangle between two corners, in row-major order. `[]` if either name is malformed. */
export const getCellRange = (startCell: string, endCell: string): string[] => {
  // Parse cell names (e.g., "B2" -> col: "B", row: "2")
  const parseCell = (cell: string) => {
    const match = cell.match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;
    return { col: match[1], row: match[2] };
  };

  const start = parseCell(startCell);
  const end = parseCell(endCell);
  if (!start || !end) return [];

  const columns = getColumnRange(start.col, end.col);
  const rows = getRowRange(start.row, end.row);

  const cells: string[] = [];
  for (const row of rows) {
    for (const col of columns) {
      cells.push(col + row);
    }
  }
  return cells;
};
