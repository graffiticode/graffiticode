// SPDX-License-Identifier: MIT
//
// The display-only capture context (C5, docs/c5-l0013-commands-plan.md).
//
// A camera that photographs a form (L0013's capture, `languages/l0013/crates/capture`) runs
// a script before any page script that sets
//
//   window.__graffiticodeCapture = { displayOnly: true }
//
// In that context the View loads the item's data once, through GET /data, renders it, and
// never recompiles: a Form's own `update`/`response` reports (L0179's spreadsheet sends one
// as soon as its cells are ready) still update the model it renders, but no POST /compile is
// sent. A capture under a render grant may only read (`GET /form` and `/data`); a recompile
// is refused there, and its error would be what the camera photographs.
//
// Absent, or anything but `displayOnly: true`, the View behaves exactly as before. The flag
// only ever removes requests, so a page that set it itself could do no more than stop its
// own recompiles.

/** The global a camera sets before any page script runs. */
export const CAPTURE_CONTEXT_GLOBAL = "__graffiticodeCapture";

/** Whether this page was opened by a camera in the display-only capture context. */
export const isDisplayOnlyCapture = (win: unknown = typeof window === "undefined" ? undefined : window): boolean => {
  const context = (win as Record<string, unknown> | undefined)?.[CAPTURE_CONTEXT_GLOBAL];
  return typeof context === "object" && context !== null && (context as { displayOnly?: unknown }).displayOnly === true;
};
