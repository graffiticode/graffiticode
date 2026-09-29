// SPDX-License-Identifier: MIT
// @graffiticode/l0180-view — L0180's Form and scorer, plus the shared View it is injected
// into (re-exported from the parent language's view package).
export { Form, ItemView, ActivityView, InteractionView, ChoiceItem, knownInteractions } from "./components/form";
export {
  scoreInteraction,
  scoreChoice,
  scoreItem,
  scoreHuman,
  scoreTextEntry,
  scoreInlineChoice,
  scoreOrder,
  scorePairs,
  canonicalize,
  selectedIds,
  correctIds,
} from "./scoring";
export type {
  Score,
  Validation,
  ItemValidation,
  ScoringMode,
  ResponseProcessing,
  BaseType,
  OptionValidation,
  OptionOutcome,
} from "./scoring";
export { View } from "@graffiticode/l0000-view";
export type { FormProps, FormComponent, CompileError } from "@graffiticode/l0000-view";
