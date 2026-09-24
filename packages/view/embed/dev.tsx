// SPDX-License-Identifier: MIT
/**
 * Dev-only fixture page: webs rendered against fixed models, with no API behind them.
 *
 * `index.html` mounts the shared View, which wants a task `id` and an API — fine for the deployed
 * /form, useless for looking at the component. Placements here are kept in local state through
 * the same `reduce` the embed uses, and the View's Check button is stood in for by its CheckBar.
 * Vite builds only `index.html`, so this is not in the bundle.
 *
 * Run: npm run -w packages/view dev, then open /dev.html
 */
import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CheckBar, Form, reduce, score } from "../src";
import "../src/index.css";

const cell = {
  title: "Parts of a cell",
  instructions: "Drag each part onto an empty node, then label the dashed line.",
  interaction: {
    type: "concept-web",
    hub: { id: "hub", text: "The Cell" },
    nodes: [
      { id: "r", blank: true },
      { id: "n2", text: "Nucleus" },
      { id: "n3", blank: true },
      { id: "n4", blank: true },
      { id: "n5", text: "https://flagcdn.com/w320/jp.png" },
    ],
    edges: [
      { id: "e1", from: "hub", to: "r", style: "solid" },
      { id: "e2", from: "hub", to: "n3", style: "solid" },
      { id: "e3", from: "hub", to: "n4", style: "solid" },
      { id: "e4", from: "hub", to: "n5", style: "dashed", label: "a flag" },
      { id: "e5", from: "r", to: "n2", style: "dashed-arrow", blank: true },
      { id: "e6", from: "hub", to: "n2", style: "solid-arrow", label: "contains $x^2$" },
    ],
    trays: {
      nodes: {
        items: ["Receptor", "Mitochondria", "Ribosome", "Golgi"].map((text, i) => ({ id: `c${i + 1}`, text })),
        align: "right",
      },
      edges: { items: [{ id: "r1", text: "signals" }, { id: "r2", text: "inhibits" }], align: "bottom" },
    },
    cells: { r: {}, n3: {}, n4: {}, e5: {} },
  },
  validation: {
    points: 4,
    cells: {
      r: { assess: { expected: "Receptor", points: 1 }, pool: "p1" },
      n3: { assess: { expected: "Mitochondria", points: 1 }, pool: "p2" },
      n4: { assess: { expected: "Ribosome", points: 1 }, pool: "p2" },
      e5: { assess: { expected: "signals", points: 1 }, pool: "p3" },
    },
  },
};

const crowded = {
  theme: "dark",
  title: "Twelve around one",
  interaction: {
    type: "concept-web",
    hub: { id: "hub", text: "Months", shape: "circle", color: "indigo" },
    nodes: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map(
      (text, i) => ({ id: `n${i + 1}`, text, shape: "pill", color: ["blue", "teal", "green", "amber"][i % 4] }),
    ),
    edges: Array.from({ length: 12 }, (_, i) => ({ id: `e${i + 1}`, from: "hub", to: `n${i + 1}`, style: "solid" })),
    trays: {},
    cells: {},
  },
  validation: { points: 0, cells: {} },
};

const errors = [{ message: 'edge 1: `to "C"` names no node. The nodes are: hub ("A"), n1 ("B").' }];

function Fixture({ label, initial, errs = [] }: { label: string; initial: any; errs?: any[] }) {
  const [data, setData] = useState(initial);
  const [checked, setChecked] = useState(false);
  const apply = (action: any) => {
    setChecked(false);
    setData((d: any) => reduce(d, action) ?? { ...d, ...action.args });
  };
  const result = useMemo(() => score(data), [data]);
  const shown = checked ? { ...data, showValidationUI: true } : data;
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ fontFamily: "sans-serif", fontSize: 13, color: "#666" }}>{label}</h2>
      <Form state={{ data: shown, errors: errs, apply }} />
      {result && <CheckBar result={result} checked={checked} onCheck={() => setChecked(true)} />}
    </section>
  );
}

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <Fixture label="Blank nodes, a blank label, an image node" initial={cell} />
      <Fixture label="The same, with instant-feedback true" initial={{ ...cell, feedback: "instant" }} />
      <Fixture label="Crowded ring, dark, styled" initial={crowded} />
      <Fixture label="Compile error" initial={{}} errs={errors} />
    </React.StrictMode>,
  );
}
