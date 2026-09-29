// SPDX-License-Identifier: MIT
/**
 * L0179's Form: the heading panel, the sheet chrome, and one grid per sheet.
 *
 * ── Why every sheet is mounted, and only hidden ──────────────────────────────────────────────
 *
 * `TableEditor` is uncontrolled: it seeds a ProseMirror document from `interaction.cells` and
 * owns the editing state after that. The embed runs with `formModel="loaded"`, so the shared View
 * hands it back only the model as last loaded from OUTSIDE — never the Form's own edits, because
 * feeding those back re-seeds the document and throws the caret to A1 on every commit.
 *
 * That combination means a destroyed grid cannot be restored: unmount sheet 1 on a tab switch and
 * its edits live only in `data`, so remounting re-seeds from the stale loaded model and the
 * learner watches their typing vanish. So sheets are not swapped — each is mounted once, on first
 * visit, and kept. Switching a tab changes which one is visible. ProseMirror state persists
 * because the editor never goes away.
 *
 * Mounting is lazy so a sheet is first laid out while VISIBLE; a ProseMirror table measured
 * inside `display: none` comes back with the wrong column widths.
 *
 * ── Keys on the way out ─────────────────────────────────────────────────────────────────────
 *
 * With several sheets a `response` is keyed `s1!A1`, because the Learnosity lifecycle stores one
 * flat map and two sheets both holding `A1` would collide — see ../../scoring/sheets.ts. An
 * `update` instead carries a bare `cells` map plus its `sheetId`, which is what ./reduce.ts needs
 * to merge into the right sheet. One sheet keeps bare keys and no `sheetId`, so an existing item
 * behaves exactly as it did.
 */
import React from "react"; React;
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

import { Editor } from "./Editor";
import { SheetChrome } from "./SheetChrome";
import { qualify, responseOverlay, sheetValidation } from "../../scoring/sheets.js";
import "../../index.css";
import "./Form.css";

function classNames(...classes: any[]) {
  return classes.filter(Boolean).join(" ");
}

function renderErrors(errors: { message: string }[], theme: string | undefined) {
  return (
    <div className="flex flex-col gap-2">
      {errors.map((error, i) => (
        <div
          key={i}
          className={classNames(
            "rounded-md p-3 border text-sm",
            theme === "dark"
              ? "bg-red-900/50 border-red-700 text-red-200"
              : "bg-red-50 border-red-200 text-red-800",
          )}
        >
          {error.message}
        </div>
      ))}
    </div>
  );
}

/**
 * The sheets to render. `interaction.sheets` is present only when the compiler had something to
 * say that the flat fields could not carry — more than one sheet, or an authored name — so the
 * fallback here is not a special case, it is the ordinary single-sheet program.
 */
function sheetsOf(interaction: any) {
  if (Array.isArray(interaction?.sheets) && interaction.sheets.length) {
    // Lay the learner's saved answers back over each sheet. The Learnosity lifecycle restores a
    // response by folding it into `interaction.cells` and nowhere else — correct for one sheet,
    // where that is what the grid renders, but a multi-sheet grid renders from these per-sheet
    // maps. Without this, reopening a two-sheet item shows every answer gone. See
    // ../../scoring/sheets.ts. Done HERE, inside the memo, so the merged `cells` keeps a stable
    // identity — TableEditor re-seeds whenever that identity changes.
    return interaction.sheets.map((sheet: any) => {
      const saved = responseOverlay(interaction.cells, sheet.id);
      if (!Object.keys(saved).length) return sheet;
      // Per CELL, not per map — exactly as `mergeResponse` does it. A response carries only
      // {text, val, formula}, so replacing the cell wholesale would drop its `assess` rules and
      // its formatting, and the grid would stop marking the cell as assessed.
      // One copy of the map, then mutate: the spread-per-cell form was O(N^2) in the saved set.
      const cells: any = { ...(sheet.cells || {}) };
      for (const name of Object.keys(saved)) {
        cells[name] = { ...cells[name], ...saved[name] };
      }
      return { ...sheet, cells };
    });
  }
  return [{
    id: "s1",
    name: "Sheet1",
    rows: interaction?.rows,
    columns: interaction?.columns,
    cells: interaction?.cells,
    ...(interaction?.hideMenu !== undefined ? { hideMenu: interaction.hideMenu } : {}),
  }];
}

export const Form = ({ state }: any) => {
  const theme = typeof state.data === "object" && state.data !== null ? state.data.theme : undefined;
  const interaction = state.data?.interaction;
  const sheets = useMemo(() => sheetsOf(interaction), [interaction]);
  const multi = sheets.length > 1;

  const [activeId, setActiveId] = useState<string>(sheets[0]?.id);
  // Every sheet visited so far. Mounted once and kept, so its editing state survives a switch.
  const [visited, setVisited] = useState<string[]>(() => [sheets[0]?.id]);

  // A sheet the model no longer has (a recompile dropped it) must not stay selected.
  const active = sheets.some((s: any) => s.id === activeId) ? activeId : sheets[0]?.id;

  const select = (id: string) => {
    setActiveId(id);
    setVisited((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };

  // Hooks must run before the early return below, so errors are rendered after all of them.
  if (Array.isArray(state.errors) && state.errors.length > 0) {
    return renderErrors(state.errors, theme);
  }

  const showMenu = interaction?.hideSheetMenu !== true;
  const showTabs = interaction?.showSheetTabs !== undefined
    ? interaction.showSheetTabs === true
    : multi;

  return (
    <div className={classNames("rounded-md font-mono flex flex-col gap-4 p-4")}>
      {(state.data?.title || state.data?.instructions) && (
        <div
          className="instruction-panel mb-4 p-4 border border-gray-200 rounded-none font-sans"
          style={{ fontFamily: "Arial, sans-serif" }}
        >
          {state.data?.title && (
            <h1 className="text-xl font-bold mb-2">
              <ReactMarkdown>{state.data.title}</ReactMarkdown>
            </h1>
          )}
          {state.data?.instructions && (
            <div className="text-gray-700 prose max-w-none">
              <ReactMarkdown
                components={{
                  ul: ({ ...props }) => <ul className="list-disc pl-5 mb-4" {...props} />,
                  ol: ({ ...props }) => <ol className="list-decimal pl-5 mb-4" {...props} />,
                  li: ({ ...props }) => <li className="mb-1" {...props} />,
                }}
              >
                {state.data.instructions}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}

      {/* The grid and its chrome are one unit — the bar belongs to the bottom of the sheet, the
          way a spreadsheet draws it, so this wrapper holds them with no gap between. The gap in
          the outer container still separates the heading panel from the sheet. */}
      <div className="gc-sheet-area">
        {sheets.map((sheet: any) => (
          // `|| sheet.id === active` is not redundant with `visited`. `visited` is seeded on the
          // first render, and if the model later changes which sheets exist — a recompile that
          // renames or drops one — the newly-active sheet is not in it, and the grid would render
          // as nothing at all. Keying on `active` too means the visible sheet is always mounted.
          (visited.includes(sheet.id) || sheet.id === active) ? (
            <div key={sheet.id} style={sheet.id === active ? undefined : { display: "none" }}>
              <Editor state={sheetState(state, sheet, multi)} />
            </div>
          ) : null
        ))}

        <SheetChrome
          sheets={sheets.map((s: any) => ({ id: s.id, name: s.name || s.id }))}
          activeId={active}
          onSelect={select}
          showMenu={showMenu}
          showTabs={showTabs}
        />
      </div>
    </div>
  );
};

/**
 * One sheet's slice of the model, in the flat shape `TableEditor` reads, plus an `apply` that
 * says which sheet an action came from.
 *
 * Not memoised on purpose: `TableEditor` re-seeds when the IDENTITY of `interaction.cells`
 * changes, and this passes the sheet's own `cells` object straight through, so identity changes
 * only when the model's does.
 */
function sheetState(state: any, sheet: any, multi: boolean) {
  return {
    ...state,
    data: {
      ...state.data,
      // The sheet's own answer key: the grid scores its bare cells with it, to colour them.
      ...(multi && state.data?.validation
        ? { validation: sheetValidation(state.data.validation, sheet.id) }
        : {}),
      interaction: {
        type: "table",
        rows: sheet.rows,
        columns: sheet.columns,
        cells: sheet.cells,
        ...(sheet.hideMenu !== undefined ? { hideMenu: sheet.hideMenu } : {}),
      },
    },
    apply: (action: any) => {
      if (!multi || !action?.args?.cells) return state.apply(action);
      if (action.type === "response") {
        // Flat and qualified: the Learnosity lifecycle stores one map for the whole item.
        return state.apply({ ...action, args: { ...action.args, cells: qualify(sheet.id, action.args.cells) } });
      }
      if (action.type === "update") {
        // Bare plus a sheet id: ./reduce.ts merges it into that sheet's cells.
        return state.apply({ ...action, args: { ...action.args, sheetId: sheet.id } });
      }
      return state.apply(action);
    },
  };
}
