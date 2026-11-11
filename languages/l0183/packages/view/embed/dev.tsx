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

const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${i + 1}`);
const COLORS = ["blue", "teal", "green", "amber", "purple", "pink"];

function seeded(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/** A plain web: n nodes, spokes for the first `spokes`, a tree beyond, and cross-links. */
function bigWeb(n: number, seed: number, title: string) {
  const rand = seeded(seed);
  const edges: any[] = [];
  ids(n).forEach((id, i) => {
    const from = i < 8 ? "hub" : `n${1 + Math.floor(rand() * i)}`;
    edges.push({ id: `t${i}`, from, to: id, style: "solid-arrow", ...(rand() < 0.3 ? { label: ["has", "causes", "is part of", "feeds"][i % 4] } : {}) });
  });
  for (let k = 0; k < Math.floor(n / 4); k++) {
    const a = 1 + Math.floor(rand() * n);
    const b = 1 + Math.floor(rand() * n);
    if (a !== b) edges.push({ id: `x${k}`, from: `n${a}`, to: `n${b}`, style: "dashed" });
  }
  return {
    title,
    interaction: {
      type: "concept-web",
      hub: { id: "hub", text: "Ecosystem" },
      nodes: ids(n).map((id, i) => ({ id, text: `Concept ${i + 1}`, color: COLORS[i % COLORS.length] })),
      edges,
      trays: {},
      cells: {},
    },
    validation: { points: 0, cells: {} },
  };
}

const sparse = {
  title: "Four around one",
  interaction: {
    type: "concept-web",
    hub: { id: "hub", text: "Water" },
    nodes: ["Rain", "River", "Ocean", "Cloud"].map((text, i) => ({ id: `n${i + 1}`, text })),
    edges: ids(4).map((id, i) => ({ id: `e${i}`, from: "hub", to: id, style: "solid" })),
    trays: {},
    cells: {},
  },
  validation: { points: 0, cells: {} },
};

const chords = {
  title: "Opposite nodes linked",
  interaction: {
    ...sparse.interaction,
    edges: [
      ...sparse.interaction.edges,
      { id: "c1", from: "n1", to: "n3", style: "dashed-arrow", label: "flows to" },
      { id: "c2", from: "n2", to: "n4", style: "dashed-arrow", label: "evaporates" },
    ],
  },
  validation: { points: 0, cells: {} },
};

const longLabels = {
  title: "Twelve with long labels",
  interaction: {
    type: "concept-web",
    hub: { id: "hub", text: "Photosynthesis" },
    nodes: ids(12).map((id, i) => ({ id, text: `Stage ${i + 1}` })),
    edges: ids(12).map((id, i) => ({
      id: `e${i}`,
      from: "hub",
      to: id,
      style: "solid-arrow",
      label: "converts light energy into chemical energy stored as glucose".slice(0, 12 + i * 4),
    })),
    trays: {},
    cells: {},
  },
  validation: { points: 0, cells: {} },
};

const candidates = {
  title: "Line-label candidates of every kind",
  interaction: {
    type: "concept-web",
    hub: { id: "hub", text: "Energy" },
    nodes: ["Sun", "Plant", "Animal"].map((text, i) => ({ id: `n${i + 1}`, text })),
    edges: [
      { id: "e1", from: "hub", to: "n1", style: "solid-arrow", blank: true },
      { id: "e2", from: "hub", to: "n2", style: "solid-arrow", blank: true },
      { id: "e3", from: "n2", to: "n3", style: "solid-arrow", blank: true },
    ],
    trays: {
      edges: {
        items: [
          "$E = mc^2 + \\frac{1}{2}mv^2 + \\int_0^\\infty e^{-x} dx$",
          "https://flagcdn.com/w320/jp.png",
          "Pneumonoultramicroscopicsilicovolcanoconiosis",
          "feeds",
        ].map((text, i) => ({ id: `r${i}`, text })),
        align: "bottom",
      },
    },
    cells: { e1: {}, e2: {}, e3: {} },
  },
  validation: {
    points: 3,
    cells: {
      e1: { assess: { expected: "feeds", points: 1 }, pool: "p1" },
      e2: { assess: { expected: "feeds", points: 1 }, pool: "p1" },
      e3: { assess: { expected: "feeds", points: 1 }, pool: "p2" },
    },
  },
};

const chain = {
  title: "A twenty-link chain",
  interaction: {
    type: "concept-web",
    hub: { id: "hub", text: "Start" },
    nodes: ids(20).map((id, i) => ({ id, text: `Step ${i + 1}` })),
    edges: ids(20).map((id, i) => ({ id: `e${i}`, from: i === 0 ? "hub" : `n${i}`, to: id, style: "solid-arrow" })),
    trays: {},
    cells: {},
  },
  validation: { points: 0, cells: {} },
};

/** 40 blank nodes, half the spokes blank too, distractors in both trays. */
function assessed(n: number) {
  const answers = ids(n).map((_, i) => `Answer ${i + 1}`);
  const labels = ids(n / 2).map((_, i) => `rel ${i + 1}`);
  const cells: Record<string, object> = {};
  const vcells: Record<string, object> = {};
  ids(n).forEach((id, i) => {
    cells[id] = {};
    vcells[id] = { assess: { expected: answers[i], points: 1 }, pool: `p${id}` };
  });
  ids(n / 2).forEach((_, i) => {
    cells[`e${i}`] = {};
    vcells[`e${i}`] = { assess: { expected: labels[i], points: 1 }, pool: `q${i}` };
  });
  return {
    title: `${n} blanks`,
    interaction: {
      type: "concept-web",
      hub: { id: "hub", text: "Biology" },
      nodes: ids(n).map((id) => ({ id, blank: true })),
      edges: ids(n).map((id, i) => ({ id: `e${i}`, from: "hub", to: id, style: "solid", ...(i < n / 2 ? { blank: true } : {}) })),
      trays: {
        nodes: { items: [...answers, "Decoy A", "Decoy B"].map((text, i) => ({ id: `c${i}`, text })), align: "bottom" },
        edges: { items: [...labels, "decoy"].map((text, i) => ({ id: `r${i}`, text })), align: "bottom" },
      },
      cells,
    },
    validation: { points: n + n / 2, cells: vcells },
  };
}

/** The rain-formation web from a learner-facing item: eight long-text nodes in a cycle, every edge labelled. */
const rain = {
  title: "Rain formation",
  interaction: {
    type: "concept-web",
    hub: { id: "hub", text: "RAIN FORMATION", shape: "circle", size: "large", color: "blue" },
    nodes: [
      { id: "n1", text: "Sun heats surface water", color: "yellow" },
      { id: "n2", text: "Evaporation adds invisible water vapour", color: "blue" },
      { id: "n3", text: "Plants add vapour (transpiration)", color: "green" },
      { id: "n4", text: "Moist air rises and expands", color: "blue" },
      { id: "n5", text: "Rising air cools", color: "teal" },
      { id: "n6", text: "Vapour condenses on tiny particles into cloud droplets; very cold clouds can form ice crystals", color: "gray" },
      { id: "n7", text: "Cloud drops or ice crystals grow by collisions, coalescence, and ice processes", color: "gray" },
      { id: "n8", text: "Large drops overcome upward air motion and fall as rain; water collects, flows, or soaks in", color: "blue" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", style: "solid-arrow", label: "solar heat causes" },
      { id: "e2", from: "n8", to: "n2", style: "solid-arrow", label: "water can evaporate again" },
      { id: "e3", from: "n2", to: "n4", style: "solid-arrow", label: "makes air moist" },
      { id: "e4", from: "n3", to: "n4", style: "solid-arrow", label: "adds moisture" },
      { id: "e5", from: "n4", to: "n5", style: "solid-arrow", label: "higher air is cooler" },
      { id: "e6", from: "n5", to: "n6", style: "solid-arrow", label: "cooling causes condensation" },
      { id: "e7", from: "n6", to: "n7", style: "solid-arrow", label: "particles combine and grow" },
      { id: "e8", from: "n7", to: "n8", style: "solid-arrow", label: "large enough to fall" },
    ],
    trays: {},
    cells: {},
  },
  validation: { points: 0, cells: {} },
};

const FIXTURES: Record<string, any> = {
  rain,
  cell,
  crowded,
  sparse,
  chords,
  longLabels,
  candidates,
  chain,
  web40: bigWeb(40, 7, "Forty concepts"),
  web100: bigWeb(100, 11, "A hundred concepts"),
  assessed40: assessed(40),
};

const errors = [{ message: 'edge 1: `to "C"` names no node. The nodes are: hub ("A"), n1 ("B").' }];

function Fixture({ label, initial, errs = [], bare = false }: { label: string; initial: any; errs?: any[]; bare?: boolean }) {
  const [data, setData] = useState(initial);
  const [checked, setChecked] = useState(false);
  const apply = (action: any) => {
    setChecked(false);
    setData((d: any) => reduce(d, action) ?? { ...d, ...action.args });
  };
  const result = useMemo(() => score(data), [data]);
  const shown = checked ? { ...data, showValidationUI: true } : data;
  const form = (
    <>
      <Form state={{ data: shown, errors: errs, apply }} />
      {result && <CheckBar result={result} checked={checked} onToggle={() => setChecked((c) => !c)} />}
    </>
  );
  if (bare) return form;
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ fontFamily: "sans-serif", fontSize: 13, color: "#666" }}>{label}</h2>
      {form}
    </section>
  );
}

const params = new URLSearchParams(location.search);
const only = params.get("fixture");
const el = document.getElementById("root");
if (el && only && FIXTURES[only]) {
  // One fixture under the /form embed's viewport contract (see index.html), or as a Learnosity
  // question (which cqt marks with `questionState`).
  // Learnosity renders a question in its page's flow; the /form embed fills the viewport.
  const learnosity = params.get("host") === "learnosity";
  if (!learnosity) {
    Object.assign(el.style, { height: "100dvh", display: "flex", flexDirection: "column" });
    el.setAttribute("data-l0183-viewport", "");
  }
  Object.assign(document.body.style, { margin: "0" });
  const initial = learnosity ? { ...FIXTURES[only], questionState: "initial" } : FIXTURES[only];
  createRoot(el).render(
    <React.StrictMode>
      <Fixture label={only} initial={initial} bare />
    </React.StrictMode>,
  );
} else if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <Fixture label="Blank nodes, a blank label, an image node" initial={cell} />
      <Fixture label="The same, with instant-feedback true" initial={{ ...cell, feedback: "instant" }} />
      <Fixture label="Crowded ring, dark, styled" initial={crowded} />
      {Object.entries(FIXTURES)
        .filter(([name]) => name !== "cell" && name !== "crowded")
        .map(([name, f]) => (
          <Fixture key={name} label={`${name} (open alone: ?fixture=${name})`} initial={f} />
        ))}
      <Fixture label="Compile error" initial={{}} errs={errors} />
    </React.StrictMode>,
  );
}
