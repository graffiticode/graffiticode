// SPDX-License-Identifier: MIT
// The embeddable /form bundle for L0182: mounts the shared View (inherited from
// @graffiticode/l0000-view) with L0182's renderer. Also serves as the dev harness.
//
// No `reduce` is passed. L0182 has no actions of its own — nothing in the view writes to the
// model — so the shared reducer's generic handling is all there is to do.
import React from "react";
import { createRoot } from "react-dom/client";
import { View, Survey } from "../src";
import "../src/index.css";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <View Form={Survey} />
    </React.StrictMode>,
  );
}
