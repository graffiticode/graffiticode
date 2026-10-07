// SPDX-License-Identifier: MIT
/**
 * The outline of every FigJam shape-with-text kind, as an SVG path in a `w`×`h` box at the
 * origin, and the area inside it where the shape's text wraps.
 *
 * Each outline follows FigJam's own drawing of the shape: its proportions (how far a
 * parallelogram leans, how deep a chevron's notch is) are fractions of the box so they scale
 * as FigJam's do when a shape is resized.
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

/** A regular polygon with `n` corners, the first at the top, stretched to the box. */
function regular(n: number, w: number, h: number, rotate = 0): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + rotate + (i * 2 * Math.PI) / n;
    pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)]);
  }
  return poly(pts);
}

function star(w: number, h: number): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 0.4 : 1;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push([w / 2 + (w / 2) * r * Math.cos(a), h * 0.53 + (h / 2) * r * Math.sin(a)]);
  }
  return poly(pts);
}

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
      return { d: rounded(w, h, Math.min(w, h) * 0.2), text: box };
    case "DIAMOND":
      return { d: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]), text: inset(w, h, 0.25) };
    case "TRIANGLE_UP":
      return { d: poly([[w / 2, 0], [w, h], [0, h]]), text: { x: w * 0.25, y: h * 0.45, w: w * 0.5, h: h * 0.5 } };
    case "TRIANGLE_DOWN":
      return { d: poly([[0, 0], [w, 0], [w / 2, h]]), text: { x: w * 0.25, y: h * 0.05, w: w * 0.5, h: h * 0.5 } };
    case "PARALLELOGRAM_RIGHT":
      return { d: poly([[w * 0.25, 0], [w, 0], [w * 0.75, h], [0, h]]), text: inset(w, h, 0.2, 0.08) };
    case "PARALLELOGRAM_LEFT":
      return { d: poly([[0, 0], [w * 0.75, 0], [w, h], [w * 0.25, h]]), text: inset(w, h, 0.2, 0.08) };
    case "TRAPEZOID":
      return { d: poly([[w * 0.2, 0], [w * 0.8, 0], [w, h], [0, h]]), text: inset(w, h, 0.2, 0.08) };
    case "HEXAGON":
      return { d: poly([[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]]), text: inset(w, h, 0.2, 0.08) };
    case "PENTAGON":
      return { d: regular(5, w, h), text: inset(w, h, 0.2) };
    case "OCTAGON":
      return {
        d: poly([[w * 0.29, 0], [w * 0.71, 0], [w, h * 0.29], [w, h * 0.71], [w * 0.71, h], [w * 0.29, h], [0, h * 0.71], [0, h * 0.29]]),
        text: inset(w, h, 0.12),
      };
    case "STAR":
      return { d: star(w, h), text: { x: w * 0.3, y: h * 0.38, w: w * 0.4, h: h * 0.38 } };
    case "PLUS":
      return {
        d: poly([[w / 3, 0], [(2 * w) / 3, 0], [(2 * w) / 3, h / 3], [w, h / 3], [w, (2 * h) / 3], [(2 * w) / 3, (2 * h) / 3], [(2 * w) / 3, h], [w / 3, h], [w / 3, (2 * h) / 3], [0, (2 * h) / 3], [0, h / 3], [w / 3, h / 3]]),
        text: { x: w / 3, y: h / 3, w: w / 3, h: h / 3 },
      };
    case "CHEVRON":
      return { d: poly([[0, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [0, h], [w * 0.25, h / 2]]), text: inset(w, h, 0.25, 0.08) };
    case "ARROW_RIGHT":
      return {
        d: poly([[0, h * 0.25], [w * 0.6, h * 0.25], [w * 0.6, 0], [w, h / 2], [w * 0.6, h], [w * 0.6, h * 0.75], [0, h * 0.75]]),
        text: { x: w * 0.05, y: h * 0.25, w: w * 0.6, h: h * 0.5 },
      };
    case "ARROW_LEFT":
      return {
        d: poly([[w, h * 0.25], [w * 0.4, h * 0.25], [w * 0.4, 0], [0, h / 2], [w * 0.4, h], [w * 0.4, h * 0.75], [w, h * 0.75]]),
        text: { x: w * 0.35, y: h * 0.25, w: w * 0.6, h: h * 0.5 },
      };
    case "SHIELD":
      return {
        d: `M0 0 H${f(w)} V${f(h * 0.45)} C${f(w)} ${f(h * 0.75)} ${f(w * 0.75)} ${f(h * 0.9)} ${f(w / 2)} ${f(h)} C${f(w * 0.25)} ${f(h * 0.9)} 0 ${f(h * 0.75)} 0 ${f(h * 0.45)} Z`,
        text: inset(w, h, 0.12, 0.08),
      };
    case "SPEECH_BUBBLE":
      return {
        d: `M0 0 H${f(w)} V${f(h * 0.8)} H${f(w * 0.4)} L${f(w * 0.2)} ${f(h)} V${f(h * 0.8)} H0 Z`,
        text: { x: w * 0.08, y: h * 0.06, w: w * 0.84, h: h * 0.68 },
      };
    case "PREDEFINED_PROCESS":
      return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]), details: `M${f(w * 0.12)} 0 V${f(h)} M${f(w * 0.88)} 0 V${f(h)}`, text: inset(w, h, 0.15, 0.08) };
    case "INTERNAL_STORAGE":
      return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]), details: `M${f(w * 0.15)} 0 V${f(h)} M0 ${f(h * 0.15)} H${f(w)}`, text: { x: w * 0.2, y: h * 0.2, w: w * 0.75, h: h * 0.75 } };
    case "MANUAL_INPUT":
      return { d: poly([[0, h * 0.25], [w, 0], [w, h], [0, h]]), text: { x: w * 0.08, y: h * 0.3, w: w * 0.84, h: h * 0.62 } };
    case "DOCUMENT_SINGLE":
      return { d: docSheet(0, 0, w, h), text: { x: w * 0.08, y: h * 0.06, w: w * 0.84, h: h * 0.74 } };
    case "DOCUMENT_MULTIPLE": {
      const o = Math.min(w, h) * 0.06;
      return {
        d: docSheet(0, 2 * o, w - 2 * o, h - 2 * o),
        details: `M${f(o)} ${f(2 * o)} V${f(o)} H${f(w - o)} V${f(h - 3 * o)} M${f(2 * o)} ${f(o)} V0 H${f(w)} V${f(h - 4 * o)}`,
        text: { x: w * 0.06, y: h * 0.14, w: w * 0.76, h: h * 0.66 },
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
      const ry = Math.min(h * 0.12, w * 0.25);
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
      const c = Math.min(w, h) * 0.22;
      return {
        d: poly([[0, 0], [w - c, 0], [w, c], [w, h], [0, h]]),
        details: `M${f(w - c)} 0 V${f(c)} H${f(w)}`,
        text: { x: w * 0.08, y: c, w: w * 0.84, h: h - c * 1.4 },
      };
    }
    case "ENG_FOLDER": {
      const t = h * 0.14;
      return {
        d: poly([[0, 0], [w * 0.4, 0], [w * 0.48, t], [w, t], [w, h], [0, h]]),
        details: `M0 ${f(t)} H${f(w * 0.48)}`,
        text: { x: w * 0.08, y: t * 1.4, w: w * 0.84, h: h - t * 2 },
      };
    }
    case "SQUARE":
    default:
      return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]), text: box };
  }
}
