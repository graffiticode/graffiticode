// SPDX-License-Identifier: MIT
/**
 * Where everything on a page goes, computed the way the FigJam plugin places it.
 *
 * Pure: compiled nodes in, boxes and connector routes out, no DOM. Each rule below is the
 * plugin's (`figma-plugin/src/code.ts`), so the picture this view draws is the board the plugin
 * draws:
 *
 * - a node sits at its `x`/`y` (default 0), at its own size or FigJam's default;
 * - a section's children are drawn first, then the section is placed at its `x`/`y`, sized to
 *   `width`/`height` or to the children's bounds plus 24px padding, and the children are moved
 *   as a group so their bounds are centred in it (`renderNodeTree`);
 * - connectors resolve their ends by key — id, else text; a stamp by its reaction; a section by
 *   its name, after its children — expanding lists and "*" into one connector per pair, self-pairs
 *   skipped
 *   (`resolveEndpoints`, `drawConnector`);
 * - an elbowed or curved connector attaches at AUTO magnets, a straight one at CENTER, unless a
 *   side is given; AUTO on a straight connector is CENTER, and CENTER on any other is AUTO
 *   (FigJam refuses it there);
 * - a connector with waypoints is one FigJam connector per leg, meeting at the points (`legs`).
 */
import { CONNECTOR, SECTION, SHAPE, STAMP, STICKY, TEXT } from "./figjam";
import { measure as defaultMeasure, type Measure } from "./text";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placed {
  node: any;
  box: Box;
  /** A section's children, already moved into place. */
  children?: Placed[];
}

export type Side = "top" | "bottom" | "left" | "right" | "center";

export interface Route {
  connector: any;
  lineType: "straight" | "elbowed" | "curved";
  points: { x: number; y: number }[];
  /** For a curve: the two control points between `points[0]` and `points[1]`. */
  controls?: [{ x: number; y: number }, { x: number; y: number }];
  /** The direction the line leaves its start and enters its end, for the caps. */
  startDir: { x: number; y: number };
  endDir: { x: number; y: number };
  /** Where the label sits. */
  mid: { x: number; y: number };
}

export interface PageLayout {
  nodes: Placed[];
  routes: Route[];
  bounds: Box;
}

const num = (v: any, d: number): number => (v == null || !Number.isFinite(Number(v)) ? d : Number(v));

/** A text node is as wide as its longest line (FigJam's auto-width text). */
export function textSize(n: any, m: Measure): { w: number; h: number } {
  const fs = num(n.fontSize, TEXT.fontSize);
  const lines = String(n.text ?? "").split("\n");
  return {
    w: Math.max(1, ...lines.map((l) => m(l, fs))),
    h: lines.length * fs * TEXT.lineHeight,
  };
}

/** A leaf node's box. */
export function boxOf(n: any, m: Measure): Box {
  const x = num(n.x, 0);
  const y = num(n.y, 0);
  switch (n.type) {
    case "sticky":
      return { x, y, w: STICKY.size, h: STICKY.size };
    case "shape":
      return { x, y, w: num(n.width, SHAPE.width), h: num(n.height, SHAPE.height) };
    case "text":
      return { x, y, ...textSize(n, m) };
    case "stamp":
      return { x, y, w: STAMP.size, h: STAMP.size };
    case "section":
      return { x, y, w: num(n.width, SECTION.width), h: num(n.height, SECTION.height) };
  }
  return { x, y, w: 0, h: 0 };
}

export function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

const shift = (p: Placed, dx: number, dy: number): Placed => ({
  ...p,
  box: { ...p.box, x: p.box.x + dx, y: p.box.y + dy },
  children: p.children?.map((c) => shift(c, dx, dy)),
});

/** A section and its children, placed as `renderNodeTree` places them. */
function placeSection(n: any, m: Measure): Placed {
  const children = (n.nodes ?? []).filter((c: any) => c && c.type !== "connector").map((c: any) => place(c, m));
  const b = union(children.map((c: Placed) => c.box));
  const sx = num(n.x, 0);
  const sy = num(n.y, 0);
  const w = n.width != null ? Number(n.width) : b ? b.w + 2 * SECTION.padding : SECTION.width;
  const h = n.height != null ? Number(n.height) : b ? b.h + 2 * SECTION.padding : SECTION.height;
  const dx = b ? sx + (w - b.w) / 2 - b.x : 0;
  const dy = b ? sy + (h - b.h) / 2 - b.y : 0;
  return { node: n, box: { x: sx, y: sy, w, h }, children: children.map((c: Placed) => shift(c, dx, dy)) };
}

function place(n: any, m: Measure): Placed {
  if (n.type === "section" && Array.isArray(n.nodes)) return placeSection(n, m);
  return { node: n, box: boxOf(n, m) };
}

/** The plugin's `primaryKey`. */
export function primaryKey(n: any): string | null {
  if (n.type === "shape" || n.type === "sticky" || n.type === "text") {
    if (n.id != null) return String(n.id);
    return n.text != null ? String(n.text) : null;
  }
  if (n.type === "section") return n.name != null ? String(n.name) : null;
  if (n.type === "stamp") return n.stamp != null ? String(n.stamp) : null;
  return null;
}

/** Every drawn node's key → its box, first registration winning, in the plugin's order. */
export function keyMap(placed: Placed[]): Map<string, Box> {
  const out = new Map<string, Box>();
  const visit = (p: Placed) => {
    // A section registers its children first, then itself by name (after the plugin drew it).
    p.children?.forEach(visit);
    const k = primaryKey(p.node);
    if (k != null && !out.has(k)) out.set(k, p.box);
  };
  placed.forEach(visit);
  return out;
}

/** The plugin's `resolveEndpoints`: a key, a list of keys, or "*" for every key not on the other end. */
export function resolveEnds(spec: any, other: any, keys: Map<string, Box>): Box[] {
  const list = (v: any): string[] => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
  const specs = list(spec);
  if (specs.includes("*")) {
    const excluded = new Set(list(other).filter((s) => s !== "*"));
    return [...keys].filter(([k]) => !excluded.has(k)).map(([, b]) => b);
  }
  return specs.map((s) => keys.get(s)).filter((b): b is Box => !!b);
}

/* ------------------------------------------------------------------ routing */

const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

const SIDE_DIR: Record<string, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function sidePoint(b: Box, side: Side) {
  const c = centre(b);
  if (side === "top") return { x: c.x, y: b.y };
  if (side === "bottom") return { x: c.x, y: b.y + b.h };
  if (side === "left") return { x: b.x, y: c.y };
  if (side === "right") return { x: b.x + b.w, y: c.y };
  return c;
}

/** Where the segment from `b`'s centre towards `to` leaves `b`'s box. */
function clipToBox(b: Box, to: { x: number; y: number }) {
  const c = centre(b);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (!dx && !dy) return c;
  const t = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
  return t >= 1 ? c : { x: c.x + dx * t, y: c.y + dy * t };
}

/**
 * The sides an AUTO elbowed connector uses, as FigJam picks them: boxes that share a band of rows
 * connect across, boxes that share a band of columns connect up or down, and diagonal boxes get
 * one bend — leaving the start vertically and entering the end from the side (measured
 * 2026-10-08 on the fidelity board).
 */
export function autoSides(a: Box, b: Box): [Side, Side] {
  const ca = centre(a);
  const cb = centre(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const across: [Side, Side] = dx >= 0 ? ["right", "left"] : ["left", "right"];
  const down: [Side, Side] = dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
  const rowsOverlap = a.y < b.y + b.h && b.y < a.y + a.h;
  const colsOverlap = a.x < b.x + b.w && b.x < a.x + a.w;
  if (rowsOverlap) return across;
  if (colsOverlap) return down;
  return [down[0], across[1]];
}

/**
 * The sides an AUTO curved connector uses: as an elbowed one where the boxes share a band of rows
 * or columns, but diagonal boxes leave along the dominant axis and enter on the other (a tie
 * leaves vertically) — measured 2026-10-08.
 */
export function autoSidesCurved(a: Box, b: Box): [Side, Side] {
  const ca = centre(a);
  const cb = centre(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const across: [Side, Side] = dx >= 0 ? ["right", "left"] : ["left", "right"];
  const down: [Side, Side] = dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
  const rowsOverlap = a.y < b.y + b.h && b.y < a.y + a.h;
  const colsOverlap = a.x < b.x + b.w && b.x < a.x + a.w;
  if (rowsOverlap) return across;
  if (colsOverlap) return down;
  return Math.abs(dx) > Math.abs(dy) ? [across[0], down[1]] : [down[0], across[1]];
}

const unit = (v: { x: number; y: number }) => {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
};

/** The point halfway along a polyline. */
function midpoint(pts: { x: number; y: number }[]) {
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  let half = lens.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lens.length; i++) {
    if (half <= lens[i] || i === lens.length - 1) {
      const t = lens[i] ? half / lens[i] : 0;
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
    }
    half -= lens[i];
  }
  return pts[0];
}

/** Right-angled points from `p0` leaving along `d0` to `p1` arriving against `d1`. */
function elbow(p0: { x: number; y: number }, d0: { x: number; y: number }, p1: { x: number; y: number }, d1: { x: number; y: number }) {
  const s = CONNECTOR.stub;
  const a = { x: p0.x + d0.x * s, y: p0.y + d0.y * s };
  const b = { x: p1.x + d1.x * s, y: p1.y + d1.y * s };
  const h0 = d0.x !== 0;
  const h1 = d1.x !== 0;
  let mids: { x: number; y: number }[];
  if (h0 && h1) {
    const mx = (a.x + b.x) / 2;
    const forward = (b.x - a.x) * d0.x >= 0;
    mids = forward ? [{ x: mx, y: p0.y }, { x: mx, y: p1.y }] : [a, { x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 }, b];
  } else if (!h0 && !h1) {
    const my = (a.y + b.y) / 2;
    const forward = (b.y - a.y) * d0.y >= 0;
    mids = forward ? [{ x: p0.x, y: my }, { x: p1.x, y: my }] : [a, { x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y }, b];
  } else if (h0) {
    mids = [{ x: p1.x, y: p0.y }];
  } else {
    mids = [{ x: p0.x, y: p1.y }];
  }
  const pts = [p0, ...mids, p1];
  // Drop repeated and collinear points, so a straight run is one segment.
  return pts.filter((p, i) => {
    if (i === 0 || i === pts.length - 1) return true;
    const q = pts[i - 1];
    const r = pts[i + 1];
    if (p.x === q.x && p.y === q.y) return false;
    return !((q.x === p.x && p.x === r.x) || (q.y === p.y && p.y === r.y));
  });
}

const sideOf = (v: any): Side | "auto" | null => (typeof v === "string" && v ? (v.toLowerCase() as Side | "auto") : null);

/** One connector between two boxes, routed as FigJam routes it. */
export function route(c: any, from: Box, to: Box): Route {
  const lineType = (c.lineType ?? "elbowed") as Route["lineType"];
  const straight = lineType === "straight";
  // FigJam accepts CENTER only on a straight connector, and AUTO on any; the plugin defaults a
  // straight one to CENTER and the others to AUTO. A waypoint (a zero-size box) has no magnet.
  const magnet = (v: any, b: Box): Side | "auto" => {
    if (!b.w && !b.h) return "center";
    const s = sideOf(v) ?? (straight ? "center" : "auto");
    if (s === "auto" && straight) return "center";
    return s === "center" && !straight ? "auto" : s;
  };
  let m0 = magnet(c.fromSide, from);
  let m1 = magnet(c.toSide, to);
  const [a0, a1] = lineType === "curved" ? autoSidesCurved(from, to) : autoSides(from, to);
  // A curve's AUTO node end faces a waypoint the same way whichever end the waypoint is: as if
  // the node were the start (measured 2026-10-08).
  const pointToNode = lineType === "curved" && !from.w && !from.h && (to.w || to.h);
  if (m0 === "auto") m0 = a0;
  if (m1 === "auto") m1 = pointToNode ? autoSidesCurved(to, from)[0] : a1;

  // A centre magnet meets the box where the line toward the other end crosses its edge.
  const other0 = m1 === "center" ? centre(to) : sidePoint(to, m1);
  const p0 = m0 === "center" ? clipToBox(from, other0) : sidePoint(from, m0);
  const p1 = m1 === "center" ? clipToBox(to, p0) : sidePoint(to, m1);
  let d0 = m0 === "center" ? unit({ x: p1.x - p0.x, y: p1.y - p0.y }) : SIDE_DIR[m0];
  let d1 = m1 === "center" ? unit({ x: p0.x - p1.x, y: p0.y - p1.y }) : SIDE_DIR[m1];

  if (lineType === "elbowed") {
    // Orthogonal routing needs axis-aligned directions; a centre end takes the dominant axis.
    const axis = (d: { x: number; y: number }) => (Math.abs(d.x) >= Math.abs(d.y) ? { x: Math.sign(d.x) || 1, y: 0 } : { x: 0, y: Math.sign(d.y) || 1 });
    const e0 = axis(d0);
    const e1 = axis(d1);
    const points = elbow(p0, e0, p1, e1);
    const n = points.length;
    return {
      connector: c,
      lineType,
      points,
      startDir: unit({ x: points[1].x - points[0].x, y: points[1].y - points[0].y }),
      endDir: unit({ x: points[n - 1].x - points[n - 2].x, y: points[n - 1].y - points[n - 2].y }),
      mid: midpoint(points),
    };
  }
  if (lineType === "curved") {
    // How FigJam aims a curve at a waypoint (a zero-size box), measured 2026-10-08 on a grid of
    // curved connectors between a node side and a free position. With `n` the node side's
    // outward normal, `a` how far the point lies in front of that side and `p` how far to the
    // side of it:
    // - ending at a point, the curve arrives along `n`'s axis, travelling towards the point;
    // - starting at a point, it leaves along `n`'s axis, towards the side, when the point is
    //   behind the side or more in front than beside it (a < 0 or a >= p), and otherwise leaves
    //   sideways, towards the node.
    const point = (b: Box) => !b.w && !b.h;
    const sign = (v: number) => (v < 0 ? -1 : 1);
    if (point(to) && !point(from) && m0 !== "center") {
      const n = SIDE_DIR[m0];
      const a = (p1.x - p0.x) * n.x + (p1.y - p0.y) * n.y;
      d1 = { x: -sign(a) * n.x, y: -sign(a) * n.y };
    }
    if (point(from) && !point(to) && m1 !== "center") {
      const n = SIDE_DIR[m1];
      const v = { x: p0.x - p1.x, y: p0.y - p1.y };
      const a = v.x * n.x + v.y * n.y;
      const side = { x: v.x - a * n.x, y: v.y - a * n.y };
      const p = Math.hypot(side.x, side.y);
      d0 = a < 0 || a >= p ? { x: -sign(a) * n.x, y: -sign(a) * n.y } : { x: -Math.sign(side.x), y: -Math.sign(side.y) };
    }
    const reach = Math.max(40, Math.hypot(p1.x - p0.x, p1.y - p0.y) * 0.4);
    const c0 = { x: p0.x + d0.x * reach, y: p0.y + d0.y * reach };
    const c1 = { x: p1.x + d1.x * reach, y: p1.y + d1.y * reach };
    const at = (t: number) => {
      const u = 1 - t;
      return {
        x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x,
        y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y,
      };
    };
    return {
      connector: c,
      lineType,
      points: [p0, p1],
      controls: [c0, c1],
      startDir: unit({ x: c0.x - p0.x, y: c0.y - p0.y }),
      endDir: unit({ x: p1.x - c1.x, y: p1.y - c1.y }),
      mid: at(0.5),
    };
  }
  const dir = unit({ x: p1.x - p0.x, y: p1.y - p0.y });
  return { connector: c, lineType: "straight", points: [p0, p1], startDir: dir, endDir: dir, mid: midpoint([p0, p1]) };
}

/** Every connector on a page — at the top level or (as the plugin allows) inside a section. */
function connectorsOf(nodes: any[]): any[] {
  return nodes.flatMap((n) => (n?.type === "connector" ? [n] : n?.type === "section" && Array.isArray(n.nodes) ? connectorsOf(n.nodes) : []));
}

/**
 * A connector between two boxes as the plugin draws it. With waypoints that is one FigJam
 * connector per leg, meeting at fixed points: each leg is routed on its own, a point end has no
 * side, the caps go on the outer ends only and the label on the middle leg.
 */
export function legs(c: any, from: Box, to: Box): Route[] {
  const pts = Array.isArray(c.waypoints) ? c.waypoints.filter((p: any) => p && Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
  if (!pts.length) return [route(c, from, to)];
  const stops: Box[] = [from, ...pts.map((p: any) => ({ x: p.x, y: p.y, w: 0, h: 0 })), to];
  const n = stops.length - 1;
  const labelled = Math.floor((n - 1) / 2);
  return stops.slice(1).map((b, i) => {
    const leg = {
      ...c,
      fromSide: i === 0 ? c.fromSide : "center",
      toSide: i === n - 1 ? c.toSide : "center",
      fromCap: i === 0 ? c.fromCap : "none",
      toCap: i === n - 1 ? c.toCap : "none",
      label: i === labelled ? c.label : undefined,
    };
    return route(leg, stops[i], b);
  });
}

/** A page's nodes, placed, with every connector routed and the bounds of everything drawn. */
export function layoutPage(nodes: any[], m: Measure = defaultMeasure): PageLayout {
  const placed = nodes.filter((n) => n && n.type !== "connector").map((n) => place(n, m));
  const keys = keyMap(placed);
  const routes: Route[] = [];
  for (const c of connectorsOf(nodes)) {
    for (const a of resolveEnds(c.from, c.to, keys)) {
      for (const b of resolveEnds(c.to, c.from, keys)) {
        if (a !== b) routes.push(...legs(c, a, b));
      }
    }
  }
  // A section's name sits above its top edge, so the bounds reach up to include it.
  const boxes = placed.map((p) => (p.node.type === "section" && p.node.name ? { ...p.box, y: p.box.y - SECTION.label.height - 6, h: p.box.h + SECTION.label.height + 6 } : p.box));
  for (const r of routes) {
    for (const p of [...r.points, ...(r.controls ?? [])]) boxes.push({ x: p.x, y: p.y, w: 0, h: 0 });
  }
  return { nodes: placed, routes, bounds: union(boxes) ?? { x: 0, y: 0, w: 0, h: 0 } };
}
