// SPDX-License-Identifier: MIT
// @graffiticode/l0186-view — L0186's board Form, plus the shared View it is injected into
// (re-exported from the base language's view package). `Form` and `./style.css` are the
// contract the MCP server's widget registry relies on.
export { Form, Board, BoardPreview, PageChrome } from "./components/board";
export type { BoardData, BoardPage } from "./components/board";
export { layoutPage } from "./lib/layout";
export type { PageLayout, Placed, Route, Box } from "./lib/layout";
export { View } from "@graffiticode/l0000-view";
export type { FormProps, FormComponent, CompileError } from "@graffiticode/l0000-view";
