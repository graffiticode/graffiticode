// SPDX-License-Identifier: MIT
// Stylesheets imported for their side effect, and the shared runtime, which ships no types.
declare module "@graffiticode/l0183-view/style.css";
declare module "@graffiticode/learnosity-cqt/styles.css";
declare module "@graffiticode/learnosity-cqt" {
  export const createQuestion: (bindings: any) => any;
  export const createScorer: (bindings: any) => any;
}
