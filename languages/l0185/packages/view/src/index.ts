// SPDX-License-Identifier: MIT
// @graffiticode/l0185-view — L0185's Form (the data a program produced: a table or a JSON tree),
// plus the shared View it is injected into (re-exported from the base language's view package).
// `Form` and `./style.css` are the contract the MCP server's widget registry relies on.
export { Form, Data, DataTable, JsonTree, isTable, columnsOf, toCsv } from "./components/data";
export { View } from "@graffiticode/l0000-view";
export type { FormProps, FormComponent, CompileError } from "@graffiticode/l0000-view";
