// SPDX-License-Identifier: MIT
/**
 * The browser half of L0183's Learnosity custom question type.
 *
 * The lifecycle lives in @graffiticode/learnosity-cqt, shared with every Graffiticode language
 * that ships one. Only the bindings below are L0183's.
 */
import { createQuestion } from "@graffiticode/learnosity-cqt";
import { Form, scoreCells, getCellsValidation } from "@graffiticode/l0183-view";

import "@graffiticode/l0183-view/style.css";
import "@graffiticode/learnosity-cqt/styles.css";

import { defaultData } from "./defaults.js";

const Question = createQuestion({
  Form,
  scoreCells,
  getCellsValidation,
  defaultData,
  // cqt's default label is `key: expected`, and a key here is a blank's id (`n3`), which means
  // nothing to a learner. The answer on its own is what "show answers" should list.
  suggestedAnswerLabel: (_key: string, cell: any) => String(cell?.assess?.expected ?? ""),
});

declare const LearnosityAmd: { define: (deps: string[], fn: () => unknown) => void };

LearnosityAmd.define([], function () {
  return { Question };
});
