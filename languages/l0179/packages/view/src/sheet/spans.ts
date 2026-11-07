// SPDX-License-Identifier: MIT
/**
 * Merged cells, as the model states them: `colspan` / `rowspan` on the top-left cell.
 *
 * The compiler refuses overlapping spans and spans past column Z (packages/core/src/spans.ts), so
 * this reads them without re-checking — but defensively: a span that is not a whole number from 1
 * up is read as 1, and a model edited by hand cannot make this throw.
 *
 * Three consumers, and they want different things from a covered address (B1 under an A1:F1
 * merge):
 *   - the DOCUMENT omits its cell, so the table has no node there;
 *   - the ENGINE keeps it as a logical blank, so `=A1*B1` reads an empty B1 exactly as it would
 *     without the merge (a missing address changes how a formula parses);
 *   - CONTENT WRITES skip it, because TableMap resolves a covered position to the anchor's node,
 *     and writing B1's text there would overwrite A1.
 */

/** Column letter to its index: A is 1. */
export const columnIndex = (letter: string): number => letter.charCodeAt(0) - 64;
export const columnLetter = (index: number): string => String.fromCharCode(64 + index);

export interface Span {
  /** Columns and rows, 1-based, inclusive. */
  c1: number;
  r1: number;
  c2: number;
  r2: number;
}

export interface Spans {
  /** The merged cells, by anchor name. Only cells that actually span more than one cell. */
  anchors: Record<string, Span>;
  /** Each covered address, mapped to the anchor whose span hides it. */
  covered: Map<string, string>;
}

const count = (v: any): number => (Number.isInteger(v) && v >= 1 ? v : 1);

const ADDRESS = /^([A-Z])([1-9][0-9]*)$/;

/** The merges in a sheet's `cells`. */
export const spansOf = (cells: any): Spans => {
  const anchors: Record<string, Span> = {};
  const covered = new Map<string, string>();
  for (const name of Object.keys(cells || {})) {
    const m = ADDRESS.exec(name);
    if (!m) continue;
    const cell = cells[name] || {};
    const cs = count(cell.colspan ?? cell.attrs?.colspan);
    const rs = count(cell.rowspan ?? cell.attrs?.rowspan);
    if (cs === 1 && rs === 1) continue;
    const c1 = columnIndex(m[1]);
    const r1 = Number(m[2]);
    const span = { c1, r1, c2: Math.min(c1 + cs - 1, 26), r2: r1 + rs - 1 };
    anchors[name] = span;
    for (let r = span.r1; r <= span.r2; r++) {
      for (let c = span.c1; c <= span.c2; c++) {
        if (r === r1 && c === c1) continue;
        covered.set(`${columnLetter(c)}${r}`, name);
      }
    }
  }
  return { anchors, covered };
};

/** The bottom-right corner a sheet needs, merges included: the last column index and row. */
export const gridExtent = (cells: any): { x: number; y: number } => {
  let x = 0;
  let y = 0;
  for (const name of Object.keys(cells || {})) {
    // Only A-Z name a column; anything else contributes no width, as before merges existed.
    const letter = name.slice(0, 1);
    const cx = /^[A-Z]$/.test(letter) ? columnIndex(letter) : -1;
    const cy = +name.slice(1);
    if (cx > x) x = cx;
    if (cy > y) y = cy;
  }
  for (const span of Object.values(spansOf(cells).anchors)) {
    if (span.c2 > x) x = span.c2;
    if (span.r2 > y) y = span.r2;
  }
  return { x, y };
};
