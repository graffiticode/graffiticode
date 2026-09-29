// SPDX-License-Identifier: MIT
/**
 * The browser half of L0179's Learnosity custom question type.
 *
 * The lifecycle lives in @graffiticode/learnosity-cqt, shared with every other Graffiticode
 * language that ships one. Only the bindings below are L0179's.
 */
import { createQuestion } from "@graffiticode/learnosity-cqt";
import { Form, scoreCells, getCellsValidation } from "@graffiticode/l0179-view";

// The language's own stylesheet. L0179 has no dependency on L0166 here: view/src/index.css
// currently @imports L0166's stylesheet, but that is the view package's business, and the day
// the renderer is ported this import does not change.
import "@graffiticode/l0179-view/style.css";
import "@graffiticode/learnosity-cqt/styles.css";

import { defaultData } from "./defaults.js";

const Question = createQuestion({
  Form,
  scoreCells,
  getCellsValidation,
  defaultData,
});

declare const LearnosityAmd: { define: (deps: string[], fn: () => unknown) => void };

LearnosityAmd.define([], function () {
  return { Question };
});
