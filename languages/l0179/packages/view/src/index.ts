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
export type {
  FormProps,
  FormComponent,
  CompileError,
  StateAction,
  LanguageReducer,
  LanguageScore,
  Score,
} from "@graffiticode/l0000-view";
