// SPDX-License-Identifier: MIT
/**
 * The score the host's Check button reports, from the live /form model.
 *
 * It is the Learnosity scorer's sum, taken over the same inputs as that host has them: the
 * learner's responses (`data.cells`, flat and sheet-qualified — see ./sheets.ts and the `response`
 * case in ../components/form/reduce.ts), the answer key, and the grid an `expected` formula
 * resolves against. With several sheets that grid is qualified too, so sheet 2's formula reads
 * sheet 2's cells rather than falling back to sheet 1's flat ones.
 */
import { getCellsValidation, scoreCells } from "./score.js";
import { qualify } from "./sheets.js";

/** The authored grid, keyed the way the responses are. */
function gridOf(interaction: any): any {
  const sheets = interaction?.sheets;
  if (Array.isArray(sheets) && sheets.length > 1) {
    return Object.assign({}, ...sheets.map((s: any) => qualify(s.id, s.cells || {})));
  }
  return interaction?.cells;
}

/**
 * `{score, max, complete}` for the model, or `undefined` when there is nothing to check — no answer
 * key, or no assessed cell. `complete` is every assessed cell holding text; until then the View
 * keeps Check disabled. Never throws: the View calls it on every change.
 */
export const score = (
  data: any,
): { score: number; max: number; complete: boolean } | undefined => {
  const validation = data?.validation;
  if (!validation || typeof validation !== "object") return undefined;
  try {
    const responses = data.cells && typeof data.cells === "object" ? data.cells : {};
    const key = getCellsValidation({ cells: responses, validation }) || {};
    if (Object.keys(key).length === 0) return undefined;
    const scored = scoreCells({
      cells: responses,
      validation,
      interactionCells: gridOf(data.interaction),
    }) || {};
    const total = Object.keys(scored).reduce(
      (sum, name) => sum + (scored[name]?.score?.points || 0),
      0,
    );
    // A cell the learner never touched has no response entry; its authored text, if any, is what
    // the grid shows, so an assessed cell that comes pre-filled does not hold Check back forever.
    const grid = gridOf(data.interaction) || {};
    const shown = (cell: any) => String(cell?.text ?? cell?.val ?? "").trim();
    const answered = (name: string) => (shown(responses[name]) || shown(grid[name])) !== "";
    return {
      score: total,
      max: validation.points || 0,
      complete: Object.keys(key).every(answered),
    };
  } catch {
    return undefined;
  }
};
