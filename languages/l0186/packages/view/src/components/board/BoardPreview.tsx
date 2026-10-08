// SPDX-License-Identifier: MIT
/**
 * One page of a board, drawn as FigJam draws it.
 *
 * Geometry comes from `lib/layout.ts` (the plugin's placement rules) and every default from
 * `lib/figjam.ts`; this file only paints. Drawing order is the plugin's: nodes in program order,
 * a section under its own children, connectors last, on top of everything.
 *
 * The canvas pans by dragging and zooms with ctrl/⌘ + wheel or a pinch, and the buttons zoom
 * and fit. A plain wheel is left to the page, so an embedded board never traps scrolling.
 */
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { CANVAS, CONNECTOR, FONT_FAMILY, FONT_WEIGHT, NODE_TEXT_COLOR, SECTION, SHAPE, STAMP, STAMP_GLYPHS, STICKY, TEXT, TEXTLESS_SHAPES, UNKNOWN_COLOR, darken, opacityOf, resolveColor } from "../../lib/figjam";
import { layoutPage, type Box, type Placed, type Route } from "../../lib/layout";
import { shapeGeometry } from "../../lib/shapes";
import { fit, measure, wrap } from "../../lib/text";

const MARGIN = 48;

/** Lines of text in a box, horizontally `align`ed and vertically centred or top-aligned. */
function TextBlock({
  lines,
  box,
  fontSize,
  lineHeight,
  color,
  align = "center",
  valign = "middle",
}: {
  lines: string[];
  box: { x: number; y: number; w: number; h: number };
  fontSize: number;
  lineHeight: number;
  color: string;
  align?: "start" | "center";
  valign?: "top" | "middle";
}) {
  const lh = fontSize * lineHeight;
  const total = lines.length * lh;
  const top = valign === "middle" ? box.y + (box.h - total) / 2 : box.y;
  const x = align === "center" ? box.x + box.w / 2 : box.x;
  return (
    <text
      x={x}
      fontFamily={FONT_FAMILY}
      fontWeight={FONT_WEIGHT}
      fontSize={fontSize}
      fill={color}
      textAnchor={align === "center" ? "middle" : "start"}
    >
      {lines.map((l, i) => (
        <tspan key={i} x={x} y={top + i * lh + lh / 2} dominantBaseline="central">
          {l || " "}
        </tspan>
      ))}
    </text>
  );
}

/**
 * The outline a shape gets, as the plugin's applyStroke leaves it: an explicit stroke at its width
 * (or FigJam's 4); with only a width, the written fill darkened (grey when there is none); and
 * otherwise FigJam's own grey outline.
 */
function shapeStroke(n: any): { stroke: string; strokeWidth: number } {
  const width = n.strokeWidth ?? n["stroke-width"];
  if (n.stroke) return { stroke: resolveColor(n.stroke), strokeWidth: width ?? SHAPE.strokeWidth };
  if (width != null) return { stroke: darken(n.fill ? resolveColor(n.fill) : UNKNOWN_COLOR), strokeWidth: Number(width) };
  return { stroke: SHAPE.stroke, strokeWidth: SHAPE.strokeWidth };
}

function Sticky({ p }: { p: Placed }) {
  const n = p.node;
  const { x, y, w, h } = p.box;
  const inner = { x: x + STICKY.padding, y: y + STICKY.padding, w: w - 2 * STICKY.padding, h: h - 2 * STICKY.padding };
  const { lines, fontSize } = fit(String(n.text ?? ""), inner, n.fontSize ?? STICKY.fontSize, STICKY.lineHeight, {
    shrink: n.fontSize == null,
    minSize: STICKY.minFontSize,
  });
  return (
    <g data-node="sticky" opacity={opacityOf(n.opacity)}>
      <rect x={x} y={y} width={w} height={h} rx={2} fill={n.fill ? resolveColor(n.fill) : STICKY.fill} style={{ filter: STICKY.shadow }} />
      <TextBlock lines={lines} box={inner} fontSize={fontSize} lineHeight={STICKY.lineHeight} color={NODE_TEXT_COLOR} align="start" valign="top" />
    </g>
  );
}

function Shape({ p }: { p: Placed }) {
  const n = p.node;
  const { x, y, w, h } = p.box;
  const g = shapeGeometry(n.shapeType ?? "SQUARE", w, h);
  const fill = n.fill ? resolveColor(n.fill) : SHAPE.fill;
  const stroke = shapeStroke(n);
  const fs = n.fontSize ?? SHAPE.fontSize;
  const tb = { x: x + g.text.x, y: y + g.text.y, w: Math.max(1, g.text.w), h: Math.max(1, g.text.h) };
  const lines = n.text && !TEXTLESS_SHAPES.has(n.shapeType) ? wrap(String(n.text), tb.w, fs) : [];
  return (
    <g data-node="shape" data-shape={n.shapeType ?? "SQUARE"} opacity={opacityOf(n.opacity)}>
      <g transform={`translate(${x} ${y})`}>
        <path d={g.d} fill={fill} {...stroke} strokeLinejoin="round" />
        {g.details && <path d={g.details} fill="none" stroke={stroke.stroke} strokeWidth={stroke.strokeWidth} strokeLinecap="round" />}
      </g>
      {lines.length > 0 && <TextBlock lines={lines} box={tb} fontSize={fs} lineHeight={SHAPE.lineHeight} color={NODE_TEXT_COLOR} />}
    </g>
  );
}

function TextNode({ p }: { p: Placed }) {
  const n = p.node;
  const fs = n.fontSize ?? TEXT.fontSize;
  return (
    <g data-node="text" opacity={opacityOf(n.opacity)}>
      <TextBlock
        lines={String(n.text ?? "").split("\n")}
        box={p.box}
        fontSize={fs}
        lineHeight={TEXT.lineHeight}
        color={n.color ? resolveColor(n.color) : TEXT.color}
        align="start"
        valign="top"
      />
    </g>
  );
}

function Stamp({ p }: { p: Placed }) {
  const n = p.node;
  const { x, y } = p.box;
  const r = STAMP.size / 2;
  const glyph = STAMP_GLYPHS[String(n.stamp ?? "").toLowerCase()] ?? "⭐";
  return (
    <g data-node="stamp" opacity={opacityOf(n.opacity)}>
      <circle cx={x + r} cy={y + r} r={r - 0.5} fill={STAMP.fill} stroke={STAMP.stroke} strokeWidth={1} />
      <text x={x + r} y={y + r} fontSize={STAMP.glyphSize} textAnchor="middle" dominantBaseline="central">
        {glyph}
      </text>
    </g>
  );
}

function Section({ p, children }: { p: Placed; children: ReactNode }) {
  const n = p.node;
  const { x, y, w, h } = p.box;
  const L = SECTION.label;
  const name = n.name != null ? String(n.name) : "";
  const labelW = name ? measure(name, L.fontSize) + 20 : 0;
  return (
    <g data-node="section" opacity={opacityOf(n.opacity)}>
      <rect x={x} y={y} width={w} height={h} rx={SECTION.radius} fill={n.fill ? resolveColor(n.fill) : SECTION.fill} stroke={SECTION.stroke} strokeWidth={1} />
      {name && (
        <g>
          <rect x={x} y={y - L.height - 6} width={labelW} height={L.height} rx={L.height / 2} fill={L.fill} stroke={SECTION.stroke} />
          <text x={x + 10} y={y - 6 - L.height / 2} fontFamily={FONT_FAMILY} fontWeight={FONT_WEIGHT} fontSize={L.fontSize} fill={L.color} dominantBaseline="central">
            {name}
          </text>
        </g>
      )}
      {children}
    </g>
  );
}

function Node({ p }: { p: Placed }) {
  switch (p.node.type) {
    case "sticky":
      return <Sticky p={p} />;
    case "shape":
      return <Shape p={p} />;
    case "text":
      return <TextNode p={p} />;
    case "stamp":
      return <Stamp p={p} />;
    case "section":
      return (
        <Section p={p}>
          {(p.children ?? []).map((c, i) => (
            <Node key={i} p={c} />
          ))}
        </Section>
      );
  }
  return null;
}

/* ------------------------------------------------------------------ connectors */

type Pt = { x: number; y: number };

/** A cap at `tip`, pointing along `d` (the way the line travels into the tip). */
function Cap({ kind, tip, d, sw, color }: { kind: string; tip: Pt; d: Pt; sw: number; color: string }) {
  // About 20px at FigJam's default 4px line, growing with the line (measured 2026-10-08).
  const L = Math.max(16, sw * 5);
  const n = { x: -d.y, y: d.x };
  const at = (back: number, side: number) => `${tip.x - d.x * back + n.x * side} ${tip.y - d.y * back + n.y * side}`;
  switch (kind) {
    case "arrow-lines":
      return <path d={`M${at(L * 0.85, L * 0.5)} L${tip.x} ${tip.y} L${at(L * 0.85, -L * 0.5)}`} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />;
    case "arrow-equilateral":
      return <path d={`M${tip.x} ${tip.y} L${at(L * 0.87, L / 2)} L${at(L * 0.87, -L / 2)} Z`} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />;
    case "triangle-filled":
      // FigJam's filled triangle sits with its flat side on the node and points back along the line.
      return <path d={`M${at(0, L * 0.45)} L${at(0, -L * 0.45)} L${at(L * 0.85, 0)} Z`} fill={color} />;
    case "circle-filled":
      // Centred on the end point, half over the node.
      return <circle cx={tip.x} cy={tip.y} r={L * 0.45} fill={color} />;
    case "diamond-filled":
      return <path d={`M${at(-L * 0.5, 0)} L${at(0, L * 0.4)} L${at(L * 0.5, 0)} L${at(0, -L * 0.4)} Z`} fill={color} />;
  }
  return null;
}

/** A polyline with each interior corner rounded, as FigJam draws elbowed connectors. */
function roundedPath(pts: Pt[], radius: number): string {
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const u = (p: Pt, q: Pt) => { const l = Math.hypot(q.x - p.x, q.y - p.y) || 1; return { x: (q.x - p.x) / l, y: (q.y - p.y) / l }; };
    const [ub, uc] = [u(b, a), u(b, c)];
    d += ` L${b.x + ub.x * r} ${b.y + ub.y * r} Q${b.x} ${b.y} ${b.x + uc.x * r} ${b.y + uc.y * r}`;
  }
  const z = pts[pts.length - 1];
  return `${d} L${z.x} ${z.y}`;
}

function Connector({ r, background }: { r: Route; background: string }) {
  const c = r.connector;
  const sw = Number(c.strokeWidth ?? c["stroke-width"] ?? CONNECTOR.strokeWidth);
  const color = c.stroke ? resolveColor(c.stroke) : c.color ? resolveColor(c.color) : CONNECTOR.stroke;
  const [p0, p1] = [r.points[0], r.points[r.points.length - 1]];
  const d =
    r.lineType === "curved" && r.controls
      ? `M${p0.x} ${p0.y} C${r.controls[0].x} ${r.controls[0].y} ${r.controls[1].x} ${r.controls[1].y} ${p1.x} ${p1.y}`
      : roundedPath(r.points, CONNECTOR.elbowRadius);
  const fromCap = c.fromCap ?? "none";
  const toCap = c.toCap ?? "arrow-lines";
  const label = c.label != null && c.label !== "" ? String(c.label) : "";
  const fs = Number(c.fontSize ?? CONNECTOR.fontSize);
  const L = CONNECTOR.label;
  const lw = label ? measure(label, fs) + 2 * L.padX : 0;
  const lh = fs * 1.3 + 2 * L.padY;
  return (
    <g data-node="connector" opacity={opacityOf(c.opacity)}>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={sw}
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeDasharray={c.lineStyle === "dashed" ? CONNECTOR.dash.join(" ") : undefined}
      />
      <Cap kind={fromCap} tip={p0} d={{ x: -r.startDir.x, y: -r.startDir.y }} sw={sw} color={color} />
      <Cap kind={toCap} tip={p1} d={r.endDir} sw={sw} color={color} />
      {label && (
        <g>
          <rect x={r.mid.x - lw / 2} y={r.mid.y - lh / 2} width={lw} height={lh} fill={background} />
          <text x={r.mid.x} y={r.mid.y} fontFamily={FONT_FAMILY} fontWeight={FONT_WEIGHT} fontSize={fs} fill={L.color} textAnchor="middle" dominantBaseline="central">
            {label}
          </text>
        </g>
      )}
    </g>
  );
}

/* ------------------------------------------------------------------ canvas */

/** Re-measure once web fonts arrive, so wrapping uses Inter rather than its fallback. */
function useFontsReady(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const fonts = typeof document !== "undefined" ? (document as any).fonts : undefined;
    if (!fonts?.ready) return;
    let live = true;
    fonts.ready.then(() => live && setTick((t) => t + 1));
    return () => {
      live = false;
    };
  }, []);
  return tick;
}

const fitView = (b: Box): Box => {
  const w = Math.max(b.w, 1) + 2 * MARGIN;
  const h = Math.max(b.h, 1) + 2 * MARGIN;
  return { x: b.x - MARGIN, y: b.y - MARGIN, w, h };
};

export const BoardPreview = ({ nodes, background, label }: { nodes: any[]; background?: string; label?: string }) => {
  const fonts = useFontsReady();
  const layout = useMemo(() => layoutPage(nodes ?? []), [nodes, fonts]);
  const home = useMemo(() => fitView(layout.bounds), [layout]);
  const [view, setView] = useState<Box>(home);
  useEffect(() => setView(home), [home]);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; view: Box } | null>(null);

  /** Client pixels → user units, at the current view. */
  const scale = () => {
    const r = svgRef.current?.getBoundingClientRect();
    return r && r.width ? Math.max(view.w / r.width, view.h / r.height) : 1;
  };
  const zoom = (factor: number, at?: Pt) => {
    setView((v) => {
      const w = Math.min(Math.max(v.w * factor, 50), home.w * 20);
      const k = w / v.w;
      const c = at ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 };
      return { x: c.x - (c.x - v.x) * k, y: c.y - (c.y - v.y) * k, w, h: v.h * k };
    });
  };
  // A native, non-passive listener: React's onWheel is passive, so it could not keep a pinch
  // or ctrl-wheel from zooming the whole page.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const v = viewRef.current;
      const r = svg.getBoundingClientRect();
      const s = r.width ? Math.max(v.w / r.width, v.h / r.height) : 1;
      const ox = (r.width * s - v.w) / 2;
      const oy = (r.height * s - v.h) / 2;
      zoom(Math.exp(e.deltaY * 0.002), { x: v.x - ox + (e.clientX - r.left) * s, y: v.y - oy + (e.clientY - r.top) * s });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [home]);
  const onDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, view };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const s = scale();
    setView({ ...d.view, x: d.view.x - (e.clientX - d.x) * s, y: d.view.y - (e.clientY - d.y) * s });
  };
  const onUp = () => {
    drag.current = null;
  };

  const dots = `l0186-dots-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ratio = home.w / home.h;
  const canvas = background ? resolveColor(background) : CANVAS.background;
  return (
    <div className="l0186-canvas" style={{ background: canvas }}>
      <svg
        ref={svgRef}
        role="img"
        aria-label={label ?? "FigJam board"}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", aspectRatio: `${Math.max(ratio, 0.6)}`, maxHeight: "75vh", display: "block", touchAction: "none", cursor: drag.current ? "grabbing" : "grab" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <defs>
          <pattern id={dots} width={CANVAS.grid} height={CANVAS.grid} patternUnits="userSpaceOnUse">
            <circle cx={1} cy={1} r={1} fill={CANVAS.dot} />
          </pattern>
        </defs>
        <rect x={view.x - view.w} y={view.y - view.h} width={view.w * 3} height={view.h * 3} fill={`url(#${dots})`} />
        {layout.nodes.map((p, i) => (
          <Node key={i} p={p} />
        ))}
        {layout.routes.map((r, i) => (
          <Connector key={i} r={r} background={canvas} />
        ))}
      </svg>
      <div className="l0186-zoom" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoom(1 / 1.25)}>
          +
        </button>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoom(1.25)}>
          −
        </button>
        <button type="button" aria-label="Fit board" title="Fit board" onClick={() => setView(home)}>
          ⤢
        </button>
      </div>
    </div>
  );
};
