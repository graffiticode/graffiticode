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

export type Rule = "crosses-node" | "enters-from-inside" | "doubles-back" | "waypoint-inside-node" | "off-centre" | "redundant-waypoint";

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
 * Judged against the side the line actually uses there — the one given, or AUTO's.
 */
function checkEnd(c: any, end: Box, w: Pt, beyond: Pt | null, leaving: boolean, label: string, out: Finding[]): boolean {
  const given = (leaving ? c.fromSide : c.toSide) as string | undefined;
  const side = (given && given !== "auto" && given !== "center" ? given : autoSidesCurved(end, { ...w, w: 0, h: 0 })[0]) as Side;
  const where = leaving ? "first" : "last";
  const across = side === "left" || side === "right";
  const sp = sidePoint(end, side);
  // A waypoint level with the side it runs straight into must be on the side's centre line.
  const level = across ? w.y > end.y && w.y < end.y + end.h && w.y !== sp.y : w.x > end.x && w.x < end.x + end.w && w.x !== sp.x;
  if (level) {
    const axis = across ? "y" : "x";
    out.push({ rule: "off-centre", connector: label, message: `${label}: the ${where} waypoint [${w.x} ${w.y}] is level with the node but not its centre (${axis} ${across ? sp.y : sp.x}), so the line jogs into it.` });
  }
  // A waypoint exactly where the leg to the node would turn anyway adds nothing.
  if (beyond && (c.lineType ?? "elbowed") === "elbowed") {
    const corner = across ? { x: beyond.x, y: sp.y } : { x: sp.x, y: beyond.y };
    const runsAcross = Math.abs(sp.x - beyond.x) >= Math.abs(sp.y - beyond.y);
    const turnsThere = across ? !runsAcross : runsAcross;
    // FigJam turns there only when the leg runs further across than up for a top/bottom side, or
    // further up than across for a left/right one; otherwise it draws a Z and the waypoint is needed.
    if (w.x === corner.x && w.y === corner.y && turnsThere) {
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
        const routes = legs(c, a, b);
        // Where two legs meet at a waypoint the line must not reverse along itself.
        const n = pts.length + 1;
        for (let i = 0; pts.length && i < n - 1; i++) {
          const din = routes[i].endDir;
          const dout = routes[i + 1].startDir;
          if (din.x * dout.x + din.y * dout.y < -0.99) {
            const w = pts[i];
            out.push({ rule: "doubles-back", connector: label, message: `${label}: the line doubles back on itself at waypoint [${w.x} ${w.y}]. Set the end's side so the last run enters it without retracing the route (e.g. to-side BOTTOM for a line that comes in from below).` });
          }
        }
        const hit = new Set<string>();
        const own = new Set<string>();
        for (const r of routes) {
          const line = polyline(r);
          for (let i = 1; i < line.length; i++) {
            for (const p of boxes) {
              if (!crosses(line[i - 1], line[i], p.box)) continue;
              (ends.includes(p) ? own : hit).add(nameOf(p.node));
            }
          }
        }
        if (own.size) {
          out.push({ rule: "enters-from-inside", connector: label, message: `${label} runs through its own end ${[...own].join(", ")}: it reaches a side from the wrong direction. Use the side the line arrives at (or leaves from) along its route.` });
        }
        if (hit.size) {
          out.push({ rule: "crosses-node", connector: label, message: `${label} runs through ${[...hit].join(", ")}, which it does not join. Move the nodes so the path is clear, set the sides facing each other, or route around with waypoints.` });
        }
      }
    }
  }
  return out;
}
