// SPDX-License-Identifier: MIT
// The embeddable /form bundle for L0014: mounts the shared View (inherited from
// @graffiticode/l0000-view) with L0014's Form. Also serves as the dev harness.
//
// The default `formModel="live"` is right here: the Form only reports on a compile and never
// calls `apply`, so there is no edit of its own for the live model to hand back.
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
