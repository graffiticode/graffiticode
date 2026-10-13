// SPDX-License-Identifier: MIT
/**
 * L0179's language-specific reducer cases, passed to the shared View as `reduce`.
 *
 * L0179 renders L0166's spreadsheet Form (see Form.tsx), so it must speak L0166's state
 * protocol. All of that protocol is generic except one case: an `update` carrying `cells`.
 * L0166's Form reports an edited cell as `{cells: {A1: {text, formattedValue}}}` and expects
 * it merged into `data.interaction.cells`, per cell, PRESERVING each cell's other properties
 * (its `assess` rules, its formatting).
 *
 * The shared View's generic `update` merges onto the top level instead, which writes a `cells`
 * key nothing renders and leaves `interaction.cells` untouched — the edit never reaches the
 * grid, and the next compile response redraws the sheet from source, erasing what was typed.
 * Transcribed from L0166's own reducer so the two agree.
 *
 * Everything else — `init`, `compiled`, `response`, `focus` — is returned as `undefined` so
 * the shared View handles it.
 */
import type { StateAction, LanguageReducer } from "@graffiticode/l0000-view";

/** The per-cell fields L0166's Form reports on an edit. */
const mergeCell = (prev: any, next: any) => ({
  ...prev,
  text: next?.text,
  formattedValue: next?.formattedValue,
});

/**
 * Fold reported cells into one cell map, preserving everything the report does not carry.
 *
 * Copied once, then mutated. The spread-per-cell form this replaces was O(N^2), and the initial
 * `update` at mount reports EVERY cell. The fresh-object identity is load-bearing — TableEditor
 * re-seeds on the identity of `interaction.cells` — so the copy stays; only the per-cell copies go.
 */
const mergeCells = (into: any, reported: any) => {
  const merged: any = { ...(into || {}) };
  for (const name of Object.keys(reported)) {
    merged[name] = mergeCell(merged[name], reported[name]);
  }
  return merged;
};

export const reduce: LanguageReducer = (data: any, { type, args }: StateAction) => {
  // A `response` is the learner's answers, flat and sheet-qualified (`s2!A1`), and each one
  // carries only the sheet it came from. The shared View would REPLACE the top-level `cells` with
  // it, so with several sheets every answer but the last-edited sheet's was lost — and those are
  // what the Check button scores (../../scoring/total.ts). Merged per key, as learnosity-cqt's
  // reducer does. With one sheet a response always carries every assessed cell, so this is the
  // same map the replacement produced.
  if (type === "response" && args?.cells && data && typeof data === "object") {
    return { ...data, ...args, cells: { ...(data.cells || {}), ...args.cells } };
  }
  // Only an `update` carrying cells is ours; anything else falls through to the shared View.
  if (type !== "update" || !args?.cells || !data?.interaction) return undefined;

  // With several sheets the Form tags the edit with the sheet it came from. Merging into
  // `interaction.cells` regardless would write sheet 2's edit onto sheet 1's grid — the same
  // class of mistake as merging onto the top level, one level down.
  const { sheetId } = args as any;
  if (sheetId && Array.isArray(data.interaction.sheets)) {
    const sheets = data.interaction.sheets.map((s: any) => (
      s.id === sheetId ? { ...s, cells: mergeCells(s.cells, args.cells) } : s
    ));
    return {
      ...data,
      interaction: {
        ...data.interaction,
        sheets,
        // The flat fields mirror the first sheet, for consumers that predate `sheets`.
        ...(sheets[0]?.id === sheetId ? { cells: sheets[0].cells } : {}),
      },
    };
  }

  return {
    ...data,
    interaction: { ...data.interaction, cells: mergeCells(data.interaction.cells, args.cells) },
  };
};
