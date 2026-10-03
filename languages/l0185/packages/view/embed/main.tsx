// SPDX-License-Identifier: MIT
// The embeddable /form bundle for L0185: mounts the shared View (inherited from
// @graffiticode/l0000-view) with L0185's Form. Data is not scored, so there is no `reduce`
// or `score`: the Form renders the transformed data, live.
import React from "react";
import { createRoot } from "react-dom/client";
import { View, Form } from "../src";
import "../src/index.css";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <View Form={Form} />
    </React.StrictMode>,
  );
}
