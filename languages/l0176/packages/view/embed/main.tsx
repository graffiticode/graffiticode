// SPDX-License-Identifier: MIT
// The embeddable /form bundle for L0176: mounts the shared View (inherited from
// @graffiticode/l0000-view) with L0176's Form. Also serves as the dev harness.
// The View's data load carries the compile generation of the `?url=` the api's
// /form redirect passes, when it has one (see src/generation.ts).
//
// `?source=parent` mounts ParentFed instead: the item is handed in by the
// embedding page (the MCP widget) rather than fetched by id, so a signed-in
// user's private item renders with no credential (parent-fed.tsx).
import React from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { View, Form } from "../src";
import { generationMiddleware } from "../src/generation";
import { ParentFed } from "../src/components/form/parent-fed";
import "../src/index.css";

const parentFed = new URLSearchParams(window.location.search).get("source") === "parent";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      {parentFed ? (
        <ParentFed Form={Form} />
      ) : (
        <SWRConfig value={{ use: [generationMiddleware(window.location.search)] }}>
          <View Form={Form} />
        </SWRConfig>
      )}
    </React.StrictMode>,
  );
}
