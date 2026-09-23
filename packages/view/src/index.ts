// SPDX-License-Identifier: MIT
// @graffiticode/l0183-view — L0183's concept web Form, plus the shared View it is injected into
// (re-exported from the base language's view package).
//
// Scoring is re-exported here for convenience AND published on its own `./scoring` subpath. The
// Learnosity scorer must import the subpath: this entry carries React and the renderer, and
// Learnosity runs the scorer server-side.
export { Form, Web, reduce } from "./components/web";
export type { Interaction, Tray, WebEdge, WebNode } from "./components/web";
export { scoreCells, getCellsValidation, scoreResponse, totalScore } from "./scoring";
export type { CellKey, CellScore, Validation } from "./scoring";
export { View } from "@graffiticode/l0000-view";
export type { FormProps, FormComponent, CompileError } from "@graffiticode/l0000-view";
