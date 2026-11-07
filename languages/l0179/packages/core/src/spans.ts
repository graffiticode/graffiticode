// SPDX-License-Identifier: MIT
/**
 * Merged cells: what a sheet's `colspan` / `rowspan` may and may not do.
 *
 * A span is written on the top-left cell of the merge, and the cells it covers are not rendered.
 * So any two cells whose rectangles meet are refused, not just a cell sitting inside a span: A2
 * `colspan 3` and C1 `rowspan 3` cross at C2 although neither anchor lies inside the other. Left
 * to the renderer either case would hide content the author wrote, with nothing to say why.
 *
 * A span may also not cross the edge of the frozen rows or columns. Its anchor is what sticks, so
 * a merge straddling the edge would pin all of itself: A1:F1 with `freeze-columns 1` would freeze
 * six columns.
 *
 * Mirrored in `crates/core/src/spans.rs`; the conformance fixtures hold the two to the same text.
 */
import { MAX_COUNT } from "./attributes.js";

interface Rect {
  key: string;
  c1: number;
  r1: number;
  c2: number;
  r2: number;
  spanned: boolean;
}

const letter = (c: number) => String.fromCharCode(64 + c);
const cellName = (c: number, r: number) => `${letter(c)}${r}`;
const describeRect = (r: Rect) =>
  r.spanned ? `${r.key} (spanning ${r.key}:${cellName(r.c2, r.r2)})` : r.key;

/** A span's value, or a message. Absent is 1; a raw record can reach here unvalidated. */
function spanOf(cell: any, word: "colspan" | "rowspan", key: string): number | string {
  const v = cell === null || cell === undefined ? undefined : cell[word];
  if (v === undefined) return 1;
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_COUNT) return v;
  return `cells: ${key}'s ${word} must be a whole number from 1 to ${MAX_COUNT}.`;
}

/** A freeze count, or 0 when absent or not a count (its own attribute check reported that). */
function countOf(v: any): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0;
}

/** The first problem with a sheet's spans, or null. `attrs` is the sheet's merged attributes. */
export function checkSpans(attrs: any): string | null {
  const cells = attrs && attrs.cells;
  if (!cells || typeof cells !== "object") return null;
  const rects: Rect[] = [];
  for (const key of Object.keys(cells)) {
    const cell = cells[key];
    const m = /^([A-Z])([1-9][0-9]*)$/.exec(key);
    if (!m) {
      const word = cell && (cell.colspan !== undefined ? "colspan" : cell.rowspan !== undefined ? "rowspan" : "");
      if (word) return `cells: "${key}" has ${word} but is not a cell address like A1.`;
      continue;
    }
    const cs = spanOf(cell, "colspan", key);
    if (typeof cs === "string") return cs;
    const rs = spanOf(cell, "rowspan", key);
    if (typeof rs === "string") return rs;
    const c1 = m[1].charCodeAt(0) - 64;
    const r1 = Number(m[2]);
    const rect = { key, c1, r1, c2: c1 + cs - 1, r2: r1 + rs - 1, spanned: cs > 1 || rs > 1 };
    if (rect.c2 > 26) {
      return `cells: ${key} colspan ${cs} runs past column Z, the last column.`;
    }
    rects.push(rect);
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (!a.spanned && !b.spanned) continue;
      if (a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2) {
        const at = cellName(Math.max(a.c1, b.c1), Math.max(a.r1, b.r1));
        return (
          `cells: ${describeRect(a)} and ${describeRect(b)} overlap at ${at}. A cell inside another ` +
          `cell's span is hidden, so its content never shows. Shorten the span or remove the covered cell.`
        );
      }
    }
  }
  const freezeRows = countOf(attrs.freezeRows);
  const freezeColumns = countOf(attrs.freezeColumns);
  for (const r of rects) {
    if (!r.spanned) continue;
    if (freezeRows > 0 && r.r1 <= freezeRows && r.r2 > freezeRows) {
      return (
        `sheet: ${describeRect(r)} crosses the edge of the frozen rows (freeze-rows ${freezeRows}). ` +
        `A merged cell must sit entirely inside or entirely outside them: widen freeze-rows to ${r.r2}, ` +
        `or shorten the span.`
      );
    }
    if (freezeColumns > 0 && r.c1 <= freezeColumns && r.c2 > freezeColumns) {
      return (
        `sheet: ${describeRect(r)} crosses the edge of the frozen columns (freeze-columns ${freezeColumns}). ` +
        `A merged cell must sit entirely inside or entirely outside them: widen freeze-columns to ${r.c2}, ` +
        `or shorten the span.`
      );
    }
  }
  return null;
}
