// SPDX-License-Identifier: MIT
export {
  scoreInteraction,
  scoreChoice,
  scoreItem,
  scoreActivity,
  scoreHuman,
  scoreTextEntry,
  scoreInlineChoice,
  scoreOrder,
  scorePairs,
  canonicalize,
  selectedIds,
  correctIds,
} from "./score.js";
export type {
  Score,
  Validation,
  ItemValidation,
  ActivityItem,
  ScoringMode,
  ResponseProcessing,
  BaseType,
  OptionValidation,
  OptionOutcome,
} from "./score.js";
