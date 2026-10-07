// SPDX-License-Identifier: MIT
/**
 * What FigJam (through the Graffiticode FigJam plugin) draws when a node leaves something out.
 *
 * The preview is only as faithful as these numbers, so they live in one place. Where the plugin
 * sets a value itself (`figma-plugin/src/code.ts`) it is copied exactly and says so; the rest are
 * FigJam's own defaults for a node the plugin API creates, and are what the fidelity check —
 * a fixture board drawn by the plugin and by this view, compared side by side — calibrates.
 */

/** The plugin's colour names (`namedColors` in code.ts). */
export const NAMED_COLORS: Record<string, string> = {
  red: "#ef4444",
  blue: "#3b82f6",
  green: "#22c55e",
  yellow: "#eab308",
  purple: "#a855f7",
  orange: "#f97316",
  pink: "#ec4899",
  white: "#ffffff",
  black: "#000000",
  gray: "#6b7280",
};

/** The plugin's fallback for a colour it cannot read: grey 0.5. */
export const UNKNOWN_COLOR = "#808080";

/** The plugin's stamp glyphs (`STAMP_GLYPH` in code.ts), for the stamps L0186 can name. */
export const STAMP_GLYPHS: Record<string, string> = {
  like: "👍",
  love: "❤️",
  heart: "❤️",
  celebrate: "🎉",
  laugh: "😂",
  surprised: "😮",
};

export const FONT_FAMILY = '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const FONT_WEIGHT = 500; // the plugin loads Inter Medium for every text it writes

export const CANVAS = { background: "#f5f5f5", dot: "#d4d4d4", grid: 24 };

export const STICKY = {
  size: 240,
  fill: "#fff1a8",
  fontSize: 24,
  minFontSize: 10,
  padding: 24,
  lineHeight: 1.25,
  shadow: "drop-shadow(0 1px 2px rgba(0,0,0,0.12)) drop-shadow(0 2px 6px rgba(0,0,0,0.08))",
};

export const SHAPE = {
  width: 200,
  height: 200,
  fill: "#e6e6e6",
  fontSize: 16,
  padding: 16,
  lineHeight: 1.3,
  strokeWidth: 2, // applyStroke's fallback when a stroke colour is given without a width
};

export const TEXT = { fontSize: 12, color: "#000000", lineHeight: 1.3 };

export const SECTION = {
  /** Padding around a section's children, when it is sized to fit them (code.ts PAD). */
  padding: 24,
  /** Size of a section created with no children and no size. */
  width: 100,
  height: 100,
  fill: "#ffffff",
  stroke: "#e6e6e6",
  radius: 8,
  label: { fontSize: 14, height: 28, color: "#1e1e1e", fill: "#ffffff" },
};

/** The plugin's stamp: a 40px white circle, 1px light grey ring, 22px glyph. */
export const STAMP = { size: 40, fill: "#ffffff", stroke: "#d9d9d9", glyphSize: 22 };

export const CONNECTOR = {
  stroke: "#1e1e1e",
  strokeWidth: 4, // the plugin pins 4 before applyStroke
  dash: [8, 4],
  fontSize: 16,
  label: { padX: 8, padY: 4, fill: "#ffffff", color: "#1e1e1e" },
  /** How far an elbowed connector runs straight out of a side before it turns. */
  stub: 24,
};

/** Resolve a colour the way the plugin does: hex as given, a known name, otherwise grey. */
export function resolveColor(c: unknown): string {
  if (typeof c !== "string") return UNKNOWN_COLOR;
  const t = c.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) return t;
  return NAMED_COLORS[t.toLowerCase()] ?? UNKNOWN_COLOR;
}

/** `#rgb`/`#rrggbb` → [r, g, b] in 0..255. */
function rgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** The plugin's `darken`: every channel × 0.65 — the outline it derives from a fill. */
export function darken(hex: string, factor = 0.65): string {
  return `#${rgb(hex)
    .map((v) => Math.round(v * factor).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Opacity on the plugin's 0–100 scale, as an SVG opacity. */
export const opacityOf = (o: unknown): number | undefined =>
  o == null ? undefined : Math.max(0, Math.min(1, Number(o) / 100));
