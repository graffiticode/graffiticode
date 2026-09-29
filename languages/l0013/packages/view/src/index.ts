// SPDX-License-Identifier: MIT
// @graffiticode/l0013-view — L0013's Form + a minimal read-only View that keeps the Form mounted
// during loading so its "Working…" animation is visible (the shared l0000-view View renders blank
// until data is ready). Types are re-exported from the parent language's view package.
export { Form } from "./components/form";
export { View } from "./components/view";
export type { FormProps, FormComponent, CompileError } from "@graffiticode/l0000-view";
