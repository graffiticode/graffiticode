// SPDX-License-Identifier: MIT
// The embeddable /form bundle for L0179: mounts the shared View (inherited from
// @graffiticode/l0000-view) with L0179's Form and its spreadsheet reducer cases. Also serves
// as the dev harness.
//
// `formModel="loaded"` because L0166's spreadsheet Form is UNCONTROLLED: its TableEditor seeds
// a ProseMirror document from `interaction.cells` and rebuilds the whole thing — caret back to
// A1 — whenever that object's identity changes. Handing it back the edit it just reported
// re-seeds it on every cell commit, which is the visible flash. The live model still carries
// every edit to the host and the compiler; only what the Form RENDERS from is held to the last
// external load. L0166 gets this for free by keeping state outside React; see view.tsx.
import React from "react";
import { createRoot } from "react-dom/client";
import { View, Form, reduce, score } from "../src";
import "../src/index.css";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <View Form={Form} reduce={reduce} formModel="loaded" score={score} />
    </React.StrictMode>,
  );
}
