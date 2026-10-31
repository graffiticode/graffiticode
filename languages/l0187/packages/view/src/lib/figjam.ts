// SPDX-License-Identifier: MIT
/**
 * How FigJam paints what the compiler placed: colours, strokes and the canvas. Geometry is never
 * decided here — every box, line of text, route and label comes from the compiled board — so this
 * file holds only paint, as the Graffiticode FigJam plugin applies it (`figma-plugin/src/code.ts`)
 * and as L0186 measured FigJam's own defaults (2026-10-08).
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

export const FONT_FAMILY = '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const FONT_WEIGHT = 500; // the plugin loads Inter Medium for every text it writes

export const CANVAS = { background: "#f5f5f5", dot: "#d4d4d4", grid: 24 };

/** Text on stickies and shapes: black at 80%, FigJam's own default. */
export const NODE_TEXT_COLOR = "rgba(0, 0, 0, 0.8)";

export const STICKY = {
  fill: "#e6e6e6", // FigJam's gray sticky
  shadow: "drop-shadow(0 1px 2px rgba(0,0,0,0.12)) drop-shadow(0 2px 6px rgba(0,0,0,0.08))",
};

export const SHAPE = { fill: "#ffffff", stroke: "#757575", strokeWidth: 4 };

export const TEXT = { color: "#1e1e1e" };

export const SECTION = {
  fill: "#ffffff",
  stroke: "#e6e6e6",
  radius: 8,
  label: { fontSize: 14, color: "#1e1e1e", fill: "#ffffff" },
};

export const CONNECTOR = {
  stroke: "#757575",
  dash: [8, 4],
  label: { color: "#1e1e1e" },
  /** The radius the plugin rounds a turn at a waypoint with (code.ts CORNER_RADIUS). */
  cornerRadius: 16,
  /** The gap FigJam leaves between a mark and the end of a connector attached to it. */
  endpointGap: 8,
};

/** Resolve a colour the way the plugin does: hex as given, a known name, otherwise grey. */
export function resolveColor(c: unknown): string {
  if (typeof c !== "string") return UNKNOWN_COLOR;
  const t = c.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) return t;
  return NAMED_COLORS[t.toLowerCase()] ?? UNKNOWN_COLOR;
}

/** Opacity on the plugin's 0–100 scale, as an SVG opacity. */
export const opacityOf = (o: unknown): number | undefined =>
  o == null ? undefined : Math.max(0, Math.min(1, Number(o) / 100));
