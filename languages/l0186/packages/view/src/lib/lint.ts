// SPDX-License-Identifier: MIT
/**
 * Lint a page's connectors against the board the plugin will draw — the corpus gate's rules.
 *
 * A program can compile and still draw badly: a line through a node it does not join, a waypoint
 * inside a node, an end attached to the wrong side. These are the mistakes the L0186 instructions
 * teach against (`spec/instructions.md`, "Connectors" and "Keep every line clear of other nodes"),
 * checked on the routes `layout.ts` computes, so what is flagged is what would be drawn. Pure: no
 * DOM, no compiler. `tools/check-corpus.ts` runs it over a generated corpus before it is embedded.
 */
import { autoSidesCurved, keyMap, layoutPage, legs, resolveEnds, type Box, type Placed, type Route } from "./layout";
import { measure as defaultMeasure, type Measure } from "./text";

export type Rule = "crosses-node" | "waypoint-inside-node" | "side-not-given" | "side-mismatch" | "off-centre" | "redundant-waypoint";

export interface Finding {
  rule: Rule;
  /** The connector, as `from → to`. */
  connector: string;
  message: string;
}

type Pt = { x: number; y: number };
type Side = "top" | "bottom" | "left" | "right";

const centre = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const inside = (p: Pt, b: Box) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;

function sidePoint(b: Box, s: Side): Pt {
  const c = centre(b);
  return s === "top" ? { x: c.x, y: b.y } : s === "bottom" ? { x: c.x, y: b.y + b.h } : s === "left" ? { x: b.x, y: c.y } : { x: b.x + b.w, y: c.y };
}

/** The side of `b` facing `p`: top or bottom beyond its vertical span, else left or right. */
export function facing(b: Box, p: Pt): Side {
  if (p.y < b.y) return "top";
  if (p.y > b.y + b.h) return "bottom";
  return p.x < b.x + b.w / 2 ? "left" : "right";
}

/** Every drawn node, sections left out: a line may cross into a section to reach a node in it. */
function drawn(placed: Placed[], out: Placed[] = []): Placed[] {
  for (const p of placed) {
    if (p.node.type !== "section") out.push(p);
    if (p.children) drawn(p.children, out);
  }
  return out;
}

/** A route as a polyline: corners as drawn, curves sampled. */
function polyline(r: Route): Pt[] {
  if (r.lineType !== "curved" || !r.controls) return r.points;
  const [p0, p1] = [r.points[0], r.points[r.points.length - 1]];
  const [c0, c1] = r.controls;
  return Array.from({ length: 25 }, (_, i) => {
    const t = i / 24;
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x,
      y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y,
    };
  });
}

/** Does segment ab pass through the box's interior? A line along an edge does not count. */
function crosses(a: Pt, b: Pt, box: Box): boolean {
  const inset = 2;
  const [x0, y0, x1, y1] = [box.x + inset, box.y + inset, box.x + box.w - inset, box.y + box.h - inset];
  if (x1 <= x0 || y1 <= y0) return false;
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dy, a.y - y0],
    [dy, y1 - a.y],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      t0 = Math.max(t0, r);
    } else {
      if (r < t0) return false;
      t1 = Math.min(t1, r);
    }
  }
  return t0 < t1;
}

const nameOf = (n: any): string => String(n?.id ?? n?.text ?? n?.name ?? n?.stamp ?? n?.type ?? "?");

/**
 * The checks for one end of a connector with waypoints: `end` is the node, `w` the waypoint next
 * to it, `beyond` the stop past that (the next waypoint, or null). `leaving` is true at the start.
 */
function checkEnd(c: any, end: Box, w: Pt, beyond: Pt | null, leaving: boolean, label: string, out: Finding[]): boolean {
  const word = leaving ? "from-side" : "to-side";
  const given = (leaving ? c.fromSide : c.toSide) as string | undefined;
  const want = facing(end, w);
  const side = (given && given !== "auto" && given !== "center" ? given : autoSidesCurved(end, { ...w, w: 0, h: 0 })[0]) as Side;
  const where = leaving ? "first" : "last";
  if (!given) {
    out.push({ rule: "side-not-given", connector: label, message: `${label}: give ${word} with waypoints; the ${where} waypoint [${w.x} ${w.y}] is ${want === "top" ? "above" : want === "bottom" ? "below" : "beside"} it, so ${word} ${want.toUpperCase()}.` });
  } else if (side !== want) {
    out.push({ rule: "side-mismatch", connector: label, message: `${label}: ${word} ${side.toUpperCase()} does not face the ${where} waypoint [${w.x} ${w.y}]; it should be ${want.toUpperCase()}.` });
  }
  const sp = sidePoint(end, want);
  const level = want === "left" || want === "right" ? w.y > end.y && w.y < end.y + end.h && w.y !== sp.y : w.x > end.x && w.x < end.x + end.w && w.x !== sp.x;
  if (level) {
    const axis = want === "left" || want === "right" ? "y" : "x";
    out.push({ rule: "off-centre", connector: label, message: `${label}: the ${where} waypoint [${w.x} ${w.y}] is level with the node but not its centre (${axis} ${axis === "y" ? sp.y : sp.x}), so the line jogs into it.` });
  }
  // A waypoint exactly where the leg to the node would turn anyway adds nothing.
  if (beyond && (c.lineType ?? "elbowed") === "elbowed" && side === want) {
    const corner = want === "left" || want === "right" ? { x: beyond.x, y: sp.y } : { x: sp.x, y: beyond.y };
    const runsAcross = Math.abs(sp.x - beyond.x) >= Math.abs(sp.y - beyond.y);
    const turnsThere = want === "left" || want === "right" ? !runsAcross : runsAcross;
    if (w.x === corner.x && w.y === corner.y && (leaving || turnsThere)) {
      out.push({ rule: "redundant-waypoint", connector: label, message: `${label}: the ${where} waypoint [${w.x} ${w.y}] is where the line turns into the node anyway; leave it out.` });
      return true;
    }
  }
  return false;
}

/** Lint one page's connectors. */
export function lintPage(nodes: any[], m: Measure = defaultMeasure): Finding[] {
  const out: Finding[] = [];
  const layout = layoutPage(nodes, m);
  const keys = keyMap(layout.nodes);
  const boxes = drawn(layout.nodes);
  const connectors: any[] = [];
  const walk = (ns: any[]) => ns.forEach((n) => (n?.type === "connector" ? connectors.push(n) : n?.type === "section" && walk(n.nodes ?? [])));
  walk(nodes);
  for (const c of connectors) {
    for (const a of resolveEnds(c.from, c.to, keys)) {
      for (const b of resolveEnds(c.to, c.from, keys)) {
        if (a === b) continue;
        const ends = boxes.filter((p) => p.box === a || p.box === b);
        const label = `${nameOf(ends.find((p) => p.box === a)?.node)} → ${nameOf(ends.find((p) => p.box === b)?.node)}`;
        // Waypoints as drawn: `_` keeps the current coordinate.
        let cur = centre(a);
        const pts: Pt[] = (Array.isArray(c.waypoints) ? c.waypoints : [])
          .filter((p: any) => p && (Number.isFinite(p.x) || Number.isFinite(p.y)))
          .map((p: any) => (cur = { x: Number.isFinite(p.x) ? p.x : cur.x, y: Number.isFinite(p.y) ? p.y : cur.y }));
        for (const w of pts) {
          for (const p of boxes) {
            if (inside(w, p.box)) out.push({ rule: "waypoint-inside-node", connector: label, message: `${label}: waypoint [${w.x} ${w.y}] is inside ${nameOf(p.node)}; a waypoint must be outside every node.` });
          }
        }
        if (pts.length && (c.lineType ?? "elbowed") !== "straight") {
          // With two waypoints either may be redundant, but not both: once the last is, the first is
          // what the route needs.
          const atEnd: Finding[] = [];
          const atStart: Finding[] = [];
          const lastRedundant = checkEnd(c, b, pts[pts.length - 1], pts.length > 1 ? pts[pts.length - 2] : null, false, label, atEnd);
          checkEnd(c, a, pts[0], lastRedundant && pts.length === 2 ? null : (pts[1] ?? null), true, label, atStart);
          out.push(...atStart, ...atEnd);
        }
        const hit = new Set<string>();
        for (const r of legs(c, a, b)) {
          const line = polyline(r);
          for (let i = 1; i < line.length; i++) {
            for (const p of boxes) if (!ends.includes(p) && crosses(line[i - 1], line[i], p.box)) hit.add(nameOf(p.node));
          }
        }
        if (hit.size) {
          out.push({ rule: "crosses-node", connector: label, message: `${label} runs through ${[...hit].join(", ")}, which it does not join. Move the nodes so the path is clear, set the sides facing each other, or route around with waypoints.` });
        }
      }
    }
  }
  return out;
}
