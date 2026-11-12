// SPDX-License-Identifier: MIT
/**
 * Where everything in a web goes. Pure geometry, tested without a DOM. Units are CSS pixels.
 *
 * Nodes and text have one fixed size, and the web spreads to fill whatever frame it is given.
 * That happens in two stages:
 *
 * 1. `solve(model)` — the MINIMUM layout. It depends only on the model and the measured label
 *    sizes, never on the frame: the hub at the origin, nodes on rings (lib/rings.ts), every edge
 *    routed as a quadratic Bézier from centre to centre (bent around any node in its way), and
 *    each label anchored at a parameter t on its edge. Ring radii start at their closed-form
 *    lower bounds and grow, a step at a time, until nothing collides: no two nodes, no edge
 *    through a node that is not its end, no label on a node or another label. Whatever still
 *    collides at R_MAX is reported in `residuals`.
 *
 * 2. `expand(min, frame)` — a uniform stretch of that geometry about the hub, by one factor
 *    s ≥ 1 on both axes so rings stay circles, as large as the tighter axis of the frame allows.
 *    Centres, the full curves and the label anchors move; nothing changes size, and nothing is
 *    re-routed or re-placed.
 *
 * Why stage 2 can never create a collision: stretching every centre and path by s while keeping
 * sizes fixed is the original geometry with every object SHRUNK by 1/s, then magnified. A shrunk box lies inside the original one, so whatever was disjoint stays disjoint;
 * an affine image of a quadratic is a quadratic, so routes stay routes; and each centre-to-centre
 * distance only grows as the frame does. The parts of a curve that become visible as its end
 * boxes "shrink" lie inside those original end boxes, which every other node and label already
 * keeps clear of.
 *
 * Canvas bounds are symmetric about the hub, so the hub is always centred, and they count every
 * node box, every label box and every curve's turning points (plus stroke and arrowhead), so
 * nothing drawn falls outside.
 */
import {
  advance,
  boxesOverlap,
  BoxGrid,
  flatten,
  enterParam,
  EPS,
  exitParam,
  extremumT,
  halfDiagonal,
  pointAt,
  straight,
  subCurve,
  type Box,
  type Pt,
  type Quad,
} from "./geom";
import { assignRings, SINGLE_RING } from "./rings";

export const GAP = 16;
export const PAD = 16;
export const STROKE = 2;
export const ARROW_LEN = 12;
/** How far a drawn line stops short of the outlines it joins. */
export const LINE_GAP = 6;
/** Clearance kept between a label and anything else. */
const LABEL_CLEAR = 4;
/** Clearance kept between an edge and a node it passes. */
const EDGE_CLEAR = 6;

export interface Size {
  w: number;
  h: number;
}

export interface LayoutNode {
  id: string;
  shape?: string;
  size?: string;
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  /** The space reserved for the edge's label, when it has one or is a blank. */
  label?: Size;
}

export interface LayoutModel {
  hub: LayoutNode;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

export interface Residual {
  kind: "node-node" | "edge-node" | "label-node" | "label-label";
  ids: string[];
}

export interface MinEdge {
  id: string;
  from: string;
  to: string;
  /** Centre to centre. */
  full: Quad;
}

export interface MinLabel {
  id: string;
  t: number;
  w: number;
  h: number;
  residual: boolean;
}

export interface MinLayout {
  /** Centres relative to the hub at (0, 0). */
  boxes: Box[];
  ring: Record<string, number>;
  edges: MinEdge[];
  labels: MinLabel[];
  residuals: Residual[];
  min: { width: number; height: number };
}

export interface PlacedEdge {
  id: string;
  full: Quad;
  /** The drawn part: the full curve trimmed to the outlines, less LINE_GAP at each end. */
  path: Quad;
}

export interface PlacedLabel extends Box {
  residual: boolean;
}

export interface Geometry {
  width: number;
  height: number;
  sx: number;
  sy: number;
  boxes: Box[];
  edges: PlacedEdge[];
  labels: PlacedLabel[];
  residuals: Residual[];
  min: { width: number; height: number };
}

/** Node width by size. Heights follow the shape. These are what a 640px web drew before. */
const WIDTH: Record<string, number> = { small: 96, medium: 122, large: 160 };

export function dims(node: LayoutNode, fallback: string): Size {
  const w = WIDTH[node.size || fallback] ?? WIDTH.medium;
  return { w, h: (node.shape || "rounded") === "circle" ? w : Math.round(w * 0.56) };
}

// ---- Stage 1 -------------------------------------------------------------------------------

interface Built {
  boxes: Box[];
  edges: MinEdge[];
  labels: MinLabel[];
  failures: Residual[];
}

/** Visible parameter range of a curve between its end boxes, less the line gap. */
function visibleRange(q: Quad, a: Box, b: Box): [number, number] {
  const t0 = exitParam(q, a);
  const t1 = enterParam(q, b);
  if (t1 <= t0) return [t0, t1];
  const g0 = advance(q, t0, LINE_GAP);
  const g1 = advance(q, t1, -LINE_GAP);
  return g1 > g0 ? [g0, g1] : [t0, t1];
}

function blocker(q: Quad, a: Box, b: Box, grid: BoxGrid): Box | undefined {
  const t0 = exitParam(q, a);
  const t1 = enterParam(q, b);
  if (t1 <= t0) return undefined;
  return grid.firstHit(flatten(q, t0, t1), (box) => box.id === a.id || box.id === b.id);
}

const OFFSETS = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 8, -8];

/**
 * A straight line, or the first bend that clears every node it is not joined to. `hint` is the
 * bend that worked for this edge on the solver's previous step; it is tried right after the
 * straight line, since the web has only grown a little since.
 */
export function route(
  a: Box,
  b: Box,
  grid: BoxGrid,
  hint?: number,
): { full: Quad; blockedBy?: string; bend: number } {
  const line = straight({ x: a.x, y: a.y }, { x: b.x, y: b.y });
  const first = blocker(line, a, b, grid);
  if (!first) return { full: line, bend: 0 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // The perpendicular pointing away from the hub, so a bend prefers the outside of the web.
  let nx = -dy / len;
  let ny = dx / len;
  if (nx * line.c.x + ny * line.c.y < 0) {
    nx = -nx;
    ny = -ny;
  }
  const tries = hint ? [hint, ...OFFSETS.filter((k) => k !== hint)] : OFFSETS;
  for (const k of tries) {
    const d = k * len * 0.12;
    const q: Quad = { p0: line.p0, c: { x: line.c.x + nx * d, y: line.c.y + ny * d }, p2: line.p2 };
    if (!blocker(q, a, b, grid)) return { full: q, bend: k };
  }
  return { full: line, blockedBy: first.id, bend: 0 };
}

const LABEL_TS = [0.5, 0.35, 0.65];

function build(
  model: LayoutModel,
  sizes: Map<string, Size>,
  slots: Map<string, { ring: number; angle: number }>,
  radii: number[],
  bends: Map<string, number>,
): Built {
  const hubSize = sizes.get(model.hub.id)!;
  const boxes: Box[] = [
    { id: model.hub.id, x: 0, y: 0, ...hubSize, shape: model.hub.shape || "rounded" },
  ];
  for (const node of model.nodes) {
    const s = slots.get(node.id)!;
    const r = radii[s.ring - 1];
    boxes.push({
      id: node.id,
      x: r * Math.cos(s.angle),
      y: r * Math.sin(s.angle),
      ...sizes.get(node.id)!,
      shape: node.shape || "rounded",
    });
  }
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const failures: Residual[] = [];

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxesOverlap(boxes[i], boxes[j], GAP / 2)) {
        failures.push({ kind: "node-node", ids: [boxes[i].id, boxes[j].id] });
      }
    }
  }

  const cell = Math.max(64, ...boxes.map((b) => Math.max(b.w, b.h)));
  const grid = new BoxGrid(boxes, cell, EDGE_CLEAR);
  const edges: MinEdge[] = [];
  for (const e of model.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b || a === b) continue;
    const r = route(a, b, grid, bends.get(e.id));
    bends.set(e.id, r.bend);
    if (r.blockedBy) failures.push({ kind: "edge-node", ids: [e.from, e.to, r.blockedBy] });
    edges.push({ id: e.id, from: e.from, to: e.to, full: r.full });
  }

  const labels: MinLabel[] = [];
  const placed: { box: Box; edge: MinEdge }[] = [];
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  for (const e of model.edges) {
    const edge = edgeById.get(e.id);
    if (!edge || !e.label) continue;
    const [v0, v1] = visibleRange(edge.full, byId.get(edge.from)!, byId.get(edge.to)!);
    let chosen: { t: number; box: Box } | undefined;
    let firstHit: Residual | undefined;
    for (const t of LABEL_TS) {
      const p = pointAt(edge.full, t);
      const box: Box = { id: e.id, x: p.x, y: p.y, w: e.label.w, h: e.label.h, shape: "rect" };
      let hit: Residual | undefined;
      if (t <= v0 || t >= v1) hit = { kind: "label-node", ids: [edge.from, edge.to] };
      for (const n of boxes) {
        if (hit) break;
        if (boxesOverlap(box, n, LABEL_CLEAR)) hit = { kind: "label-node", ids: [edge.from, edge.to, n.id] };
      }
      for (const other of placed) {
        if (hit) break;
        if (boxesOverlap(box, other.box, LABEL_CLEAR)) {
          hit = { kind: "label-label", ids: [edge.from, edge.to, other.edge.from, other.edge.to] };
        }
      }
      if (!hit) {
        chosen = { t, box };
        break;
      }
      firstHit ??= hit;
    }
    const residual = !chosen;
    if (!chosen) {
      const p = pointAt(edge.full, 0.5);
      chosen = { t: 0.5, box: { id: e.id, x: p.x, y: p.y, w: e.label.w, h: e.label.h, shape: "rect" } };
      failures.push(firstHit!);
    }
    placed.push({ box: chosen.box, edge });
    labels.push({ id: e.id, t: chosen.t, w: e.label.w, h: e.label.h, residual });
  }
  return { boxes, edges, labels, failures };
}

/** Everything that must fit on the canvas: its offset from the hub and its fixed half-size. */
interface Extent {
  dx: number;
  dy: number;
  ex: number;
  ey: number;
}

const CURVE_REACH = STROKE / 2 + ARROW_LEN;

function extents(boxes: Box[], edges: { full: Quad }[], labels: Box[]): Extent[] {
  const out: Extent[] = [];
  for (const b of [...boxes, ...labels]) out.push({ dx: b.x, dy: b.y, ex: b.w / 2, ey: b.h / 2 });
  for (const e of edges) {
    for (const axis of ["x", "y"] as const) {
      const t = extremumT(e.full, axis);
      if (t === undefined) continue;
      const p = pointAt(e.full, t);
      out.push({ dx: p.x, dy: p.y, ex: CURVE_REACH, ey: CURVE_REACH });
    }
  }
  return out;
}

function minSize(ext: Extent[]): { width: number; height: number } {
  let w = 0;
  let h = 0;
  for (const o of ext) {
    w = Math.max(w, Math.abs(o.dx) + o.ex);
    h = Math.max(h, Math.abs(o.dy) + o.ey);
  }
  return { width: Math.ceil(2 * w + 2 * PAD), height: Math.ceil(2 * h + 2 * PAD) };
}

function labelBoxes(edges: MinEdge[], labels: MinLabel[]): Box[] {
  const byId = new Map(edges.map((e) => [e.id, e]));
  return labels.map((l) => {
    const p = pointAt(byId.get(l.id)!.full, l.t);
    return { id: l.id, x: p.x, y: p.y, w: l.w, h: l.h, shape: "rect" };
  });
}

/**
 * The ring a failure is resolved by growing. For an edge through a node, the blocker's ring:
 * growing it widens the gaps the edge must pass through. Otherwise the outermost ring involved,
 * which pulls the parts apart. Never the hub (0).
 */
function ringToGrow(f: Residual, ring: Record<string, number>): number {
  if (f.kind === "edge-node") return Math.max(1, ring[f.ids[2]] ?? 0);
  return Math.max(1, ...f.ids.map((id) => ring[id] ?? 0));
}

/** How many growth steps the last `solve` took (for tests and tuning). */
export const ITERATIONS = { last: 0 };

/** Stage 1: the minimum collision-free layout. Independent of any frame. */
export function solve(model: LayoutModel): MinLayout {
  const sizes = new Map<string, Size>();
  sizes.set(model.hub.id, dims(model.hub, "large"));
  for (const n of model.nodes) sizes.set(n.id, dims(n, "medium"));
  const hubHd = halfDiagonal({ ...sizes.get(model.hub.id)!, shape: model.hub.shape });
  const hd = Math.max(0, ...model.nodes.map((n) => halfDiagonal({ ...sizes.get(n.id)!, shape: n.shape })));

  const plan = assignRings(
    model.hub.id,
    model.nodes.map((n) => n.id),
    model.edges,
    hubHd,
    hd,
    GAP,
  );
  const slots = new Map(plan.slots.map((s) => [s.id, s]));
  const ring: Record<string, number> = { [model.hub.id]: 0 };
  for (const s of plan.slots) ring[s.id] = s.ring;

  const radii = [...plan.radii];
  const outer0 = radii[radii.length - 1] ?? 0;
  // Growth helps labels and node spacing a lot, and an edge stuck behind a node only a little
  // (routing does most of that work), so edge-only failures get a smaller budget.
  const rMax = 3 * outer0 + 400;
  const rMaxEdges = 1.5 * outer0 + 100;

  ITERATIONS.last = 0;
  const bends = new Map<string, number>();
  let built = build(model, sizes, slots, radii, bends);
  while (radii.length) {
    const outer = radii[radii.length - 1];
    const growable = built.failures.filter((f) => (f.kind === "edge-node" ? outer < rMaxEdges : outer < rMax));
    if (!growable.length) break;
    const g = Math.min(...growable.map((f) => ringToGrow(f, ring)));
    // Edge failures alone are coarse to fix by growth, so they take bigger steps.
    const edgesOnly = growable.every((f) => f.kind === "edge-node");
    // Steps scale with the whole web: growing ring 1 by a fraction of its own small radius
    // would take dozens of steps to move a large web's outer rings at all.
    const step = Math.max(8, Math.round(outer * (edgesOnly ? 0.08 : 0.04)));
    for (let i = g - 1; i < radii.length; i++) radii[i] += step;
    built = build(model, sizes, slots, radii, bends);
    ITERATIONS.last++;
  }

  return {
    boxes: built.boxes,
    ring,
    edges: built.edges,
    labels: built.labels,
    residuals: built.failures,
    min: minSize(extents(built.boxes, built.edges, labelBoxes(built.edges, built.labels))),
  };
}

// ---- Stage 2 -------------------------------------------------------------------------------

/**
 * How far one axis lets the web stretch: the largest s ≥ 1 that keeps every object inside the
 * padded canvas on that axis. 1 when the frame is no bigger than the minimum on this axis.
 * Infinity when nothing is off-centre on this axis (a one-node web, or two nodes stacked on the
 * other axis), so that axis sets no limit — never a division by zero.
 */
function stretchLimit(frame: number, min: number, ext: Extent[], axis: "x" | "y"): number {
  if (!(frame > min)) return 1;
  let s = Infinity;
  for (const o of ext) {
    const d = Math.abs(axis === "x" ? o.dx : o.dy);
    if (d < EPS) continue;
    const e = axis === "x" ? o.ex : o.ey;
    s = Math.min(s, (frame / 2 - PAD - e) / d);
  }
  return Math.max(1, s);
}

/**
 * Stage 2: stretch the minimum layout to fill `frame`, by ONE factor on both axes, so rings stay
 * circles. The tighter axis decides it; the other keeps its spare room, with the web centred in
 * it. The canvas is never smaller than `min`.
 */
export function expand(layout: MinLayout, frame: { width: number; height: number }): Geometry {
  const width = Math.max(frame.width || 0, layout.min.width);
  const height = Math.max(frame.height || 0, layout.min.height);
  const ext = extents(layout.boxes, layout.edges, labelBoxes(layout.edges, layout.labels));
  const limit = Math.min(
    stretchLimit(width, layout.min.width, ext, "x"),
    stretchLimit(height, layout.min.height, ext, "y"),
  );
  return placeAt(layout, Number.isFinite(limit) ? limit : 1, width, height);
}

/** The geometry with every centre and path scaled by `s` about the hub, centred in width × height. */
function placeAt(layout: MinLayout, s: number, width: number, height: number): Geometry {
  const g = placeRelative(layout, s);
  return translate(g.geometry, width / 2, height / 2, width, height);
}

/** Label positions to try along an edge when the spacing is compressed: its best-fit t first. */
const ANCHOR_TS = [0.5, 0.35, 0.65, 0.25, 0.75, 0.2, 0.8];

/**
 * The geometry at spacing s with the hub at the origin. Below best fit, each label is re-anchored
 * to the first t on its own curve that is clear of every node and of the labels before it, so the
 * spacing can compress further before anything collides. `clashes` counts the labels (other than
 * best-fit residuals) that found no clear place.
 */
function placeRelative(layout: MinLayout, s: number): { geometry: Geometry; clashes: number } {
  const at = (p: Pt): Pt => ({ x: s * p.x, y: s * p.y });
  const boxes = layout.boxes.map((b) => ({ ...b, ...at(b) }));
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const edges: PlacedEdge[] = layout.edges.map((e) => {
    const full: Quad = { p0: at(e.full.p0), c: at(e.full.c), p2: at(e.full.p2) };
    const [t0, t1] = visibleRange(full, byId.get(e.from)!, byId.get(e.to)!);
    return { id: e.id, full, path: subCurve(full, t0, Math.max(t0, t1)) };
  });
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const minEdgeById = new Map(layout.edges.map((e) => [e.id, e]));
  const labels: PlacedLabel[] = [];
  let clashes = 0;
  for (const l of layout.labels) {
    const edge = edgeById.get(l.id)!;
    const box = (t: number): PlacedLabel => {
      const p = pointAt(edge.full, t);
      return { id: l.id, x: p.x, y: p.y, w: l.w, h: l.h, shape: "rect", residual: l.residual };
    };
    if (s >= 1 || l.residual) {
      labels.push(box(l.t));
      continue;
    }
    const me = minEdgeById.get(l.id)!;
    const [v0, v1] = visibleRange(edge.full, byId.get(me.from)!, byId.get(me.to)!);
    const tries = [l.t, ...ANCHOR_TS.filter((t) => t !== l.t)];
    // The first clear spot; failing that, the spot that covers the least of any node (a label on
    // a node hides it), then the least of other labels.
    let chosen: PlacedLabel | undefined;
    let least: { b: PlacedLabel; onNodes: number; onLabels: number } | undefined;
    for (const t of tries) {
      if (t <= v0 || t >= v1) continue;
      const b = box(t);
      let onNodes = 0;
      let onLabels = 0;
      for (const n of boxes) onNodes += overlapArea(b, n, LABEL_CLEAR);
      for (const o of labels) onLabels += overlapArea(b, o, LABEL_CLEAR);
      if (onNodes === 0 && onLabels === 0) {
        chosen = b;
        break;
      }
      if (!least || onNodes < least.onNodes || (onNodes === least.onNodes && onLabels < least.onLabels)) {
        least = { b, onNodes, onLabels };
      }
    }
    if (!chosen) clashes++;
    labels.push(chosen ?? least?.b ?? box(l.t));
  }
  const geometry: Geometry = {
    width: 0,
    height: 0,
    sx: s,
    sy: s,
    boxes,
    edges,
    labels,
    residuals: layout.residuals,
    min: layout.min,
  };
  return { geometry, clashes };
}

/** How much two boxes, each grown by gap/2, overlap (their bounding rectangles). */
function overlapArea(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, gap: number): number {
  const ox = (a.w + b.w) / 2 + gap - Math.abs(a.x - b.x);
  const oy = (a.h + b.h) / 2 + gap - Math.abs(a.y - b.y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

function translate(g: Geometry, dx: number, dy: number, width: number, height: number): Geometry {
  const mv = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
  const q = (c: Quad): Quad => ({ p0: mv(c.p0), c: mv(c.c), p2: mv(c.p2) });
  return {
    ...g,
    width,
    height,
    boxes: g.boxes.map((b) => ({ ...b, ...mv(b) })),
    edges: g.edges.map((e) => ({ ...e, full: q(e.full), path: q(e.path) })),
    labels: g.labels.map((l) => ({ ...l, ...mv(l) })),
  };
}

/** The canvas a hub-centred geometry needs: symmetric about the hub, everything inside it. */
function canvasOf(g: Geometry): { width: number; height: number } {
  const ext = extents(g.boxes, g.edges, g.labels);
  let w = 0;
  let h = 0;
  for (const o of ext) {
    w = Math.max(w, Math.abs(o.dx) + o.ex);
    h = Math.max(h, Math.abs(o.dy) + o.ey);
  }
  return { width: Math.ceil(2 * w + 2 * PAD), height: Math.ceil(2 * h + 2 * PAD) };
}

// ---- Spacing: the view's rule ----------------------------------------------------------------
//
// Nodes and text never change size; only the SPACING does, by one factor s about the hub. The
// minimum layout (s = 1) is the best fit: the closest spacing at which nothing collides. The view
// never spreads past it, and with less room compresses the spacing down to `compressionFloor`,
// where nodes would start to touch. Below best fit each label slides along its own line to the
// first clear spot, or the spot that overlaps least. Past the floor the view zooms the whole
// picture to fit.

/** Clearance kept between nodes at the tightest compression. */
const TOUCH_GAP = 4;
/** Compression is never searched below this, so a web with nothing to collide stays sane. */
const LOWEST = 0.05;

/**
 * The smallest spacing factor at which no two node boxes come within TOUCH_GAP of each other.
 * Two boxes are clear when they are apart on either axis, so each pair needs
 * min(gap-on-x, gap-on-y) and the floor is the largest such need. At most 1: the best fit is
 * already clear. Labels do not set the floor: below best fit each slides along its own line to
 * the clearest spot (`placeRelative`).
 */
export function compressionFloor(layout: MinLayout): number {
  let floor = LOWEST;
  const b = layout.boxes;
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      const dx = Math.abs(b[i].x - b[j].x);
      const dy = Math.abs(b[i].y - b[j].y);
      const needX = dx > EPS ? ((b[i].w + b[j].w) / 2 + TOUCH_GAP) / dx : Infinity;
      const needY = dy > EPS ? ((b[i].h + b[j].h) / 2 + TOUCH_GAP) / dy : Infinity;
      floor = Math.max(floor, Math.min(needX, needY));
    }
  }
  return Math.min(1, floor);
}

/** The canvas the geometry needs at spacing s. */
export function canvasAt(layout: MinLayout, s: number): { width: number; height: number } {
  return canvasOf(placeRelative(layout, s).geometry);
}

/**
 * The spacing for a room: the largest s in [floor, 1] whose canvas fits the room. Never above the
 * best fit, never below the floor (where the view scrolls instead).
 */
export function spacingFor(layout: MinLayout, room: { width: number; height: number }): number {
  const fits = (s: number) => {
    const c = canvasAt(layout, s);
    return c.width <= room.width + 0.5 && c.height <= room.height + 0.5;
  };
  if (fits(1)) return 1;
  const floor = compressionFloor(layout);
  if (!fits(floor)) return floor;
  let lo = floor;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The geometry at spacing s, on the canvas it needs. Node, label and text sizes are fixed. */
export function place(layout: MinLayout, s: number): Geometry {
  const g = placeRelative(layout, s).geometry;
  const c = canvasOf(g);
  return translate(g, c.width / 2, c.height / 2, c.width, c.height);
}

/** Both stages at once, for tests and simple callers. */
export function layout(model: LayoutModel, frame = { width: 0, height: 0 }): Geometry {
  return expand(solve(model), frame);
}

export { SINGLE_RING };
