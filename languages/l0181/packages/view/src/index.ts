// SPDX-License-Identifier: MIT
// @graffiticode/l0181-view — L0181's flashcard Form, plus the shared View it is injected into
// (re-exported from the parent language's view package).
export { Form, Deck } from "./components/form";
export type { Card, Study } from "./components/form";
export { STACKS, advance, counts, filterOrder, inStack, positionIn, shuffled } from "./lib/marks";
export type { Mark, Marks, Stack, StackDef } from "./lib/marks";
export { CardText, isImageUrl, segments, textSize } from "./lib/text";

export { View } from "@graffiticode/l0000-view";
export type { FormProps, FormComponent, CompileError } from "@graffiticode/l0000-view";
