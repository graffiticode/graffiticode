// SPDX-License-Identifier: MIT
// @graffiticode/l0179-view — L0179's Form and its reducer cases, plus the shared View they
// are injected into (re-exported from the parent language's view package).
// The stylesheet is a side effect of the entry so the lib build extracts it to dist/style.css,
// which is what the package's "./style.css" export points at. Without this import nothing
// references index.css from the library entry (only embed/main.tsx did), the file is never
// emitted, and that export subpath 404s for every consumer.
import "./index.css";

export { Form, reduce } from "./components/form";
// Scoring is L0179's own, and deliberately DOES NOT travel with the Form: ./scoring imports no
// React and no ProseMirror, so the Learnosity scorer bundle -- which Learnosity also runs
// server-side -- can load it in bare Node. Verified equivalent to L0166's implementation over
// all 129 corpus programs before that dependency was dropped; see ./scoring/score.ts.
export { scoreCells, getCellsValidation, score } from "./scoring/index.js";
export { View } from "@graffiticode/l0000-view";
import type { FormModel } from "@graffiticode/l0000-view";
/**
 * The `formModel` every host must mount this Form with. L0166's spreadsheet Form is
 * UNCONTROLLED: its TableEditor rebuilds the whole grid -- caret back to A1 -- whenever
 * `interaction.cells` changes identity, and `reduce` answers each cell `update` with fresh
 * cells. Hand the Form its own edits back and it re-seeds on every caret move; in the MCP
 * widget, which mounted it "live", that was an endless rebuild loop (a sheet that jittered and
 * could not be typed into). Exported so a host reads it from the package, as it reads `reduce`
 * and `score`, instead of each host having to know.
 */
export const formModel: FormModel = "loaded";
export type {
  FormProps,
  FormComponent,
  FormModel,
  CompileError,
  StateAction,
  LanguageReducer,
  LanguageScore,
  Score,
} from "@graffiticode/l0000-view";
