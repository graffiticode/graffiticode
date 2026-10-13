// SPDX-License-Identifier: MIT
/**
 * Where everything in a web goes. Pure geometry, tested without a DOM.
 *
 * Everything is in one square coordinate space, 0..1000 on each axis. The diagram is a square
 * box, so a node positioned at `left: x/10 %` and sized `width: w/10 %` lands exactly where the
 * SVG, drawn with `viewBox="0 0 1000 1000"`, puts its lines. There is no measurement, no
 * ResizeObserver, and nothing to recompute when the box resizes.
 */

export const SPACE = 1000;
const CENTRE = SPACE / 2;
const PAD = 16;

export interface LayoutNode {
  id: string;
  shape?: string;
  size?: string;
}

export interface Box {
  id: string;
  /** Centre. */
  x: number;
  y: number;
  w: number;
  h: number;
  shape: string;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The midpoint of the VISIBLE line — between the clipped ends, where a label belongs. */
  mx: number;
  my: number;
}

/** Width by size; the hub defaults larger than the rest. */
const WIDTH: Record<string, number> = { small: 150, medium: 190, large: 250 };

function dims(node: LayoutNode, fallback: string, cap: number): { w: number; h: number } {
  const w = Math.min(WIDTH[node.size || fallback] ?? WIDTH.medium, cap);
  const shape = node.shape || "rounded";
  return { w, h: shape === "circle" ? w : Math.round(w * 0.56) };
}

/**
 * The hub in the centre and the other nodes evenly on a circle, the first at the top and the
 * rest clockwise.
 *
 * Nodes shrink when the ring gets crowded: a node is never wider than 85% of the arc between
 * neighbours, so twelve nodes stay apart where L0169's fixed size had them overlap.
 */
export function layout(hub: LayoutNode, nodes: LayoutNode[]): Box[] {
  const n = nodes.length;
  const widest = Math.max(...nodes.map((d) => WIDTH[d.size || "medium"] ?? WIDTH.medium));
  let radius = CENTRE - widest / 2 - PAD;
  const arc = n > 1 ? (2 * Math.PI * radius) / n : Infinity;
  const cap = Math.max(90, Math.floor(arc * 0.85));
  const outer = nodes.map((d) => dims(d, "medium", cap));
  const tallest = Math.max(...outer.map((d) => d.h), 0);
  const widestNow = Math.max(...outer.map((d) => d.w), 0);
  radius = CENTRE - Math.max(widestNow, tallest) / 2 - PAD;
  const hubDims = dims(hub, "large", Math.min(WIDTH.large, radius));
  const boxes: Box[] = [
    { id: hub.id, x: CENTRE, y: CENTRE, ...hubDims, shape: hub.shape || "rounded" },
  ];
  nodes.forEach((d, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    boxes.push({
      id: d.id,
      x: Math.round(CENTRE + radius * Math.cos(angle)),
      y: Math.round(CENTRE + radius * Math.sin(angle)),
      ...outer[i],
      shape: d.shape || "rounded",
    });
  });
  return boxes;
}

/**
 * Where the ray from a box's centre toward (tx, ty) leaves the box. A circle is an ellipse;
 * every other shape is treated as its bounding rectangle, which is exact for `rect` and within
 * a corner radius for `rounded` and `pill`.
 */
export function exitPoint(box: Box, tx: number, ty: number): { x: number; y: number } {
  const dx = tx - box.x;
  const dy = ty - box.y;
  if (dx === 0 && dy === 0) return { x: box.x, y: box.y };
  const a = box.w / 2;
  const b = box.h / 2;
  let t: number;
  if (box.shape === "circle") {
    t = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b));
  } else {
    t = Math.min(dx === 0 ? Infinity : a / Math.abs(dx), dy === 0 ? Infinity : b / Math.abs(dy));
  }
  return { x: box.x + dx * t, y: box.y + dy * t };
}

/** The visible line between two boxes, clipped to both outlines. */
export function segment(from: Box, to: Box, gap = 6): Segment {
  const p = exitPoint(from, to.x, to.y);
  const q = exitPoint(to, from.x, from.y);
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const ux = (q.x - p.x) / len;
  const uy = (q.y - p.y) / len;
  const x1 = p.x + ux * gap;
  const y1 = p.y + uy * gap;
  const x2 = q.x - ux * gap;
  const y2 = q.y - uy * gap;
  return { x1, y1, x2, y2, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
}
