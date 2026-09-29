// SPDX-License-Identifier: MIT
// @graffiticode/l0182-view — L0182's renderer, plus the shared View it is injected into
// (re-exported from the base language's view package).
//
// `Survey` is also exported as `Form`, which is the prop name the shared View takes. There is
// no form here: the record is written as code, and this only displays it.
export { Survey, Survey as Form } from "./components/survey";
export {
  answerText,
  boundsLabel,
  isRating,
  resolveChoices,
  resolveRatings,
  scaleEnds,
} from "./lib/survey";
export type {
  Compiled,
  Option,
  Point,
  RankedResponse,
  RankedSurvey,
  RatedItem,
  RatedRow,
  Rating,
  RatingResponse,
  RatingSurvey,
  Resolved,
  ResolvedRatings,
  Scale,
  Survey as SurveyModel,
} from "./lib/survey";
export { View } from "@graffiticode/l0000-view";
export type { FormProps, FormComponent, CompileError } from "@graffiticode/l0000-view";
