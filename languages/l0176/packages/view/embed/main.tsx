// SPDX-License-Identifier: MIT
// The embeddable /form bundle for L0176: mounts the shared View (inherited from
// @graffiticode/l0000-view) with L0176's Form. Also serves as the dev harness.
// The shared View carries the compile generation of the `?url=` the api's /form
// redirect passes onto its data load itself (@graffiticode/l0000-view 0.5.0).
//
// `?source=parent` mounts ParentFed instead: the item is handed in by the
// embedding page (the MCP widget) rather than fetched by id, so a signed-in
// user's private item renders with no credential (parent-fed.tsx).
import React from "react";
import { createRoot } from "react-dom/client";
import { View, Form } from "../src";
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
        <View Form={Form} />
      )}
    </React.StrictMode>,
  );
}
