// SPDX-License-Identifier: MIT
// The embeddable /form bundle for L0183: mounts the shared View (inherited from
// @graffiticode/l0000-view) with L0183's Form and its `reduce`, which folds a placement into
// `interaction.cells` so the recompile carries it back.
import React from "react";
import { createRoot } from "react-dom/client";
import { View, Form, reduce } from "../src";
import "../src/index.css";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <View Form={Form} reduce={reduce} />
    </React.StrictMode>,
  );
}
