// SPDX-License-Identifier: MIT
/**
 * The concept web: the diagram, its trays, and moving answers between them.
 *
 * This component is CONTROLLED. It holds no placement state of its own: `placed` comes in from
 * the model and every change goes out through `onPlace`. The same component therefore works in
 * the /form embed (where a placement recompiles and comes back in `interaction.cells`) and in
 * the Learnosity custom question (where it comes back in `responseValue`), with the Form deciding
 * which.
 *
 * GEOMETRY. Nodes and text have one fixed pixel size; the web spreads to fill its frame
 * (lib/layout.ts). Stage 1, the minimum layout, is a function of the model and the measured size
 * of every label candidate, and is recomputed only when those change. Stage 2 stretches it into
 * the frame, which a ResizeObserver watches. When the frame is smaller than the minimum, the
 * canvas scrolls inside it. Placing an answer changes neither the label room (reserved for every
 * candidate) nor the trays' size (reserved for every item), so nothing moves.
 *
 * Moving an answer works three ways, because each one fails somebody:
 *
 * - DRAG with pointer events, not the HTML5 drag-and-drop API — HTML5 DnD never fires on touch.
 *   On a touch screen a tray item drags from its grip handle, and its body scrolls the tray
 *   (lib/gesture.ts); a filled blank drags from anywhere on it.
 * - SELECT THEN PLACE: activate a tray item (click, tap, Enter or Space), then activate a blank.
 *   This is the keyboard path, and it is also what a tap does.
 * - CLEAR: activate a filled blank with nothing selected, or press Delete on it, and its answer
 *   goes back to the tray.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { ARROW_LEN, place, solve, spacingFor, STROKE, type LayoutModel } from "../../lib/layout";
import type { Quad } from "../../lib/geom";
import { candidateKey, edgeCandidates, reserve, type Candidate, type Size } from "../../lib/metrics";
import { startsDrag, type DragRole } from "../../lib/gesture";
import { available, shuffle, type TrayItem } from "../../lib/tray";
import { RichText } from "../../lib/text";
import type { CellScore } from "../../scoring";
import { FitBox } from "./FitBox";
import { LabelFace } from "./Label";
import { HUB_DEFAULT, NODE_COLORS, NODE_DEFAULT, RIGHT, SHAPE_CLASS, WRONG } from "./palette";

export interface WebNode {
  id: string;
  text?: string;
  shape?: string;
  color?: string;
  size?: string;
  blank?: boolean;
}

export interface WebEdge {
  id: string;
  from: string;
  to: string;
  style: string;
  label?: string;
  blank?: boolean;
}

export interface Tray {
  items: TrayItem[];
  align: string;
}

export interface Interaction {
  type: "concept-web";
  hub: WebNode;
  nodes: WebNode[];
  edges: WebEdge[];
  trays: { nodes?: Tray; edges?: Tray };
  cells: Record<string, { value?: string }>;
}

/** Where the Form is hosted, which decides how tall the diagram's frame is. */
export type Host = "embed" | "learnosity";

type Kind = "nodes" | "edges";

/** What is being moved: a tray item, or the answer already sitting in a blank. */
interface Held {
  kind: Kind;
  text: string;
  /** The blank it was lifted from, when it came from one. */
  from?: string;
}

function classNames(...classes: any[]) {
  return classes.filter(Boolean).join(" ");
}

/** Node text: a fixed pixel size by node width, a little smaller for long text. */
const NODE_PAD = 4;
const NODE_BORDER = 2;
function nodeFont(box: { w: number }, text: string | undefined): number {
  const len = (text || "").length;
  const shrink = len > 40 ? 0.62 : len > 22 ? 0.78 : 1;
  return Math.round(box.w * 0.12 * shrink * 10) / 10;
}

/** In page flow, the square is never taller than this share of the window. */
const FLOW_VH = 0.85;
/** Top and bottom trays take at most this share of the viewport, scrolling inside. */
const TRAY_SHARE = 0.25;
/** Below this width, side trays stack above and below the diagram. */
const WIDE = "(min-width: 640px)";
/**
 * How close to an edge a drag must be to scroll, how long it must rest there first, and how fast.
 * The rest matters: a finger coming up from a tray crosses the frame's bottom edge on its way to a
 * blank, and scrolling at once would move the blank out from under it.
 */
const EDGE_ZONE = 40;
const EDGE_DWELL_MS = 250;
const EDGE_SPEED = 14;

const pathD = (q: Quad) => `M ${q.p0.x} ${q.p0.y} Q ${q.c.x} ${q.c.y} ${q.p2.x} ${q.p2.y}`;

function useMedia(query: string): boolean {
  const get = () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, [query]);
  return matches;
}

function useWindowHeight(): number {
  const [h, setH] = useState(() => (typeof window !== "undefined" ? window.innerHeight : 800));
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return h;
}

/** An element's inner size, tracked with a ResizeObserver and coalesced to animation frames. */
function useSize<T extends HTMLElement>(): [RefObject<T>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const next = { width: el.clientWidth, height: el.clientHeight };
      setSize((s) => (s.width === next.width && s.height === next.height ? s : next));
    };
    read();
    const ro = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(read);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return [ref, size];
}

/**
 * Measures every label candidate, rendered offscreen with the real LabelFace. Re-measures when
 * any of them changes size (a web font arriving, KaTeX finishing, an image decoding) and once
 * the document's fonts are ready.
 */
function MeasureLabels({
  candidates,
  onMeasure,
}: {
  candidates: Candidate[];
  onMeasure: (sizes: Record<string, Size>) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(onMeasure);
  latest.current = onMeasure;
  const keys = candidates.map(candidateKey).join("\u0002");
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const out: Record<string, Size> = {};
      for (const child of Array.from(el.children) as HTMLElement[]) {
        const face = child.firstElementChild as HTMLElement | null;
        if (!face) continue;
        out[child.dataset.key!] = { w: Math.ceil(face.offsetWidth), h: Math.ceil(face.offsetHeight) };
      }
      latest.current(out);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : undefined;
    for (const child of Array.from(el.children)) if (child.firstElementChild) ro?.observe(child.firstElementChild);
    let live = true;
    document.fonts?.ready.then(() => live && schedule());
    return () => {
      live = false;
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [keys]);
  return (
    <div aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-0 w-0 overflow-hidden">
      <div ref={root} style={{ visibility: "hidden" }}>
        {candidates.map((c) => (
          <div key={candidateKey(c)} data-key={candidateKey(c)} style={{ position: "absolute", left: 0, top: 0 }}>
            <LabelFace kind={c.kind} text={c.text} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A tray above or below the frame. Its height is reserved for ALL its items (`all`, a hidden
 * copy of the tray as if nothing were placed) and capped, scrolling inside, so it never collapses
 * the diagram and never shrinks as answers are placed — which would move every node.
 */
function ReservedTray({
  group,
  chrome,
  cap,
  all,
  live,
}: {
  group: Record<string, string>;
  chrome: string;
  cap: number | string;
  all: ReactNode;
  live: ReactNode;
}) {
  const [copyRef, copy] = useSize<HTMLDivElement>();
  return (
    // overflow-hidden clips the hidden copy, which is as tall as ALL the items: unclipped, it hangs
    // below the capped tray and makes the page (or the Form) scroll into empty space. Clipping does
    // not change its layout, so it still measures the full height.
    <div className={`relative w-full shrink-0 overflow-hidden ${chrome}`}>
      <div ref={copyRef} aria-hidden="true" className="pointer-events-none invisible absolute inset-x-0 top-0">
        {all}
      </div>
      <div {...group} className="overflow-auto" style={{ height: copy.height || undefined, maxHeight: cap }}>
        {live}
      </div>
    </div>
  );
}

export function Web({
  interaction,
  placed,
  onPlace,
  scores,
  disabled = false,
  host = "embed",
}: {
  interaction: Interaction;
  /** Blank id -> the answer in it. */
  placed: Record<string, string | undefined>;
  onPlace: (changes: Record<string, string | null>) => void;
  /** Per-blank feedback. Absent means feedback is not being shown. */
  scores?: Record<string, CellScore>;
  disabled?: boolean;
  host?: Host;
}) {
  const { hub, nodes, edges, trays } = interaction;
  const all = useMemo(() => [hub, ...nodes], [hub, nodes]);
  const blankKind = (id: string): Kind | undefined =>
    all.some((n) => n.id === id && n.blank)
      ? "nodes"
      : edges.some((e) => e.id === id && e.blank)
        ? "edges"
        : undefined;

  // ---- Geometry --------------------------------------------------------------------------

  const edgeTrayTexts = useMemo(() => (trays.edges?.items || []).map((i) => i.text), [trays.edges]);
  const candidatesByEdge = useMemo(
    () => new Map(edges.map((e) => [e.id, edgeCandidates(e, edgeTrayTexts)])),
    [edges, edgeTrayTexts],
  );
  const candidates = useMemo(() => {
    const seen = new Map<string, Candidate>();
    for (const list of candidatesByEdge.values()) for (const c of list) seen.set(candidateKey(c), c);
    return [...seen.values()];
  }, [candidatesByEdge]);
  const [measured, setMeasured] = useState<Record<string, Size>>({});
  const onMeasure = (sizes: Record<string, Size>) =>
    setMeasured((m) => {
      const same = Object.keys(sizes).every((k) => m[k]?.w === sizes[k].w && m[k]?.h === sizes[k].h);
      return same ? m : { ...m, ...sizes };
    });

  // Every recompile hands us new objects; key the solve on content so it reruns only when the
  // web itself or the measured room changes.
  const model: LayoutModel = {
    hub: { id: hub.id, shape: hub.shape, size: hub.size },
    nodes: nodes.map((n) => ({ id: n.id, shape: n.shape, size: n.size })),
    edges: edges.map((e) => {
      const c = candidatesByEdge.get(e.id) || [];
      return { id: e.id, from: e.from, to: e.to, label: c.length ? reserve(c, measured) : undefined };
    }),
  };
  const modelKey = JSON.stringify(model);
  const minLayout = useMemo(() => solve(model), [modelKey]);

  // Nodes and text never change size; only the SPACING between them does (lib/layout.ts,
  // `spacingFor`). The minimum layout is the best fit, the closest spacing at which nothing
  // collides, and the web is never spread past it. With less room, in either direction, the
  // spacing compresses to fit, down to the point where nodes would start to touch; past that, the
  // whole picture zooms down to fit.
  // - In a full-viewport column (the /form embed marks its #root `data-l0183-viewport`), the room
  //   is the frame's share of the column, after the title, trays and Check bar.
  // - In page flow (Learnosity, or a page of several webs), the height is capped at a share of the
  //   window.
  const [frameRef, frame] = useSize<HTMLDivElement>();
  const [column, setColumn] = useState(false);
  useLayoutEffect(() => {
    setColumn(!!frameRef.current?.closest("[data-l0183-viewport]"));
  }, []);
  const windowH = useWindowHeight();
  const room = useMemo(
    () => ({
      width: frame.width || minLayout.min.width,
      height: column ? frame.height || minLayout.min.height : FLOW_VH * windowH,
    }),
    [frame.width, frame.height, column, windowH, minLayout],
  );
  const spacing = useMemo(() => spacingFor(minLayout, room), [minLayout, room]);
  const geo = useMemo(() => place(minLayout, spacing), [minLayout, spacing]);
  // Past the floor the spacing can shrink no further without a collision, so the whole picture
  // zooms down to fit the room instead: nothing overlaps and nothing scrolls.
  const zoom = Math.min(1, room.width / geo.width, room.height / geo.height);
  // At the floor the canvas can be bigger than the frame: open on the hub, not on a corner. Once
  // per minimum layout, so a resize or a placement never scrolls the web under the learner.
  const centredFor = useRef<unknown>(null);
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el || !frame.width || centredFor.current === minLayout) return;
    centredFor.current = minLayout;
    el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
    el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2);
  }, [minLayout, geo, frame.width]);
  const byId = useMemo(() => new Map(geo.boxes.map((b) => [b.id, b])), [geo]);
  const labelById = useMemo(() => new Map(geo.labels.map((l) => [l.id, l])), [geo]);
  const pathById = useMemo(() => new Map(geo.edges.map((e) => [e.id, e.path])), [geo]);

  const wide = useMedia(WIDE);
  // In a column the frame's height comes from the layout (flex: 1); in page flow it is the
  // canvas's, up to the room. `host` is kept for callers and for future host-specific rules.
  void host;
  const frameStyle: CSSProperties = column ? {} : { height: geo.height * zoom };

  // One marker id per instance: a fixed id collides when two webs share a page, and the second
  // web's arrows then point with the first web's arrowheads.
  const markerId = `l0183-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  // ---- Placement -------------------------------------------------------------------------

  const [selected, setSelected] = useState<Held | null>(null);
  // `over`: the blank under the pointer, if any, for drop feedback.
  const [drag, setDrag] = useState<(Held & { x: number; y: number; over?: string }) | null>(null);
  const dragStart = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    if (disabled) setSelected(null);
  }, [disabled]);

  const trayAll = (kind: Kind) => shuffle(trays[kind]?.items || []);
  const trayItems = (kind: Kind) => {
    if (!trays[kind]) return [];
    const ids = Object.keys(interaction.cells).filter((id) => blankKind(id) === kind);
    return available(trayAll(kind), ids.map((id) => placed[id]));
  };

  /** Put what is held into a blank, swapping out whatever was there. */
  const put = (held: Held, blank: string) => {
    if (blankKind(blank) !== held.kind) {
      setAnnounce(held.kind === "nodes" ? "That answer goes on a node." : "That label goes on a line.");
      return;
    }
    if (held.from === blank) return;
    const changes: Record<string, string | null> = { [blank]: held.text };
    // Moving from one blank to another: the source takes whatever the target held, if anything.
    if (held.from) changes[held.from] = placed[blank] ?? null;
    onPlace(changes);
    setAnnounce(`Placed ${held.text}.`);
  };

  const clear = (blank: string) => {
    if (!placed[blank]) return;
    onPlace({ [blank]: null });
    setAnnounce(`Returned ${placed[blank]} to the tray.`);
  };

  /** Activating a blank: place the selection, or return the blank's answer to the tray. */
  const activateBlank = (blank: string) => {
    if (disabled) return;
    if (selected) {
      put(selected, blank);
      setSelected(null);
    } else if (placed[blank]) {
      clear(blank);
    }
  };

  // ---- Dragging --------------------------------------------------------------------------

  const beginDrag = (e: ReactPointerEvent, held: Held) => {
    if (disabled || e.button !== 0) return;
    dragStart.current = { x: e.clientX, y: e.clientY, moved: false };
    pointer.current = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ ...held, x: e.clientX, y: e.clientY });
  };

  const moveDrag = (e: ReactPointerEvent) => {
    if (!drag || !dragStart.current) return;
    if (Math.hypot(e.clientX - dragStart.current.x, e.clientY - dragStart.current.y) > 4) {
      dragStart.current.moved = true;
    }
    pointer.current = { x: e.clientX, y: e.clientY };
    setDrag({ ...drag, x: e.clientX, y: e.clientY, over: blankAt(e.clientX, e.clientY) });
  };

  /** The blank under a point (the drag preview never takes pointer events). */
  const blankAt = (x: number, y: number): string | undefined =>
    (document.elementFromPoint(x, y)?.closest("[data-l0183-blank]") as HTMLElement | null)?.dataset.l0183Blank;

  // Drop feedback. While a drag is under way, every blank that can take it is ringed, and the one
  // under the pointer is highlighted; a select-then-place selection rings the same blanks.
  const dragging = !!drag && !!dragStart.current?.moved;
  const target = (id: string, kind: Kind): "over" | "can" | undefined => {
    if (dragging) {
      if (drag!.kind !== kind || drag!.from === id) return undefined;
      return drag!.over === id ? "over" : "can";
    }
    return selected?.kind === kind ? "can" : undefined;
  };
  /** What a drop here would do, for the preview: place, nothing (wrong kind), or return to tray. */
  const dropMeaning = (): "place" | "wrong" | "return" | "none" => {
    if (!drag?.over) return drag?.from ? "return" : "none";
    if (drag.over === drag.from) return "none";
    return blankKind(drag.over) === drag.kind ? "place" : "wrong";
  };

  /** Returns true when the gesture was a drag, so the click that follows is ignored. */
  const endDrag = (e: ReactPointerEvent): boolean => {
    const moved = !!dragStart.current?.moved;
    const held = drag;
    dragStart.current = null;
    pointer.current = null;
    setDrag(null);
    if (!held || !moved) return false;
    const blank = blankAt(e.clientX, e.clientY);
    if (blank) put(held, blank);
    else if (held.from) clear(held.from); // dropped off the web: back to the tray
    setSelected(null);
    return true;
  };

  // While dragging near the frame's edge, scroll the frame, so a blank out of view can be reached.
  useEffect(() => {
    if (!drag) return;
    let raf = 0;
    // When the pointer entered each edge zone (0: not in it), so a pass through does not scroll.
    let frameSince = 0;
    let pageSince = 0;
    const tick = (now: number) => {
      const el = frameRef.current;
      const p = pointer.current;
      if (el && p && dragStart.current?.moved) {
        const r = el.getBoundingClientRect();
        // A small frame gets a smaller zone, so most of it is not an edge.
        const zone = Math.min(EDGE_ZONE, r.width / 6, r.height / 6);
        const dx = p.x < r.left + zone ? -EDGE_SPEED : p.x > r.right - zone ? EDGE_SPEED : 0;
        const dy = p.y < r.top + zone ? -EDGE_SPEED : p.y > r.bottom - zone ? EDGE_SPEED : 0;
        const inside = p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
        if (inside && (dx || dy)) {
          frameSince ||= now;
          if (now - frameSince >= EDGE_DWELL_MS) el.scrollBy(dx, dy);
        } else {
          frameSince = 0;
        }
        // The square can be taller than the window, with the trays below it: near the window's
        // top or bottom edge, scroll whatever holds the Form (the Form itself in the /form
        // embed, else the page), so a blank above the fold can be reached from a tray below it.
        const vy = p.y < EDGE_ZONE ? -EDGE_SPEED : p.y > window.innerHeight - EDGE_ZONE ? EDGE_SPEED : 0;
        if (vy) {
          pageSince ||= now;
          if (now - pageSince >= EDGE_DWELL_MS) {
            const form = el.closest<HTMLElement>(".l0183-web");
            if (form && form.scrollHeight > form.clientHeight) form.scrollBy(0, vy);
            else window.scrollBy(0, vy);
          }
        } else {
          pageSince = 0;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [!!drag]);

  const suppressClick = useRef(false);
  const dragHandlers = (held: Held, role: DragRole) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      if (startsDrag(e.pointerType, role)) beginDrag(e, held);
    },
    onPointerMove: moveDrag,
    onPointerUp: (e: ReactPointerEvent) => {
      suppressClick.current = endDrag(e);
    },
    onPointerCancel: () => {
      dragStart.current = null;
      pointer.current = null;
      setDrag(null);
    },
    onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
  });
  const unlessDragged = (fn: () => void) => () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    fn();
  };

  // ---- Rendering -------------------------------------------------------------------------

  const feedback = (id: string) =>
    scores?.[id] ? (scores[id].isValid ? RIGHT : WRONG) : undefined;

  const blankLabel = (id: string, what: string) => {
    const value = placed[id];
    const verdict = scores?.[id] ? (scores[id].isValid ? ", correct" : ", incorrect") : "";
    return value ? `${what}, holding ${value}${verdict}` : `${what}, empty`;
  };

  const renderNode = (node: WebNode) => {
    const box = byId.get(node.id);
    if (!box) return null;
    const isHub = node.id === hub.id;
    const value = node.blank ? placed[node.id] : node.text;
    const colour =
      feedback(node.id) ??
      (node.color ? NODE_COLORS[node.color] : isHub ? HUB_DEFAULT : NODE_DEFAULT);
    const style: CSSProperties = {
      left: box.x - box.w / 2,
      top: box.y - box.h / 2,
      width: box.w,
      height: box.h,
      fontSize: nodeFont(box, value),
      padding: NODE_PAD,
      borderWidth: NODE_BORDER,
    };
    const inner = { w: box.w - 2 * (NODE_PAD + NODE_BORDER), h: box.h - 2 * (NODE_PAD + NODE_BORDER) };
    const face = classNames(
      "absolute z-10 flex items-center justify-center overflow-hidden text-center leading-tight",
      SHAPE_CLASS[node.shape || "rounded"],
      colour,
    );
    if (!node.blank) {
      return (
        <div key={node.id} className={face} style={style}>
          <FitBox maxW={inner.w} maxH={inner.h}>
            <RichText text={node.text || ""} />
          </FitBox>
        </div>
      );
    }
    const drop = target(node.id, "nodes");
    return (
      <button
        key={node.id}
        type="button"
        data-l0183-blank={node.id}
        disabled={disabled}
        aria-label={blankLabel(node.id, isHub ? "Centre blank" : "Blank")}
        className={classNames(
          face,
          !value && !scores && "border-dashed",
          !value && !feedback(node.id) && drop !== "over" && "bg-zinc-50 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-500",
          drop === "can" && "ring-4 ring-blue-400/60",
          drop === "over" && "scale-105 border-blue-500 bg-blue-50 text-blue-700 ring-4 ring-blue-500 dark:bg-blue-950 dark:text-blue-200",
          "transition-transform duration-100",
          value && !disabled && "touch-none",
          "cursor-pointer focus-visible:outline focus-visible:outline-4 focus-visible:outline-blue-500 disabled:cursor-default",
        )}
        style={style}
        onClick={unlessDragged(() => activateBlank(node.id))}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") clear(node.id);
        }}
        {...(value && !disabled ? dragHandlers({ kind: "nodes", text: value, from: node.id }, "blank") : {})}
      >
        <FitBox maxW={inner.w} maxH={inner.h}>
          {value ? <RichText text={value} /> : <span aria-hidden="true">?</span>}
        </FitBox>
      </button>
    );
  };

  const renderLabel = (edge: WebEdge) => {
    const at = labelById.get(edge.id);
    if (!at || (!edge.blank && !edge.label)) return null;
    const value = edge.blank ? placed[edge.id] : edge.label;
    // Centred on its anchor: the face is never bigger than the room reserved for it.
    const style: CSSProperties = { left: at.x, top: at.y };
    const base = classNames("absolute -translate-x-1/2 -translate-y-1/2", at.residual ? "z-30" : "z-20");
    if (!edge.blank) {
      return (
        <div key={edge.id} className={base} style={style}>
          <LabelFace
            kind="label"
            text={edge.label!}
            className="border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
          />
        </div>
      );
    }
    const drop = target(edge.id, "edges");
    return (
      <button
        key={edge.id}
        type="button"
        data-l0183-blank={edge.id}
        disabled={disabled}
        aria-label={blankLabel(edge.id, "Line label blank")}
        className={classNames(
          base,
          "cursor-pointer rounded-2xl focus-visible:outline focus-visible:outline-4 focus-visible:outline-blue-500 disabled:cursor-default",
          drop === "can" && "ring-4 ring-blue-400/60",
          drop === "over" && "ring-4 ring-blue-500",
          value && !disabled && "touch-none",
        )}
        style={style}
        onClick={unlessDragged(() => activateBlank(edge.id))}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") clear(edge.id);
        }}
        {...(value && !disabled ? dragHandlers({ kind: "edges", text: value, from: edge.id }, "blank") : {})}
      >
        <LabelFace
          kind="blank"
          text={value ?? null}
          className={
            (drop === "over"
              ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-200"
              : undefined) ??
            feedback(edge.id) ??
            (value
              ? "border-zinc-400 bg-white text-zinc-900 dark:border-zinc-500 dark:bg-zinc-800 dark:text-zinc-100"
              : "border-zinc-400 bg-zinc-50 text-zinc-400 dark:border-zinc-500 dark:bg-zinc-900")
          }
        />
      </button>
    );
  };

  const trayItem = (kind: Kind, item: TrayItem, interactive: boolean) => {
    const isSelected = selected?.kind === kind && selected.text === item.text && !selected.from;
    const held = { kind, text: item.text };
    return (
      <div
        key={item.id}
        className={classNames(
          "flex min-h-10 select-none items-stretch border-2 text-sm leading-tight shadow-sm",
          kind === "nodes" ? "rounded-lg" : "rounded-full",
          isSelected
            ? "border-blue-500 bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-100"
            : "border-zinc-300 bg-zinc-50 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100",
          disabled && "opacity-60",
          // The item being dragged stays in its tray, dimmed, until it is dropped.
          interactive && dragging && !drag!.from && drag!.kind === kind && drag!.text === item.text && "opacity-40",
        )}
      >
        {/* The grip: on a touch screen, the only place a drag starts. Never scrolls. */}
        <span
          aria-hidden="true"
          data-l0183-grip=""
          className={classNames(
            "hidden w-8 shrink-0 touch-none items-center justify-center text-zinc-400 [@media(any-pointer:coarse)]:flex",
            disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing",
          )}
          {...(interactive ? dragHandlers(held, "handle") : {})}
        >
          ⋮⋮
        </span>
        <button
          type="button"
          disabled={disabled}
          tabIndex={interactive ? undefined : -1}
          aria-pressed={interactive ? isSelected : undefined}
          className={classNames(
            "flex flex-1 items-center justify-center px-3 py-1 focus-visible:outline focus-visible:outline-4 focus-visible:outline-blue-500",
            disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing",
          )}
          style={{ touchAction: "pan-x pan-y" }}
          onClick={interactive ? unlessDragged(() => setSelected(isSelected ? null : { kind, text: item.text })) : undefined}
          {...(interactive ? dragHandlers(held, "tray-body") : {})}
        >
          <span className="max-h-16 max-w-full">
            <RichText text={item.text} imageBox={{ w: 64, h: 40 }} />
          </span>
        </button>
      </div>
    );
  };

  const trayList = (kind: Kind, items: TrayItem[], interactive: boolean, column: boolean) => (
    <div className={classNames("flex flex-wrap content-start gap-2 p-3", column ? "flex-col" : "justify-center")}>
      {interactive && items.length === 0 && (
        <span className="text-xs text-zinc-400">
          {kind === "nodes" ? "Every answer is placed." : "Every label is placed."}
        </span>
      )}
      {items.map((item) => trayItem(kind, item, interactive))}
    </div>
  );

  const renderTray = (kind: Kind) => {
    const tray = trays[kind];
    if (!tray) return null;
    const side = (tray.align === "left" || tray.align === "right") && wide;
    const chrome = "rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800/60";
    const group = { role: "group", "aria-label": kind === "nodes" ? "Answers" : "Line labels" } as const;
    if (side) {
      // Beside the frame: as tall as the frame, scrolling inside itself, and contributing no
      // height of its own, so emptying it moves nothing.
      return (
        <div key={kind} className={classNames("relative w-44 shrink-0 self-stretch", chrome)}>
          <div {...group} className="absolute inset-0 overflow-auto">
            {trayList(kind, trayItems(kind), true, true)}
          </div>
        </div>
      );
    }
    return (
      <ReservedTray
        key={kind}
        group={group}
        chrome={chrome}
        cap={`${TRAY_SHARE * 100}dvh`}
        all={trayList(kind, trayAll(kind), false, false)}
        live={trayList(kind, trayItems(kind), true, false)}
      />
    );
  };

  const diagram = (
    <div
      ref={frameRef}
      data-l0183-frame=""
      className={classNames(
        "relative min-w-0 flex-1 overflow-auto",
        column ? "min-h-0" : "shrink-0",
      )}
      style={frameStyle}
      onKeyDown={(e) => {
        if (e.key === "Escape") setSelected(null);
      }}
    >
      {/* Centres the canvas when it is smaller than the frame, and still scrolls when it is bigger
          (centring with flex on the scroller itself would cut off its top and left). */}
      <div className="flex min-h-full min-w-full items-center justify-center">
      <div className="shrink-0" style={{ width: geo.width * zoom, height: geo.height * zoom }}>
      <div
        data-l0183-canvas=""
        data-l0183-spacing={spacing.toFixed(3)}
        data-l0183-zoom={zoom.toFixed(3)}
        className="relative shrink-0 select-none"
        style={{
          width: geo.width,
          height: geo.height,
          transform: zoom < 1 ? `scale(${zoom})` : undefined,
          transformOrigin: "0 0",
        }}
      >
        <svg
          className="absolute inset-0 text-zinc-400 dark:text-zinc-500"
          width={geo.width}
          height={geo.height}
          viewBox={`0 0 ${geo.width} ${geo.height}`}
          aria-hidden="true"
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerUnits="userSpaceOnUse"
              markerWidth={ARROW_LEN}
              markerHeight={ARROW_LEN}
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {edges.map((edge) => {
            const path = pathById.get(edge.id);
            return path ? (
              <path
                key={edge.id}
                d={pathD(path)}
                fill="none"
                stroke="currentColor"
                strokeWidth={STROKE}
                strokeDasharray={edge.style.startsWith("dashed") ? "8 6" : undefined}
                markerEnd={edge.style.endsWith("arrow") ? `url(#${markerId})` : undefined}
              />
            ) : null;
          })}
        </svg>
        {edges.map(renderLabel)}
        {all.map(renderNode)}
      </div>
      </div>
      </div>
    </div>
  );

  const at = (align: string) =>
    (["nodes", "edges"] as Kind[]).filter((k) => trays[k]?.align === align).map(renderTray);
  // Below the WIDE breakpoint, side trays stack: left ones above the frame, right ones below.
  const sides = (align: "left" | "right") => (wide ? [] : at(align));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-3">
      <MeasureLabels candidates={candidates} onMeasure={onMeasure} />
      {at("top")}
      {sides("left")}
      <div className="flex min-h-0 flex-1 flex-row items-stretch gap-3">
        {wide && at("left")}
        {diagram}
        {wide && at("right")}
      </div>
      {sides("right")}
      {at("bottom")}
      {selected && (
        <p className="text-center text-xs text-zinc-500">
          Now choose where “{selected.text}” goes, or press Escape.
        </p>
      )}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      {dragging && (
        <div
          data-l0183-drop={dropMeaning()}
          className={classNames(
            "pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-lg border-2 bg-white px-3 py-1 text-sm shadow-lg dark:bg-zinc-800 dark:text-zinc-100",
            { place: "border-blue-500", none: "border-blue-500", wrong: "border-dashed border-red-400 opacity-70", return: "border-dashed border-zinc-400 opacity-70" }[dropMeaning()],
          )}
          // Above the pointer, so neither it nor a finger hides the blank it is over.
          style={{ left: drag!.x, top: drag!.y - 20 }}
        >
          <RichText text={drag.text} imageBox={{ w: 64, h: 40 }} />
        </div>
      )}
    </div>
  );
}
