// SPDX-License-Identifier: MIT
/**
 * The scoring half of L0183's Learnosity custom question type.
 *
 * A separate entry from question.ts because Learnosity also runs this bundle SERVER-side, where
 * there is no `document`. Scoring is imported from `@graffiticode/l0183-view/scoring`, which is
 * React-free and DOM-free; importing from the package root would drag the renderer in.
 *
 * `createScorer` still comes from cqt's root barrel, which re-exports `createQuestion` and so
 * carries react-dom — the same known cost L0179 documents. It does not stop the scorer loading
 * in bare Node, which is what matters.
 */
import { createScorer } from "@graffiticode/learnosity-cqt";
import { scoreCells } from "@graffiticode/l0183-view/scoring";

import { defaultData } from "./defaults.js";

const Scorer = createScorer({ scoreCells, defaultData });

declare const LearnosityAmd: { define: (deps: string[], fn: () => unknown) => void };

LearnosityAmd.define([], function () {
  return { Scorer };
});
