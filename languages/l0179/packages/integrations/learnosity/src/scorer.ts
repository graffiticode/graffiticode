// SPDX-License-Identifier: MIT
/**
 * The scoring half of L0179's Learnosity custom question type.
 *
 * A separate entry from question.ts because Learnosity also runs this bundle server-side.
 *
 * It is free of the SPREADSHEET, and the import path below is what guarantees that. It is not yet
 * free of React: `createScorer` is imported from the `@graffiticode/learnosity-cqt` root barrel,
 * which re-exports `createQuestion`, which imports `react-dom/client` — and that package declares
 * no `sideEffects`, so nothing can drop it. `react-dom.production.min` is roughly half this
 * bundle. Fixing it needs a scorer subpath from that shared package; it does not stop the scorer
 * loading server-side, which is verified in bare Node.
 *
 * Scoring is published on its own subpath, `@graffiticode/l0179-view/scoring`, which pulls in no
 * React and no ProseMirror. Importing from the package ROOT instead does not work, and that is
 * not a style preference: the root entry is a single pre-bundled file whose ProseMirror
 * initialisation is not provably pure, so tree-shaking leaves React, the grid, and dozens of
 * `document` references in this bundle. Learnosity runs the scorer SERVER-side, where there is
 * no `document` — which is exactly why L0166's own deployed scorer cannot load in bare Node.
 *
 * This is the fix L0166 tracked as docs/scoring-subpath.md and never landed. L0179 owns its
 * renderer and its scoring now, so it simply lands here.
 */
import { createScorer } from "@graffiticode/learnosity-cqt";
import { scoreCells } from "@graffiticode/l0179-view/scoring";

import { defaultData } from "./defaults.js";

const Scorer = createScorer({ scoreCells, defaultData });

declare const LearnosityAmd: { define: (deps: string[], fn: () => unknown) => void };

LearnosityAmd.define([], function () {
  return { Scorer };
});
