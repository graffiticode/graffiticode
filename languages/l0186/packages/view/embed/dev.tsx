// SPDX-License-Identifier: MIT
/**
 * Dev-only fixture page: every program in the spec, compiled by the real compiler
 * (`packages/core/tools/fixtures.ts` writes fixtures.json, which is generated and gitignored, so it
 * is fetched at runtime rather than imported — the build must not depend on it), rendered through
 * the real Form with no API behind it. Vite builds only index.html, so this is not in the bundle.
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
  if (!fixtures.length) return <p style={{ padding: 16 }}>No fixtures — run npx tsx tools/fixtures.ts in packages/core.</p>;
  return (
  <div style={{ display: "grid", gap: 24, padding: 16, maxWidth: 960 }}>
    {fixtures.map((f, i) => (
      <figure key={i} style={{ margin: 0, border: "1px solid #e5e7eb", borderRadius: 8 }}>
        <figcaption style={{ font: "12px ui-monospace, monospace", padding: 8, color: "#6b7280" }}>
          #{i + 1} — {f.from}
        </figcaption>
        <Board data={f.data} />
      </figure>
    ))}
  </div>
  );
};

const el = document.getElementById("root");
if (el) createRoot(el).render(<React.StrictMode><Page /></React.StrictMode>);
