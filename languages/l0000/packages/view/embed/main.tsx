// SPDX-License-Identifier: MIT
// The embeddable /form bundle for L0000: mounts the shared View with L0000's base Form.
// This entry also serves as the dev harness (`npm run dev`).
import React from "react";
import { createRoot } from "react-dom/client";
import { View, Form } from "../src/index";
import "../src/index.css";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <View Form={Form} />
    </React.StrictMode>,
  );
}
