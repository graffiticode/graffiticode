// SPDX-License-Identifier: MIT
// The embeddable /form bundle for L0186: mounts the shared View (inherited from
// @graffiticode/l0000-view) with L0186's Form. Boards are not scored, so there is no `reduce`
// or `score`: the Form draws the compiled board, live.
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
