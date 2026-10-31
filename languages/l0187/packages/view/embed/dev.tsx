// SPDX-License-Identifier: MIT
/**
 * Dev-only fixture page: every documented and tested L0187 program, compiled by the Rust
 * compiler (`cargo run --example fixtures` writes fixtures.json, generated and gitignored, so it
 * is fetched at runtime rather than imported), rendered through the real Board with no API behind
 * it. Vite builds only index.html, so this is not in the bundle.
 *
 * Run: npm run -w packages/view dev, then open /dev.html
 */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Board } from "../src";
import "../src/index.css";

const Page = () => {
  const [fixtures, setFixtures] = useState<any[] | null>(null);
  useEffect(() => {
    fetch("./fixtures.json")
      .then((r) => r.json())
      .then(setFixtures)
      .catch(() => setFixtures([]));
  }, []);
  if (!fixtures) return <p style={{ padding: 16 }}>Loading fixtures…</p>;
  if (!fixtures.length) return <p style={{ padding: 16 }}>No fixtures — run cargo run --example fixtures.</p>;
  return (
    <div style={{ display: "grid", gap: 24, padding: 16, maxWidth: 960 }}>
      {fixtures.map((f, i) => (
        <figure key={i} style={{ margin: 0, border: "1px solid #e5e7eb", borderRadius: 8 }}>
          <figcaption style={{ font: "12px ui-monospace, monospace", padding: 8, color: "#6b7280" }}>{f.name}</figcaption>
          <Board data={f.data} />
        </figure>
      ))}
    </div>
  );
};

const el = document.getElementById("root");
if (el) createRoot(el).render(<React.StrictMode><Page /></React.StrictMode>);
