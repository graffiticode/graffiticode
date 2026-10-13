// SPDX-License-Identifier: MIT
/**
 * Text measurement and wrapping, so text breaks where FigJam breaks it.
 *
 * SVG has no text wrapping, so lines are laid out here. Width comes from a canvas measuring
 * Inter Medium when one is available, and from an average glyph width otherwise (jsdom, SSR);
 * the layout never depends on which, only on `measure`.
 */
import { FONT_FAMILY, FONT_WEIGHT } from "./figjam";

export type Measure = (text: string, fontSize: number) => number;

/** Inter Medium's average advance is a little over half the font size. */
export const estimate: Measure = (text, fontSize) => [...text].length * fontSize * 0.56;

let ctx: CanvasRenderingContext2D | null | undefined;

/** Measure with a canvas when the platform has one; fall back to `estimate`. */
export const measure: Measure = (text, fontSize) => {
  if (ctx === undefined) {
    ctx = null;
    try {
      const jsdom = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
      if (!jsdom && typeof document !== "undefined") ctx = document.createElement("canvas").getContext("2d");
    } catch {
      ctx = null;
    }
  }
  if (!ctx) return estimate(text, fontSize);
  ctx.font = `${FONT_WEIGHT} ${fontSize}px ${FONT_FAMILY}`;
  return ctx.measureText(text).width;
};

/** Break `text` into lines no wider than `width`, splitting long words where they must. */
export function wrap(text: string, width: number, fontSize: number, m: Measure = measure): string[] {
  const out: string[] = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (m(next, fontSize) <= width || !line) {
        line = next;
      } else {
        out.push(line);
        line = word;
      }
      // A single word wider than the line breaks by character, as FigJam breaks it.
      while (m(line, fontSize) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && m(line.slice(0, cut), fontSize) > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Fit text in a box: wrap at `fontSize`, shrinking (as a FigJam sticky does) until the lines fit
 * the box's height or `minSize` is reached.
 */
export function fit(
  text: string,
  box: { w: number; h: number },
  fontSize: number,
  lineHeight: number,
  opts: { shrink?: boolean; minSize?: number; measure?: Measure } = {},
): { lines: string[]; fontSize: number } {
  const m = opts.measure ?? measure;
  let size = fontSize;
  let lines = wrap(text, box.w, size, m);
  if (opts.shrink) {
    const min = opts.minSize ?? 8;
    while (size > min && lines.length * size * lineHeight > box.h) {
      size = Math.max(min, size - 2);
      lines = wrap(text, box.w, size, m);
    }
  }
  return { lines, fontSize: size };
}
