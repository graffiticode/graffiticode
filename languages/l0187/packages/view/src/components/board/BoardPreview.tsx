// SPDX-License-Identifier: MIT
/**
 * One page of a compiled L0187 board, painted as FigJam paints it.
 *
 * L0187's compiler owns geometry, so this view measures nothing and lays out nothing: every box,
 * wrapped line, text area, route and label box comes from the compiled board, exactly as the
 * plugin receives it. Drawing order is the plugin's: nodes in program order, a section under its
 * own members, connectors last. A connector is drawn along its compiled route, its turns rounded
 * as the plugin rounds them and its ends held off the marks as FigJam holds them.
 *
 * The canvas pans by dragging and zooms with ctrl/⌘ + wheel or a pinch, and the buttons zoom and
 * fit. A plain wheel is left to the page, so an embedded board never traps scrolling.
 */
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { CANVAS, CONNECTOR, FONT_FAMILY, FONT_WEIGHT, NODE_TEXT_COLOR, SECTION, SHAPE, STICKY, TEXT, opacityOf, resolveColor } from "../../lib/figjam";
import { shapeGeometry } from "../../lib/shapes";

const MARGIN = 48;

type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Line = { text: string };

/** Compiled lines in a content box: centred (shapes) or start-aligned (stickies, text), top or middle. */
function TextBlock({
  lines,
  box,
  fontSize,
  lineHeight,
  color,
  align,
  valign,
}: {
  lines: Line[];
  box: Rect;
  fontSize: number;
  lineHeight: number;
  color: string;
  align: "start" | "center";
  valign: "top" | "middle";
}) {
  const lh = fontSize * lineHeight;
  const total = lines.length * lh;
  const top = valign === "middle" ? box.y + (box.h - total) / 2 : box.y;
  const x = align === "center" ? box.x + box.w / 2 : box.x;
  return (
    <text x={x} fontFamily={FONT_FAMILY} fontWeight={FONT_WEIGHT} fontSize={fontSize} fill={color} textAnchor={align === "center" ? "middle" : "start"}>
      {lines.map((l, i) => (
        <tspan key={i} x={x} y={top + i * lh + lh / 2} dominantBaseline="central">
          {l.text || " "}
        </tspan>
      ))}
    </text>
  );
}

const box = (n: any): Rect => ({ x: n.x, y: n.y, w: n.width, h: n.height });
const inner = (n: any): Rect => ({ x: n.x + n.content.x, y: n.y + n.content.y, w: n.content.w, h: n.content.h });

function Sticky({ n }: { n: any }) {
  const b = box(n);
  return (
    <g data-node="sticky" data-id={n.id} opacity={opacityOf(n.opacity)}>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={2} fill={n.fill ? resolveColor(n.fill) : STICKY.fill} style={{ filter: STICKY.shadow }} />
      <TextBlock lines={n.lines} box={inner(n)} fontSize={n.fontSize} lineHeight={n.lineHeight} color={NODE_TEXT_COLOR} align="start" valign="top" />
    </g>
  );
}

function Shape({ n }: { n: any }) {
  const b = box(n);
  const g = shapeGeometry(n.shapeType ?? "SQUARE", b.w, b.h);
  const stroke = n.stroke ? resolveColor(n.stroke) : SHAPE.stroke;
  const strokeWidth = n.strokeWidth ?? SHAPE.strokeWidth;
  return (
    <g data-node="shape" data-id={n.id} data-shape={n.shapeType} opacity={opacityOf(n.opacity)}>
      <g transform={`translate(${b.x} ${b.y})`}>
        <path d={g.d} fill={n.fill ? resolveColor(n.fill) : SHAPE.fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
        {g.details && <path d={g.details} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />}
      </g>
      <TextBlock lines={n.lines} box={inner(n)} fontSize={n.fontSize} lineHeight={n.lineHeight} color={NODE_TEXT_COLOR} align="center" valign="middle" />
    </g>
  );
}

function TextNode({ n }: { n: any }) {
  return (
    <g data-node="text" data-id={n.id} opacity={opacityOf(n.opacity)}>
      <TextBlock lines={n.lines} box={inner(n)} fontSize={n.fontSize} lineHeight={n.lineHeight} color={n.color ? resolveColor(n.color) : TEXT.color} align="start" valign="top" />
    </g>
  );
}

function Section({ n }: { n: any }) {
  const b = box(n);
  const t: Rect = n.titleFrame;
  const L = SECTION.label;
  return (
    <g data-node="section" data-id={n.id} opacity={opacityOf(n.opacity)}>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={SECTION.radius} fill={n.fill ? resolveColor(n.fill) : SECTION.fill} stroke={SECTION.stroke} strokeWidth={1} />
      {t && (
        <g data-part="title">
          <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={t.h / 2} fill={L.fill} stroke={SECTION.stroke} />
          <text x={t.x + 8} y={t.y + t.h / 2} fontFamily={FONT_FAMILY} fontWeight={FONT_WEIGHT} fontSize={L.fontSize} fill={L.color} dominantBaseline="central">
            {n.name}
          </text>
        </g>
      )}
      {(n.nodes ?? []).map((c: any) => (
        <Node key={c.id} n={c} />
      ))}
    </g>
  );
}

function Node({ n }: { n: any }) {
  switch (n.type) {
    case "sticky":
      return <Sticky n={n} />;
    case "shape":
      return <Shape n={n} />;
    case "text":
      return <TextNode n={n} />;
    case "section":
      return <Section n={n} />;
  }
  return null;
}

/* ------------------------------------------------------------------ connectors */

/** A cap at `tip`, pointing along `d` (the way the line travels into the tip). */
function Cap({ kind, tip, d, sw, color }: { kind: string; tip: Pt; d: Pt; sw: number; color: string }) {
  const L = Math.max(16, sw * 5);
  const n = { x: -d.y, y: d.x };
  const at = (back: number, side: number) => `${tip.x - d.x * back + n.x * side} ${tip.y - d.y * back + n.y * side}`;
  switch (kind) {
    case "ARROW_LINES":
      return <path d={`M${at(L * 0.85, L * 0.5)} L${tip.x} ${tip.y} L${at(L * 0.85, -L * 0.5)}`} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />;
    case "ARROW_EQUILATERAL":
      return <path d={`M${tip.x} ${tip.y} L${at(L * 0.87, L / 2)} L${at(L * 0.87, -L / 2)} Z`} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />;
    case "TRIANGLE_FILLED":
      return <path d={`M${at(0, L * 0.45)} L${at(0, -L * 0.45)} L${at(L * 0.85, 0)} Z`} fill={color} />;
    case "CIRCLE_FILLED":
      return <circle cx={tip.x} cy={tip.y} r={L * 0.45} fill={color} />;
    case "DIAMOND_FILLED":
      return <path d={`M${at(-L * 0.5, 0)} L${at(0, L * 0.4)} L${at(L * 0.5, 0)} L${at(0, -L * 0.4)} Z`} fill={color} />;
  }
  return null;
}

const unit = (p: Pt, q: Pt): Pt => {
  const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  return { x: (q.x - p.x) / l, y: (q.y - p.y) / l };
};

/** The route as FigJam draws it: ends held `endpointGap` off the marks, turns rounded. */
export function routePath(points: Pt[]): { d: string; start: Pt; end: Pt; startDir: Pt; endDir: Pt } {
  const pts = points.map((p) => ({ ...p }));
  const gap = CONNECTOR.endpointGap;
  const startDir = unit(pts[0], pts[1]);
  const endDir = unit(pts[pts.length - 2], pts[pts.length - 1]);
  pts[0] = { x: pts[0].x + startDir.x * gap, y: pts[0].y + startDir.y * gap };
  const last = pts.length - 1;
  pts[last] = { x: pts[last].x - endDir.x * gap, y: pts[last].y - endDir.y * gap };
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const r = Math.min(CONNECTOR.cornerRadius, Math.hypot(b.x - a.x, b.y - a.y) / 4, Math.hypot(c.x - b.x, c.y - b.y) / 4);
    const [ub, uc] = [unit(b, a), unit(b, c)];
    d += r >= 1 ? ` L${b.x + ub.x * r} ${b.y + ub.y * r} Q${b.x} ${b.y} ${b.x + uc.x * r} ${b.y + uc.y * r}` : ` L${b.x} ${b.y}`;
  }
  d += ` L${pts[last].x} ${pts[last].y}`;
  return { d, start: pts[0], end: pts[last], startDir, endDir };
}

function Connector({ c, background }: { c: any; background: string }) {
  const sw = Number(c.strokeWidth ?? 4);
  const color = c.stroke ? resolveColor(c.stroke) : CONNECTOR.stroke;
  const { d, start, end, startDir, endDir } = routePath(c.route);
  const lb: Rect | undefined = c.labelBox;
  const lines: Line[] = c.labelLines ?? (c.label ? [{ text: c.label }] : []);
  return (
    <g data-node="connector" data-id={c.id} opacity={opacityOf(c.opacity)}>
      <path d={d} fill="none" stroke={color} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={c.lineStyle === "dashed" ? CONNECTOR.dash.join(" ") : undefined} />
      <Cap kind={c.fromCap} tip={start} d={{ x: -startDir.x, y: -startDir.y }} sw={sw} color={color} />
      <Cap kind={c.toCap} tip={end} d={endDir} sw={sw} color={color} />
      {lb && lines.length > 0 && (
        <g data-part="label">
          <rect x={lb.x} y={lb.y} width={lb.w} height={lb.h} fill={background} />
          <TextBlock lines={lines} box={lb} fontSize={c.fontSize} lineHeight={1.5} color={CONNECTOR.label.color} align="center" valign="middle" />
        </g>
      )}
    </g>
  );
}

/* ------------------------------------------------------------------ canvas */

const fitView = (w: number, h: number): Rect => ({ x: -MARGIN, y: -MARGIN, w: Math.max(w, 1) + 2 * MARGIN, h: Math.max(h, 1) + 2 * MARGIN });

export const BoardPreview = ({ page, label }: { page: any; label?: string }) => {
  const home = useMemo(() => fitView(page.width, page.height), [page.width, page.height]);
  const [view, setView] = useState<Rect>(home);
  useEffect(() => setView(home), [home]);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; view: Rect } | null>(null);
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
  // A native, non-passive listener: React's onWheel is passive, so it could not keep a pinch or
  // ctrl-wheel from zooming the whole page.
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
  const dots = `l0187-dots-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ratio = home.w / home.h;
  const canvas = page.background ? resolveColor(page.background) : CANVAS.background;
  const nodes: any[] = page.nodes ?? [];
  return (
    <div className="l0187-canvas" style={{ background: canvas }}>
      <svg
        ref={svgRef}
        role="img"
        aria-label={label ?? "FigJam board"}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", aspectRatio: `${Math.max(ratio, 0.6)}`, maxHeight: "75vh", display: "block", touchAction: "none", cursor: "grab" }}
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
        {nodes.filter((n) => n.type !== "connector").map((n) => (
          <Node key={n.id} n={n} />
        ))}
        {nodes.filter((n) => n.type === "connector").map((c) => (
          <Connector key={c.id} c={c} background={canvas} />
        ))}
      </svg>
      <div className="l0187-zoom" role="group" aria-label="Zoom">
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
