// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";
import { boxesOverlap, curveHitsBox, enterParam, exitParam, extremumT, pointAt } from "./geom";
import {
  ARROW_LEN,
  canvasAt,
  compressionFloor,
  expand,
  place,
  spacingFor,
  layout,
  PAD,
  solve,
  STROKE,
  type Geometry,
  type LayoutEdge,
  type LayoutModel,
} from "./layout";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${i + 1}`);
const hub = { id: "hub" };

function star(n: number, label?: { w: number; h: number }): LayoutModel {
  return {
    hub,
    nodes: ids(n).map((id) => ({ id })),
    edges: ids(n).map((id) => ({ id: `e-${id}`, from: "hub", to: id, label })),
  };
}

/** A seeded web: spokes for the first few, then cross-links, about a third labelled. */
function web(n: number, seed: number): LayoutModel {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const edges: LayoutEdge[] = [];
  ids(n).forEach((id, i) => {
    const from = i < 6 ? "hub" : `n${1 + Math.floor(rand() * i)}`;
    edges.push({ id: `t${i}`, from, to: id, label: rand() < 0.33 ? { w: 70, h: 22 } : undefined });
  });
  for (let k = 0; k < Math.floor(n / 2); k++) {
    const a = 1 + Math.floor(rand() * n);
    const b = 1 + Math.floor(rand() * n);
    if (a !== b) edges.push({ id: `x${k}`, from: `n${a}`, to: `n${b}`, label: rand() < 0.33 ? { w: 70, h: 22 } : undefined });
  }
  return { hub, nodes: ids(n).map((id) => ({ id })), edges };
}

const FRAMES = [
  { width: 0, height: 0 },
  { width: 1280, height: 800 },
  { width: 800, height: 1280 },
  { width: 2560, height: 1440 },
  { width: 3440, height: 1000 },
  { width: 5120, height: 1440 },
];

/** Every collision in a placed geometry, excluding those stage 1 reported as residuals. */
function collisions(g: Geometry): string[] {
  const out: string[] = [];
  const byId = new Map(g.boxes.map((b) => [b.id, b]));
  for (let i = 0; i < g.boxes.length; i++)
    for (let j = i + 1; j < g.boxes.length; j++)
      if (boxesOverlap(g.boxes[i], g.boxes[j])) out.push(`nodes ${g.boxes[i].id} ${g.boxes[j].id}`);
  const residualEdges = new Set(g.residuals.filter((r) => r.kind === "edge-node").map((r) => `${r.ids[0]}|${r.ids[1]}`));
  for (const e of g.edges) {
    const a = g.boxes.find((b) => pointAt(e.full, 0).x === b.x && pointAt(e.full, 0).y === b.y)!;
    const b = g.boxes.find((x) => pointAt(e.full, 1).x === x.x && pointAt(e.full, 1).y === x.y)!;
    if (residualEdges.has(`${a.id}|${b.id}`)) continue;
    const t0 = exitParam(e.full, a);
    const t1 = enterParam(e.full, b);
    for (const box of g.boxes) {
      if (box === a || box === b) continue;
      if (curveHitsBox(e.full, t0, t1, box, 0)) out.push(`edge ${e.id} through ${box.id}`);
    }
  }
  const labels = g.labels.filter((l) => !l.residual);
  for (const l of labels) for (const b of byId.values()) if (boxesOverlap(l, b)) out.push(`label ${l.id} on ${b.id}`);
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++)
      if (boxesOverlap(labels[i], labels[j])) out.push(`labels ${labels[i].id} ${labels[j].id}`);
  return out;
}

/** Every drawn thing inside the padded canvas, stroke and arrowheads included. */
function outside(g: Geometry): string[] {
  const out: string[] = [];
  const inX = (x: number, e: number) => x - e >= PAD - 1e-6 && x + e <= g.width - PAD + 1e-6;
  const inY = (y: number, e: number) => y - e >= PAD - 1e-6 && y + e <= g.height - PAD + 1e-6;
  for (const b of [...g.boxes, ...g.labels]) if (!inX(b.x, b.w / 2) || !inY(b.y, b.h / 2)) out.push(b.id);
  const reach = STROKE / 2 + ARROW_LEN;
  for (const e of g.edges) {
    for (let i = 0; i <= 64; i++) {
      const p = pointAt(e.path, i / 64);
      if (!inX(p.x, reach) || !inY(p.y, reach)) {
        out.push(`edge ${e.id}`);
        break;
      }
    }
  }
  return out;
}

const centre = (g: Geometry) => g.boxes[0];

describe("minimum layout", () => {
  test("puts the hub in the centre and the first node at the top", () => {
    const g = layout(star(4));
    expect([centre(g).x, centre(g).y]).toEqual([g.width / 2, g.height / 2]);
    expect(g.boxes[1].x).toBeCloseTo(g.width / 2);
    expect(g.boxes[1].y).toBeLessThan(centre(g).y);
  });

  test("node sizes do not depend on how many nodes there are", () => {
    const three = layout(star(3)).boxes[1];
    const forty = layout(star(40)).boxes[1];
    expect([forty.w, forty.h]).toEqual([three.w, three.h]);
  });

  test("a circle is as tall as it is wide", () => {
    const g = layout({ ...star(3), hub: { id: "hub", shape: "circle" } });
    expect(centre(g).h).toBe(centre(g).w);
  });

  test("nothing overlaps and everything is inside, from 1 node to 100", () => {
    for (const n of [1, 2, 3, 5, 8, 12, 20, 40, 100]) {
      const g = layout(star(n));
      expect(collisions(g), `${n} nodes`).toEqual([]);
      expect(outside(g), `${n} nodes`).toEqual([]);
      expect(g.residuals, `${n} nodes`).toEqual([]);
    }
  });

  test("rectangles at 3 and 9 o'clock on neighbouring rings do not touch", () => {
    const g = layout({ hub, nodes: ids(30).map((id) => ({ id, size: "large", shape: "rect" })), edges: [] });
    expect(collisions(g)).toEqual([]);
  });

  test("labels on every spoke fit, clear of the nodes and of each other", () => {
    for (const n of [2, 4, 8, 12]) {
      const g = layout(star(n, { w: 140, h: 40 }));
      expect(g.residuals, `${n} nodes`).toEqual([]);
      expect(collisions(g), `${n} nodes`).toEqual([]);
    }
  });

  test("longer labels need more room", () => {
    expect(solve(star(8, { w: 160, h: 40 })).min.width).toBeGreaterThan(solve(star(8, { w: 40, h: 20 })).min.width);
  });

  test("an edge between opposite nodes curves clear of the hub", () => {
    const model: LayoutModel = {
      hub,
      nodes: ids(4).map((id) => ({ id })),
      edges: [
        { id: "a", from: "n1", to: "n3", label: { w: 60, h: 22 } },
        { id: "b", from: "n2", to: "n4", label: { w: 60, h: 22 } },
      ],
    };
    const g = layout(model);
    expect(g.residuals).toEqual([]);
    expect(collisions(g)).toEqual([]);
    expect(outside(g)).toEqual([]);
    // Both bent: neither control point is on its chord.
    for (const e of g.edges) expect(extremumT(e.full, "x") ?? extremumT(e.full, "y")).toBeDefined();
  });

  test("a vertical two-node web routed round an obstacle stays inside the canvas", () => {
    // n1 above, n2 below; the edge n1→n2 must bend around the hub, wider than the hub itself.
    const model: LayoutModel = { hub, nodes: [{ id: "n1" }, { id: "n2" }], edges: [{ id: "e", from: "n1", to: "n2" }] };
    for (const frame of FRAMES) {
      const g = layout(model, frame);
      expect(outside(g), JSON.stringify(frame)).toEqual([]);
      expect(collisions(g), JSON.stringify(frame)).toEqual([]);
    }
  });
});

describe("expansion", () => {
  const models = { star12: star(12, { w: 90, h: 24 }), web40: web(40, 7), web20: web(20, 3) };

  test("spreads farther apart in a larger frame, and never closer", () => {
    for (const [name, model] of Object.entries(models)) {
      const min = solve(model);
      const sweep = [400, 900, 1400, 2200, 3200, 5120].map((w) => expand(min, { width: w, height: w * 0.6 }));
      for (let k = 1; k < sweep.length; k++) {
        const a = sweep[k - 1].boxes;
        const b = sweep[k].boxes;
        for (let i = 0; i < a.length; i++)
          for (let j = i + 1; j < a.length; j++) {
            const da = Math.hypot(a[i].x - a[j].x, a[i].y - a[j].y);
            const db = Math.hypot(b[i].x - b[j].x, b[i].y - b[j].y);
            expect(db, name).toBeGreaterThanOrEqual(da - 1e-6);
          }
      }
      expect(sweep[sweep.length - 1].sx, name).toBeGreaterThan(sweep[2].sx);
    }
  });

  test("keeps every guarantee at every frame, with the same residuals", () => {
    for (const [name, model] of Object.entries(models)) {
      const min = solve(model);
      for (const frame of FRAMES) {
        const g = expand(min, frame);
        expect(collisions(g), `${name} ${JSON.stringify(frame)}`).toEqual([]);
        expect(outside(g), `${name} ${JSON.stringify(frame)}`).toEqual([]);
        expect(g.residuals).toEqual(min.residuals);
      }
    }
  });

  test("uses all the room the tighter axis allows, with the hub centred", () => {
    // How far each drawn thing reaches from the hub on one axis, stroke and arrowheads included.
    const reach = (g: Geometry, axis: "x" | "y") => {
      const c = axis === "x" ? g.width / 2 : g.height / 2;
      const half = (b: { w: number; h: number }) => (axis === "x" ? b.w : b.h) / 2;
      const boxes = [...g.boxes, ...g.labels].map((b) => Math.abs(b[axis] - c) + half(b));
      const curves = g.edges.flatMap((e) =>
        (["x", "y"] as const).map((ax) => {
          const t = extremumT(e.full, ax);
          return t === undefined ? 0 : Math.abs(pointAt(e.full, t)[axis] - c) + STROKE / 2 + ARROW_LEN;
        }),
      );
      return Math.max(0, ...boxes, ...curves);
    };
    for (const model of Object.values(models)) {
      const min = solve(model);
      for (const frame of FRAMES.slice(1)) {
        const g = expand(min, frame);
        expect(centre(g).x).toBeCloseTo(g.width / 2);
        expect(centre(g).y).toBeCloseTo(g.height / 2);
        if (g.sx > 1) {
          // The binding object is exactly at the padded edge on one axis.
          const gapX = g.width / 2 - PAD - reach(g, "x");
          const gapY = g.height / 2 - PAD - reach(g, "y");
          expect(Math.min(gapX, gapY)).toBeCloseTo(0, 3);
          expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(-1e-6);
        }
      }
    }
  });

  test("rings stay circles in wide and tall frames", () => {
    const min = solve(star(12));
    for (const frame of FRAMES) {
      const g = expand(min, frame);
      expect(g.sx).toBe(g.sy);
      const radii = g.boxes.slice(1).map((b) => Math.hypot(b.x - g.width / 2, b.y - g.height / 2));
      for (const r of radii) expect(r).toBeCloseTo(radii[0], 6);
    }
  });

  test("a frame smaller than the minimum gives the minimum layout", () => {
    const min = solve(models.web20);
    const g = expand(min, { width: 100, height: 100 });
    expect([g.width, g.height, g.sx, g.sy]).toEqual([min.min.width, min.min.height, 1, 1]);
  });

  test("the minimum does not depend on the frame", () => {
    const a = solve(models.web40);
    const b = solve(models.web40);
    expect(a.min).toEqual(b.min);
    expect(expand(a, { width: 3000, height: 2000 }).min).toEqual(a.min);
  });

  test("label anchors stay on their curves", () => {
    const min = solve(models.star12);
    const g = expand(min, { width: 3000, height: 1200 });
    for (const l of g.labels) {
      const e = g.edges.find((x) => x.id === l.id)!;
      const t = min.labels.find((x) => x.id === l.id)!.t;
      const p = pointAt(e.full, t);
      expect(Math.hypot(p.x - l.x, p.y - l.y)).toBeLessThan(1e-6);
    }
  });

  test("a degenerate axis sets no limit, and gives no NaN", () => {
    const one: LayoutModel = { hub, nodes: [{ id: "n1" }], edges: [] };
    const two: LayoutModel = { hub, nodes: [{ id: "n1" }, { id: "n2" }], edges: [] };
    for (const model of [one, two]) {
      for (const frame of [{ width: 0, height: 0 }, ...FRAMES]) {
        const g = layout(model, frame);
        // Every node is on the vertical axis, so the height alone decides the stretch.
        expect(Number.isFinite(g.sx) && g.sx === g.sy).toBe(true);
        for (const b of g.boxes) expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
      }
      expect(layout(model, { width: 5120, height: 1440 }).sy).toBeGreaterThan(1);
    }
  });
});

describe("spacing (the view's rule: nodes fixed, spacing in [floor, best fit])", () => {
  const webs = { star12: star(12, { w: 90, h: 24 }), web20: web(20, 3), web40: web(40, 7), chords: star(4) };

  test("at the compression floor no two nodes touch, and any tighter some would", () => {
    for (const [name, model] of Object.entries(webs)) {
      const min = solve(model);
      const floor = compressionFloor(min);
      expect(floor, name).toBeGreaterThan(0);
      expect(floor, name).toBeLessThanOrEqual(1);
      const overlaps = (s: number) => {
        const b = place(min, s).boxes;
        for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) if (boxesOverlap(b[i], b[j])) return true;
        return false;
      };
      expect(overlaps(floor), name).toBe(false);
      if (floor < 1) expect(overlaps(floor * 0.9), name).toBe(true);
    }
  });

  test("the spacing never exceeds the best fit, however much room", () => {
    for (const model of Object.values(webs)) {
      const min = solve(model);
      expect(spacingFor(min, { width: 10000, height: 10000 })).toBe(1);
      expect(place(min, 1).width).toBe(min.min.width);
    }
  });

  test("with less room the spacing compresses to fit, down to the floor", () => {
    for (const [name, model] of Object.entries(webs)) {
      const min = solve(model);
      const floor = compressionFloor(min);
      for (const k of [0.95, 0.8, 0.6, 0.4, 0.2, 0.05]) {
        const room = { width: min.min.width * k, height: min.min.height * k };
        const s = spacingFor(min, room);
        expect(s, name).toBeGreaterThanOrEqual(floor - 1e-9);
        expect(s, name).toBeLessThanOrEqual(1);
        const c = canvasAt(min, s);
        // Above the floor the canvas fits the room; at the floor it is what scrolls.
        if (s > floor + 1e-9) {
          expect(c.width, name).toBeLessThanOrEqual(Math.ceil(room.width) + 1);
          expect(c.height, name).toBeLessThanOrEqual(Math.ceil(room.height) + 1);
        }
      }
    }
  });

  test("nodes keep their size at every spacing, and the hub stays centred", () => {
    const min = solve(webs.web20);
    for (const s of [compressionFloor(min), 0.7, 1]) {
      const g = place(min, s);
      g.boxes.forEach((b, i) => expect([b.w, b.h]).toEqual([min.boxes[i].w, min.boxes[i].h]));
      expect(g.boxes[0].x).toBeCloseTo(g.width / 2);
      expect(g.boxes[0].y).toBeCloseTo(g.height / 2);
      expect(outside(g)).toEqual([]);
    }
  });

  test("a one-node web has spacing 1 and no NaN", () => {
    const min = solve({ hub, nodes: [{ id: "n1" }], edges: [] });
    const s = spacingFor(min, { width: 50, height: 50 });
    expect(Number.isFinite(s)).toBe(true);
    for (const b of place(min, s).boxes) expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
  });
});

describe("performance", () => {
  test("solves a 100-node web with cross-links and labels in under 16ms", () => {
    const model = web(100, 11);
    solve(model); // warm up
    const runs: number[] = [];
    let min = solve(model);
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      min = solve(model);
      runs.push(performance.now() - t);
    }
    const median = runs.sort((a, b) => a - b)[2];
    // A random graph this dense leaves some edges no bend can clear; nothing else may remain.
    expect(min.residuals.filter((r) => r.kind !== "edge-node")).toEqual([]);
    expect(median).toBeLessThan(16);
  });
});

