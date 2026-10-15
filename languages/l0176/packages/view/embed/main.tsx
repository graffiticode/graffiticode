// SPDX-License-Identifier: MIT
// The embeddable /form bundle for L0176: mounts the shared View (inherited from
// @graffiticode/l0000-view) with L0176's Form. Also serves as the dev harness.
// The View's data load carries the compile generation of the `?url=` the api's
// /form redirect passes, when it has one (see src/generation.ts).
import React from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { View, Form } from "../src";
import { generationMiddleware } from "../src/generation";
import "../src/index.css";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <SWRConfig value={{ use: [generationMiddleware(window.location.search)] }}>
        <View Form={Form} />
      </SWRConfig>
    </React.StrictMode>,
  );
}
