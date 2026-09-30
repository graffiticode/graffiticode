// SPDX-License-Identifier: MIT
/**
 * Dev-only fixture page: every program in the spec, compiled by the real compiler
 * (`packages/core/tools/fixtures.ts` writes fixtures.json), rendered through the real Form with
 * no API behind it. Vite builds only index.html, so this is not in the bundle.
 *
 * Run: npm run -w packages/view dev, then open /dev.html
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { Charts } from "../src";
import "../src/index.css";
import fixtures from "./fixtures.json";

const Page = () => (
  <div style={{ display: "grid", gap: 24, padding: 16, maxWidth: 960 }}>
    {(fixtures as any[]).map((f, i) => (
      <figure key={i} style={{ margin: 0, border: "1px solid #e5e7eb", borderRadius: 8 }}>
        <figcaption style={{ font: "12px ui-monospace, monospace", padding: 8, color: "#6b7280" }}>
          #{i + 1} — {f.from}
        </figcaption>
        <Charts data={f.data} />
      </figure>
    ))}
  </div>
);

const el = document.getElementById("root");
if (el) createRoot(el).render(<React.StrictMode><Page /></React.StrictMode>);
