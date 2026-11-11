// SPDX-License-Identifier: MIT
/**
 * Plane geometry for the concept web: points, boxes, and quadratic Béziers. Pure, tested
 * without a DOM. Units are CSS pixels.
 */

export interface Pt {
  x: number;
  y: number;
}

/** A node or label: its centre and size. A `circle` is an ellipse; every other shape a rectangle. */
export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: string;
}

/** A quadratic Bézier: two ends and a control point. A straight line has `c` on the chord. */
export interface Quad {
  p0: Pt;
  c: Pt;
  p2: Pt;
}

export const EPS = 1e-6;

/** Half the box's diagonal: no point of the box is farther than this from its centre. */
export function halfDiagonal(b: { w: number; h: number; shape?: string }): number {
  return b.shape === "circle" ? Math.max(b.w, b.h) / 2 : Math.hypot(b.w, b.h) / 2;
}

/** Whether two boxes come within `gap` of each other. Circles are tested as their rectangles. */
export function boxesOverlap(a: Box, b: Box, gap = 0): boolean {
  return (
    Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap - EPS &&
    Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap - EPS
  );
}

// ---- Quadratic Béziers ---------------------------------------------------------------------

/**
 * The blossom of a quadratic: b(t, t) is the point at t, and b(u, v) is the control point of the
 * sub-curve [u, v]. This is de Casteljau's subdivision written in closed form.
 */
function blossom(q: Quad, u: number, v: number): Pt {
  const a = (1 - u) * (1 - v);
  const m = (1 - u) * v + u * (1 - v);
  const z = u * v;
  return { x: a * q.p0.x + m * q.c.x + z * q.p2.x, y: a * q.p0.y + m * q.c.y + z * q.p2.y };
}

export function pointAt(q: Quad, t: number): Pt {
  return blossom(q, t, t);
}

export function derivAt(q: Quad, t: number): Pt {
  return {
    x: 2 * (1 - t) * (q.c.x - q.p0.x) + 2 * t * (q.p2.x - q.c.x),
    y: 2 * (1 - t) * (q.c.y - q.p0.y) + 2 * t * (q.p2.y - q.c.y),
  };
}

/** The part of `q` between t0 and t1, exactly: every point of it lies on `q`. */
export function subCurve(q: Quad, t0: number, t1: number): Quad {
  return { p0: blossom(q, t0, t0), c: blossom(q, t0, t1), p2: blossom(q, t1, t1) };
}

export function reverse(q: Quad): Quad {
  return { p0: q.p2, c: q.c, p2: q.p0 };
}

export function straight(p0: Pt, p2: Pt): Quad {
  return { p0, c: { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 }, p2 };
}

/** The interior parameter where the curve turns on one axis, if it does. */
export function extremumT(q: Quad, axis: "x" | "y"): number | undefined {
  const d = q.p0[axis] - 2 * q.c[axis] + q.p2[axis];
  if (Math.abs(d) < EPS) return undefined;
  const t = (q.p0[axis] - q.c[axis]) / d;
  return t > EPS && t < 1 - EPS ? t : undefined;
}

/** Roots of a·t² + b·t + c, written into `out` (at most two); returns how many. NaN-free. */
function roots(a: number, b: number, c: number, out: Float64Array): number {
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return 0;
    out[0] = -c / b;
    return 1;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return 0;
  const s = Math.sqrt(disc);
  out[0] = (-b - s) / (2 * a);
  out[1] = (-b + s) / (2 * a);
  return 2;
}

const ROOTS = new Float64Array(2);

function inside(box: Box, p: Pt): boolean {
  const a = box.w / 2;
  const b = box.h / 2;
  const dx = p.x - box.x;
  const dy = p.y - box.y;
  if (box.shape === "circle") return (dx * dx) / (a * a) + (dy * dy) / (b * b) < 1;
  return Math.abs(dx) < a && Math.abs(dy) < b;
}

/**
 * The first parameter at which `q`, starting inside `box`, crosses its outline. Exact for a
 * rectangle (each side is a quadratic in t); bisection for an ellipse. 0 if the curve does not
 * start inside, 1 if it never leaves.
 */
export function exitParam(q: Quad, box: Box): number {
  if (!inside(box, q.p0)) return 0;
  if (box.shape === "circle") {
    const N = 64;
    let lo = 0;
    let hi = -1;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      if (!inside(box, pointAt(q, t))) {
        hi = t;
        break;
      }
      lo = t;
    }
    if (hi < 0) return 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (inside(box, pointAt(q, mid))) lo = mid;
      else hi = mid;
    }
    return hi;
  }
  let best = 1;
  for (const axis of ["x", "y"] as const) {
    const other = axis === "x" ? "y" : "x";
    const half = axis === "x" ? box.w / 2 : box.h / 2;
    const halfOther = axis === "x" ? box.h / 2 : box.w / 2;
    const centre = axis === "x" ? box.x : box.y;
    const centreOther = axis === "x" ? box.y : box.x;
    const a = q.p0[axis] - 2 * q.c[axis] + q.p2[axis];
    const b = 2 * (q.c[axis] - q.p0[axis]);
    for (let side = centre - half, k = 0; k < 2; k++, side = centre + half) {
      const n = roots(a, b, q.p0[axis] - side, ROOTS);
      for (let r = 0; r < n; r++) {
        const t = ROOTS[r];
        if (t <= EPS || t > 1 + EPS || t >= best) continue;
        const u = 1 - t;
        const o = u * u * q.p0[other] + 2 * u * t * q.c[other] + t * t * q.p2[other];
        if (Math.abs(o - centreOther) <= halfOther + 1e-6) best = Math.min(1, t);
      }
    }
  }
  return best;
}

/** The last parameter at which `q`, ending inside `box`, crosses into it. */
export function enterParam(q: Quad, box: Box): number {
  return 1 - exitParam(reverse(q), box);
}

/** Move a parameter by an arc length `d` (positive forward), by Newton steps on |B'|. */
export function advance(q: Quad, t: number, d: number): number {
  let s = t;
  for (let i = 0; i < 3; i++) {
    const v = derivAt(q, s);
    const speed = Math.hypot(v.x, v.y);
    if (speed < EPS) break;
    s = t + d / speed;
  }
  return Math.min(1, Math.max(0, s));
}

/** Liang–Barsky: does the segment a→b meet the axis-aligned box (half sizes hw, hh) at (cx, cy)? */
export function segmentHitsRect(a: Pt, b: Pt, cx: number, cy: number, hw: number, hh: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, a.x - (cx - hw)) &&
    clip(dx, cx + hw - a.x) &&
    clip(-dy, a.y - (cy - hh)) &&
    clip(dy, cy + hh - a.y) &&
    t0 <= t1
  );
}

/** Axis-aligned bounds of the curve between t0 and t1 (its ends and any turning points). */
export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function curveBounds(q: Quad, t0 = 0, t1 = 1): Bounds {
  const a = pointAt(q, t0);
  const b = pointAt(q, t1);
  const out = {
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxY: Math.max(a.y, b.y),
  };
  for (const axis of ["x", "y"] as const) {
    const t = extremumT(q, axis);
    if (t === undefined || t <= t0 || t >= t1) continue;
    const p = pointAt(q, t);
    out.minX = Math.min(out.minX, p.x);
    out.maxX = Math.max(out.maxX, p.x);
    out.minY = Math.min(out.minY, p.y);
    out.maxY = Math.max(out.maxY, p.y);
  }
  return out;
}

const SAMPLES = 24;

/** A curve flattened once, for testing against many boxes. */
export interface Flat {
  /** x0, y0, x1, y1, … */
  pts: Float64Array;
  bounds: Bounds;
}

/**
 * Boxes bucketed on a uniform grid, so a curve is tested only against the boxes near its own
 * segments rather than every box in the web.
 */
export class BoxGrid {
  private cells = new Map<number, number[]>();
  constructor(
    readonly boxes: Box[],
    private size: number,
    private margin: number,
  ) {
    boxes.forEach((b, i) => {
      const [x0, x1, y0, y1] = this.span(b.x - b.w / 2, b.x + b.w / 2, b.y - b.h / 2, b.y + b.h / 2);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) this.bucket(x, y).push(i);
    });
  }
  private key(x: number, y: number) {
    return (x + 32768) * 65536 + (y + 32768);
  }
  private bucket(x: number, y: number) {
    const k = this.key(x, y);
    let c = this.cells.get(k);
    if (!c) this.cells.set(k, (c = []));
    return c;
  }
  private span(minX: number, maxX: number, minY: number, maxY: number) {
    const m = this.margin;
    const f = (v: number) => Math.floor(v / this.size);
    return [f(minX - m), f(maxX + m), f(minY - m), f(maxY + m)];
  }
  /** The first box (in grid order) the flattened curve hits, skipping `skip`. */
  firstHit(f: Flat, skip: (b: Box) => boolean): Box | undefined {
    const seen = new Set<number>();
    const p = f.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const [x0, x1, y0, y1] = this.span(Math.min(p[i], p[i + 2]), Math.max(p[i], p[i + 2]), Math.min(p[i + 1], p[i + 3]), Math.max(p[i + 1], p[i + 3]));
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const c = this.cells.get(this.key(x, y));
          if (!c) continue;
          for (const idx of c) {
            if (seen.has(idx)) continue;
            seen.add(idx);
            const b = this.boxes[idx];
            if (!skip(b) && flatHitsBox(f, b, this.margin)) return b;
          }
        }
    }
    return undefined;
  }
}

export function flatten(q: Quad, t0: number, t1: number, n = SAMPLES): Flat {
  const pts = new Float64Array(2 * (n + 1));
  for (let i = 0; i <= n; i++) {
    const p = pointAt(q, t0 + ((t1 - t0) * i) / n);
    pts[2 * i] = p.x;
    pts[2 * i + 1] = p.y;
  }
  return { pts, bounds: curveBounds(q, t0, t1) };
}

/** Does the flattened curve come within `margin` of the box? */
export function flatHitsBox(f: Flat, box: Box, margin: number): boolean {
  const hw = box.w / 2 + margin;
  const hh = box.h / 2 + margin;
  const x0 = box.x - hw;
  const x1 = box.x + hw;
  const y0 = box.y - hh;
  const y1 = box.y + hh;
  const bb = f.bounds;
  if (bb.maxX < x0 || bb.minX > x1 || bb.maxY < y0 || bb.minY > y1) return false;
  const p = f.pts;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i];
    const ay = p[i + 1];
    const bx = p[i + 2];
    const by = p[i + 3];
    // Reject the segment on its own bounds before the exact test.
    if ((ax < x0 && bx < x0) || (ax > x1 && bx > x1) || (ay < y0 && by < y0) || (ay > y1 && by > y1)) continue;
    if (segmentHitsRect({ x: ax, y: ay }, { x: bx, y: by }, box.x, box.y, hw, hh)) return true;
  }
  return false;
}

/**
 * Does the curve between t0 and t1 come within `margin` of the box? Tested as a fine polyline
 * against the box grown by `margin`.
 */
export function curveHitsBox(q: Quad, t0: number, t1: number, box: Box, margin: number): boolean {
  return flatHitsBox(flatten(q, t0, t1), box, margin);
}
