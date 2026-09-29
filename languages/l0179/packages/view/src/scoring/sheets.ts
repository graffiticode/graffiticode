// SPDX-License-Identifier: MIT
/**
 * Sheet-qualified cell keys: `"s1!A1"`.
 *
 * WHY A FLAT KEY SPACE RATHER THAN A NESTED SHAPE. The Learnosity lifecycle lives in
 * `@graffiticode/learnosity-cqt`, a published package shared with every other cell-scored
 * Graffiticode language, and it is flat-keyed in three places that cannot be changed from here:
 *
 *   - `mergeResponse` folds a response back in with `interaction.cells[cellName] = ...`;
 *   - the `response` reducer persists `{...interaction.cells, ...args.cells}`;
 *   - `Scorer.score()` sums `scoredCells[key].score.points` over one flat map.
 *
 * Two sheets both holding `A1` would collide at all three and mis-score silently. Qualifying the
 * KEY instead of nesting the SHAPE keeps every one of them working untouched, and matches the
 * convention a spreadsheet already uses for a cell on another sheet.
 *
 * A program with one sheet keeps bare `A1` keys, exactly as before — so every response already
 * stored against an existing item still reads correctly.
 */

/** `"s1!A1"` → `["s1", "A1"]`; `"A1"` → `[undefined, "A1"]`. */
export function splitKey(key: string): [string | undefined, string] {
  const i = key.indexOf("!");
  return i < 0 ? [undefined, key] : [key.slice(0, i), key.slice(i + 1)];
}

export const qualifyKey = (sheetId: string, name: string) => `${sheetId}!${name}`;

/** Re-key a bare cell map onto one sheet. Used on the way out of the grid. */
export function qualify(sheetId: string, cells: Record<string, any>): Record<string, any> {
  return Object.keys(cells || {}).reduce((acc: Record<string, any>, name) => {
    acc[qualifyKey(sheetId, name)] = cells[name];
    return acc;
  }, {});
}

/**
 * The saved answers belonging to one sheet, taken from the flat `interaction.cells`.
 *
 * This exists because of how the Learnosity lifecycle restores a response. `mergeResponse` folds
 * it into `interaction.cells` and nowhere else — which is right for a single sheet, since that is
 * what the grid renders from. A multi-sheet grid renders from `interaction.sheets[i].cells`,
 * which the fold never touches, so without this overlay a learner reopens a two-sheet item and
 * finds every answer they saved gone from the screen while it is still in the response.
 *
 * ONLY qualified keys are taken. An unqualified key in a multi-sheet model is the authored flat
 * mirror of the first sheet, not an answer, and treating it as one would overwrite that sheet
 * with its own pre-response state.
 */
export function responseOverlay(
  interactionCells: Record<string, any>,
  sheetId: string,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of Object.keys(interactionCells || {})) {
    const [id, name] = splitKey(key);
    if (id === sheetId) out[name] = interactionCells[key];
  }
  return out;
}

/**
 * Split a possibly-qualified map into one bare-keyed map per sheet.
 *
 * An unqualified key belongs to the FIRST sheet. That is not a fallback for convenience — it is
 * what makes an existing single-sheet response keep its meaning when the same code path starts
 * handling several sheets.
 */
export function splitBySheet(
  cells: Record<string, any>,
  sheetIds: string[],
): Record<string, Record<string, any>> {
  const out: Record<string, Record<string, any>> = {};
  for (const id of sheetIds) out[id] = {};
  for (const key of Object.keys(cells || {})) {
    const [sheetId, name] = splitKey(key);
    const id = sheetId ?? sheetIds[0];
    if (!out[id]) out[id] = {};
    out[id][name] = cells[key];
  }
  return out;
}

/**
 * One sheet's answer key, for a grid that renders that sheet alone.
 *
 * A multi-sheet `validation` carries each sheet's key under `sheets[id]`, and `scoreCells` given
 * the whole of it expects sheet-qualified cells and returns sheet-qualified scores. A sheet's grid
 * holds bare `A1` cells and looks scores up by bare name, so handed the whole key it found none
 * and never coloured a cell — instant feedback or after a check. Its own key keeps the grid on
 * the single-sheet path, where bare cells and bare scores line up. One sheet: unchanged.
 */
export function sheetValidation(validation: any, sheetId: string): any {
  return validation?.sheets?.[sheetId] ?? validation;
}
