// SPDX-License-Identifier: MIT
/**
 * The outline of every FigJam shape-with-text kind, as an SVG path in a `w`×`h` box at the
 * origin, and the area inside it where the shape's text wraps.
 *
 * Each outline follows FigJam's own drawing of the shape, measured from shapes drawn through the
 * Plugin API (2026-10-08): its proportions (how far a parallelogram leans, how deep a chevron's
 * notch is) are fractions of the box, so they scale as FigJam's do when a shape is resized.
 */

export interface ShapeGeometry {
  /** The fill-and-stroke outline. */
  d: string;
  /** Extra strokes drawn over the fill (a database's rim, a document stack's back sheets). */
  details?: string;
  /** Where the text wraps, inside the box. */
  text: { x: number; y: number; w: number; h: number };
}

const f = (n: number) => +n.toFixed(2);
const poly = (pts: [number, number][]) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(" L")} Z`;
const inset = (w: number, h: number, fx: number, fy = fx) => ({ x: w * fx, y: h * fy, w: w * (1 - 2 * fx), h: h * (1 - 2 * fy) });

/** Points around a centre, first at the top, then scaled so their bounds fill the box exactly. */
function fitted(radii: number[], w: number, h: number): [number, number][] {
  const n = radii.length;
  const raw = radii.map((r, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
  const xs = raw.map((p) => p[0]);
  const ys = raw.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return raw.map(([x, y]) => [((x - x0) / (x1 - x0)) * w, ((y - y0) / (y1 - y0)) * h]);
}

/** A regular polygon with `n` corners, first at the top, filling the box as FigJam's do. */
const regular = (n: number, w: number, h: number): string => poly(fitted(Array(n).fill(1), w, h));

/** FigJam's five-pointed star, filling its box. */
const star = (w: number, h: number): string => poly(fitted(Array.from({ length: 10 }, (_, i) => (i % 2 ? 0.45 : 1)), w, h));

const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
  `M${f(cx - rx)} ${f(cy)} A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)} A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)} Z`;

const rounded = (w: number, h: number, r: number) => {
  r = Math.min(r, w / 2, h / 2);
  return `M${f(r)} 0 H${f(w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)} V${f(h - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w - r)} ${f(h)} H${f(r)} A${f(r)} ${f(r)} 0 0 1 0 ${f(h - r)} V${f(r)} A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0 Z`;
};

/** A sheet with a wavy bottom edge, the flowchart "document". */
const docSheet = (x: number, y: number, w: number, h: number) => {
  const wave = h * 0.1;
  return `M${f(x)} ${f(y)} H${f(x + w)} V${f(y + h - wave)} C${f(x + w * 0.75)} ${f(y + h - wave * 2.6)} ${f(x + w * 0.5)} ${f(y + h + wave * 0.6)} ${f(x)} ${f(y + h - wave * 0.6)} Z`;
};

export function shapeGeometry(kind: string, w: number, h: number): ShapeGeometry {
  const box = inset(w, h, 0.08);
  switch (kind) {
    case "ELLIPSE":
      return { d: ellipse(w / 2, h / 2, w / 2, h / 2), text: inset(w, h, 0.15) };
    case "ROUNDED_RECTANGLE":
      return { d: rounded(w, h, Math.min(w, h) * 0.28), text: box };
    case "DIAMOND":
      return { d: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]), text: inset(w, h, 0.25) };
    case "TRIANGLE_UP":
      return { d: poly([[w / 2, 0], [w, h], [0, h]]), text: { x: w * 0.25, y: h * 0.45, w: w * 0.5, h: h * 0.5 } };
    case "TRIANGLE_DOWN":
      return { d: poly([[0, 0], [w, 0], [w / 2, h]]), text: { x: w * 0.25, y: h * 0.05, w: w * 0.5, h: h * 0.5 } };
    case "PARALLELOGRAM_RIGHT":
      return { d: poly([[w * 0.18, 0], [w, 0], [w * 0.82, h], [0, h]]), text: inset(w, h, 0.2, 0.08) };
    case "PARALLELOGRAM_LEFT":
      return { d: poly([[0, 0], [w * 0.82, 0], [w, h], [w * 0.18, h]]), text: inset(w, h, 0.2, 0.08) };
    case "TRAPEZOID":
      // Wide at the top, as FigJam draws it.
      return { d: poly([[0, 0], [w, 0], [w * 0.86, h], [w * 0.14, h]]), text: inset(w, h, 0.18, 0.08) };
    case "HEXAGON":
      return { d: poly([[w * 0.13, 0], [w * 0.87, 0], [w, h / 2], [w * 0.87, h], [w * 0.13, h], [0, h / 2]]), text: inset(w, h, 0.15, 0.08) };
    case "PENTAGON":
      return { d: regular(5, w, h), text: inset(w, h, 0.2) };
    case "OCTAGON":
      return {
        d: poly([[w * 0.25, 0], [w * 0.75, 0], [w, h * 0.25], [w, h * 0.75], [w * 0.75, h], [w * 0.25, h], [0, h * 0.75], [0, h * 0.25]]),
        text: inset(w, h, 0.12),
      };
    case "STAR":
      return { d: star(w, h), text: { x: w * 0.3, y: h * 0.4, w: w * 0.4, h: h * 0.38 } };
    case "PLUS": {
      const [a, b] = [0.28, 0.72];
      return {
        d: poly([[w * a, 0], [w * b, 0], [w * b, h * a], [w, h * a], [w, h * b], [w * b, h * b], [w * b, h], [w * a, h], [w * a, h * b], [0, h * b], [0, h * a], [w * a, h * a]]),
        text: { x: w * a, y: h * a, w: w * (b - a), h: h * (b - a) },
      };
    }
    case "CHEVRON":
      return { d: poly([[0, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [0, h], [w * 0.25, h / 2]]), text: inset(w, h, 0.25, 0.08) };
    case "ARROW_RIGHT":
      // A head three-quarters of the shape long, on a shaft half its height.
      return {
        d: poly([[0, h * 0.25], [w * 0.25, h * 0.25], [w * 0.25, 0], [w, h / 2], [w * 0.25, h], [w * 0.25, h * 0.75], [0, h * 0.75]]),
        text: { x: w * 0.05, y: h * 0.25, w: w * 0.7, h: h * 0.5 },
      };
    case "ARROW_LEFT":
      return {
        d: poly([[w, h * 0.25], [w * 0.75, h * 0.25], [w * 0.75, 0], [0, h / 2], [w * 0.75, h], [w * 0.75, h * 0.75], [w, h * 0.75]]),
        text: { x: w * 0.25, y: h * 0.25, w: w * 0.7, h: h * 0.5 },
      };
    case "SHIELD":
      // Straight sides, then a V to the bottom centre.
      return { d: poly([[0, 0], [w, 0], [w, h * 0.68], [w / 2, h], [0, h * 0.68]]), text: inset(w, h, 0.12, 0.08) };
    case "SPEECH_BUBBLE": {
      const r = Math.min(w, h) * 0.2;
      const b = h * 0.85;
      return {
        d: `M${f(r)} 0 H${f(w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)} V${f(b - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w - r)} ${f(b)} H${f(w * 0.36)} L${f(w * 0.22)} ${f(h)} V${f(b)} H${f(r)} A${f(r)} ${f(r)} 0 0 1 0 ${f(b - r)} V${f(r)} A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0 Z`,
        text: { x: w * 0.08, y: h * 0.06, w: w * 0.84, h: h * 0.72 },
      };
    }
    case "PREDEFINED_PROCESS":
      return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]), details: `M${f(w * 0.1)} 0 V${f(h)} M${f(w * 0.9)} 0 V${f(h)}`, text: inset(w, h, 0.14, 0.08) };
    case "INTERNAL_STORAGE":
      return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]), details: `M${f(w * 0.09)} 0 V${f(h)} M0 ${f(h * 0.09)} H${f(w)}`, text: { x: w * 0.12, y: h * 0.12, w: w * 0.84, h: h * 0.84 } };
    case "MANUAL_INPUT":
      // High on the left, sloping down to the right.
      return { d: poly([[0, 0], [w, h * 0.17], [w, h], [0, h]]), text: { x: w * 0.08, y: h * 0.22, w: w * 0.84, h: h * 0.7 } };
    case "DOCUMENT_SINGLE":
      return { d: docSheet(0, 0, w, h), text: { x: w * 0.08, y: h * 0.06, w: w * 0.84, h: h * 0.74 } };
    case "DOCUMENT_MULTIPLE": {
      // The front sheet, with a second sheet behind it showing above and to the left.
      const o = Math.min(w, h) * 0.09;
      return {
        d: docSheet(o, o, w - o, h - o),
        details: `M${f(o)} ${f(h * 0.8)} H0 V0 H${f(w * 0.9)} V${f(o)}`,
        text: { x: o + w * 0.06, y: o + h * 0.06, w: w * 0.78, h: h * 0.66 },
      };
    }
    case "SUMMING_JUNCTION": {
      const k = Math.SQRT1_2 / 2;
      return {
        d: ellipse(w / 2, h / 2, w / 2, h / 2),
        details: `M${f(w / 2 - w * k)} ${f(h / 2 - h * k)} L${f(w / 2 + w * k)} ${f(h / 2 + h * k)} M${f(w / 2 + w * k)} ${f(h / 2 - h * k)} L${f(w / 2 - w * k)} ${f(h / 2 + h * k)}`,
        text: inset(w, h, 0.3),
      };
    }
    case "OR":
      return { d: ellipse(w / 2, h / 2, w / 2, h / 2), details: `M${f(w / 2)} 0 V${f(h)} M0 ${f(h / 2)} H${f(w)}`, text: inset(w, h, 0.3) };
    case "ENG_DATABASE": {
      const ry = Math.min(h * 0.13, w * 0.25);
      return {
        d: `M0 ${f(ry)} A${f(w / 2)} ${f(ry)} 0 0 1 ${f(w)} ${f(ry)} V${f(h - ry)} A${f(w / 2)} ${f(ry)} 0 0 1 0 ${f(h - ry)} Z`,
        details: `M0 ${f(ry)} A${f(w / 2)} ${f(ry)} 0 0 0 ${f(w)} ${f(ry)}`,
        text: { x: w * 0.08, y: ry * 2.2, w: w * 0.84, h: h - ry * 3.4 },
      };
    }
    case "ENG_QUEUE": {
      const rx = Math.min(w * 0.12, h * 0.25);
      return {
        d: `M${f(rx)} 0 H${f(w - rx)} A${f(rx)} ${f(h / 2)} 0 0 1 ${f(w - rx)} ${f(h)} H${f(rx)} A${f(rx)} ${f(h / 2)} 0 0 1 ${f(rx)} 0 Z`,
        details: `M${f(w - rx)} 0 A${f(rx)} ${f(h / 2)} 0 0 0 ${f(w - rx)} ${f(h)}`,
        text: { x: rx * 1.2, y: h * 0.08, w: w - rx * 3.4, h: h * 0.84 },
      };
    }
    case "ENG_FILE": {
      const c = Math.min(w, h) * 0.29;
      return {
        d: poly([[0, 0], [w - c, 0], [w, c], [w, h], [0, h]]),
        details: `M${f(w - c)} 0 V${f(c)} H${f(w)}`,
        text: { x: w * 0.08, y: c, w: w * 0.84, h: h - c * 1.4 },
      };
    }
    case "ENG_FOLDER": {
      // A tab across the left half, its right edge slanting down to the body.
      const t = h * 0.25;
      return {
        d: poly([[w * 0.05, 0], [w * 0.47, 0], [w * 0.57, t], [w, t], [w, h], [0, h], [0, t]]),
        details: `M0 ${f(t)} H${f(w * 0.57)}`,
        text: { x: w * 0.08, y: t * 1.2, w: w * 0.84, h: h - t * 1.4 },
      };
    }
    case "SQUARE":
    default:
      return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]), text: box };
  }
}
