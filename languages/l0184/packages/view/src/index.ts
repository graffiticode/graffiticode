// SPDX-License-Identifier: MIT
// @graffiticode/l0184-view — L0184's charts Form, plus the shared View it is injected into
// (re-exported from the base language's view package). `Form` and `./style.css` are the
// contract the MCP server's widget registry relies on.
export { Form, Charts, EChart, ChartChrome } from "./components/charts";
export type { ChartsData, CompiledChart } from "./components/charts";
export { View } from "@graffiticode/l0000-view";
export type { FormProps, FormComponent, CompileError } from "@graffiticode/l0000-view";
