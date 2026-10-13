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
 * Moving an answer works three ways, because each one fails somebody:
 *
 * - DRAG with pointer events, not the HTML5 drag-and-drop API — HTML5 DnD never fires on touch,
 *   which is why L0169's tray did nothing on a tablet. Everything draggable is `touch-none`, or
 *   the browser takes the finger for scrolling and cancels the pointer.
 * - SELECT THEN PLACE: activate a tray item (click, tap, Enter or Space), then activate a blank.
 *   This is the keyboard path, and it is also what a tap does.
 * - CLEAR: activate a filled blank with nothing selected, or press Delete on it, and its answer
 *   goes back to the tray.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { layout, segment, SPACE, type Box } from "../../lib/layout";
import { available, shuffle, type TrayItem } from "../../lib/tray";
import { RichText } from "../../lib/text";
import type { CellScore } from "../../scoring";
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

const pct = (v: number) => `${(v / SPACE) * 100}%`;

/** A node's font size, in container-width units so it scales with the diagram. */
function fontSize(box: Box, text: string | undefined): string {
  const len = (text || "").length;
  const shrink = len > 40 ? 0.62 : len > 22 ? 0.78 : 1;
  return `${((box.w / 190) * 2.3 * shrink).toFixed(2)}cqw`;
}

export function Web({
  interaction,
  placed,
  onPlace,
  scores,
  disabled = false,
}: {
  interaction: Interaction;
  /** Blank id -> the answer in it. */
  placed: Record<string, string | undefined>;
  onPlace: (changes: Record<string, string | null>) => void;
  /** Per-blank feedback. Absent means feedback is not being shown. */
  scores?: Record<string, CellScore>;
  disabled?: boolean;
}) {
  const { hub, nodes, edges, trays } = interaction;
  const boxes = useMemo(() => layout(hub, nodes), [hub, nodes]);
  const byId = useMemo(() => new Map(boxes.map((b) => [b.id, b])), [boxes]);
  const all = useMemo(() => [hub, ...nodes], [hub, nodes]);
  const blankKind = (id: string): Kind | undefined =>
    all.some((n) => n.id === id && n.blank)
      ? "nodes"
      : edges.some((e) => e.id === id && e.blank)
        ? "edges"
        : undefined;

  // One marker id per instance: a fixed id collides when two webs share a page, and the second
  // web's arrows then point with the first web's arrowheads.
  const markerId = `l0183-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const [selected, setSelected] = useState<Held | null>(null);
  const [drag, setDrag] = useState<(Held & { x: number; y: number }) | null>(null);
  const dragStart = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    if (disabled) setSelected(null);
  }, [disabled]);

  const trayItems = (kind: Kind) => {
    const tray = trays[kind];
    if (!tray) return [];
    const ids = Object.keys(interaction.cells).filter((id) => blankKind(id) === kind);
    return available(shuffle(tray.items), ids.map((id) => placed[id]));
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
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ ...held, x: e.clientX, y: e.clientY });
  };

  const moveDrag = (e: ReactPointerEvent) => {
    if (!drag || !dragStart.current) return;
    if (Math.hypot(e.clientX - dragStart.current.x, e.clientY - dragStart.current.y) > 4) {
      dragStart.current.moved = true;
    }
    setDrag({ ...drag, x: e.clientX, y: e.clientY });
  };

  /** Returns true when the gesture was a drag, so the click that follows is ignored. */
  const endDrag = (e: ReactPointerEvent): boolean => {
    const moved = !!dragStart.current?.moved;
    const held = drag;
    dragStart.current = null;
    setDrag(null);
    if (!held || !moved) return false;
    const target = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest("[data-l0183-blank]") as HTMLElement | null;
    const blank = target?.dataset.l0183Blank;
    if (blank) put(held, blank);
    else if (held.from) clear(held.from); // dropped off the web: back to the tray
    setSelected(null);
    return true;
  };

  const suppressClick = useRef(false);
  const dragHandlers = (held: Held) => ({
    onPointerDown: (e: ReactPointerEvent) => beginDrag(e, held),
    onPointerMove: moveDrag,
    onPointerUp: (e: ReactPointerEvent) => {
      suppressClick.current = endDrag(e);
    },
    onPointerCancel: () => {
      dragStart.current = null;
      setDrag(null);
    },
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
    const box = byId.get(node.id)!;
    const isHub = node.id === hub.id;
    const value = node.blank ? placed[node.id] : node.text;
    const colour =
      feedback(node.id) ??
      (node.color ? NODE_COLORS[node.color] : isHub ? HUB_DEFAULT : NODE_DEFAULT);
    const style = {
      left: pct(box.x - box.w / 2),
      top: pct(box.y - box.h / 2),
      width: pct(box.w),
      height: pct(box.h),
      fontSize: fontSize(box, value),
    };
    const face = classNames(
      "absolute z-10 flex items-center justify-center overflow-hidden border-2 p-[0.6cqw] text-center leading-tight",
      SHAPE_CLASS[node.shape || "rounded"],
      colour,
    );
    if (!node.blank) {
      return (
        <div key={node.id} className={face} style={style}>
          <div className="flex h-full min-w-0 w-full items-center justify-center">
            <RichText text={node.text || ""} />
          </div>
        </div>
      );
    }
    const selectable = !!selected && selected.kind === "nodes";
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
          !value && !feedback(node.id) && "bg-zinc-50 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-500",
          selectable && "ring-4 ring-blue-400/60",
          value && !disabled && "touch-none",
          "cursor-pointer focus-visible:outline focus-visible:outline-4 focus-visible:outline-blue-500 disabled:cursor-default",
        )}
        style={style}
        onClick={unlessDragged(() => activateBlank(node.id))}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") clear(node.id);
        }}
        {...(value && !disabled ? dragHandlers({ kind: "nodes", text: value, from: node.id }) : {})}
      >
        <span className="flex h-full min-w-0 w-full items-center justify-center">
          {value ? <RichText text={value} /> : <span aria-hidden="true">?</span>}
        </span>
      </button>
    );
  };

  const lines = edges.map((edge) => {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    return a && b ? { edge, seg: segment(a, b) } : null;
  });

  const renderLabel = ({ edge, seg }: { edge: WebEdge; seg: ReturnType<typeof segment> }) => {
    const value = edge.blank ? placed[edge.id] : edge.label;
    if (!edge.blank && !edge.label) return null;
    const style = { left: pct(seg.mx), top: pct(seg.my), fontSize: "1.9cqw" };
    const base =
      "absolute z-20 max-w-[30%] -translate-x-1/2 -translate-y-1/2 rounded-full border px-[1cqw] py-[0.3cqw] text-center leading-tight";
    if (!edge.blank) {
      return (
        <div
          key={edge.id}
          className={classNames(
            base,
            "border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200",
          )}
          style={style}
        >
          <RichText text={edge.label!} />
        </div>
      );
    }
    const selectable = !!selected && selected.kind === "edges";
    return (
      <button
        key={edge.id}
        type="button"
        data-l0183-blank={edge.id}
        disabled={disabled}
        aria-label={blankLabel(edge.id, "Line label blank")}
        className={classNames(
          base,
          "min-w-[10%] cursor-pointer border-2 focus-visible:outline focus-visible:outline-4 focus-visible:outline-blue-500 disabled:cursor-default",
          feedback(edge.id) ??
            (value
              ? "border-zinc-400 bg-white text-zinc-900 dark:border-zinc-500 dark:bg-zinc-800 dark:text-zinc-100"
              : "border-dashed border-zinc-400 bg-zinc-50 text-zinc-400 dark:border-zinc-500 dark:bg-zinc-900"),
          selectable && "ring-4 ring-blue-400/60",
          value && !disabled && "touch-none",
        )}
        style={style}
        onClick={unlessDragged(() => activateBlank(edge.id))}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") clear(edge.id);
        }}
        {...(value && !disabled ? dragHandlers({ kind: "edges", text: value, from: edge.id }) : {})}
      >
        {value ? <RichText text={value} /> : <span aria-hidden="true">?</span>}
      </button>
    );
  };

  const renderTray = (kind: Kind) => {
    const tray = trays[kind];
    if (!tray) return null;
    const items = trayItems(kind);
    const vertical = tray.align === "left" || tray.align === "right";
    return (
      <div
        key={kind}
        role="group"
        aria-label={kind === "nodes" ? "Answers" : "Line labels"}
        className={classNames(
          "flex flex-wrap content-start gap-2 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-800/60",
          vertical ? "w-full sm:w-44 sm:flex-col" : "w-full justify-center",
        )}
      >
        {items.length === 0 && (
          <span className="text-xs text-zinc-400">
            {kind === "nodes" ? "Every answer is placed." : "Every label is placed."}
          </span>
        )}
        {items.map((item) => {
          const isSelected = selected?.kind === kind && selected.text === item.text && !selected.from;
          return (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              aria-pressed={isSelected}
              className={classNames(
                "flex min-h-10 touch-none select-none items-center justify-center border-2 px-3 py-1 text-sm leading-tight shadow-sm",
                kind === "nodes" ? "rounded-lg" : "rounded-full",
                isSelected
                  ? "border-blue-500 bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-100"
                  : "border-zinc-300 bg-zinc-50 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100",
                disabled ? "cursor-default opacity-60" : "cursor-grab active:cursor-grabbing",
                "focus-visible:outline focus-visible:outline-4 focus-visible:outline-blue-500",
              )}
              onClick={unlessDragged(() =>
                setSelected(isSelected ? null : { kind, text: item.text }),
              )}
              {...dragHandlers({ kind, text: item.text })}
            >
              <span className="max-h-16 max-w-full">
                <RichText text={item.text} />
              </span>
            </button>
          );
        })}
      </div>
    );
  };

  const diagram = (
    <div
      className="relative mx-auto aspect-square w-full max-w-[640px] select-none [container-type:inline-size]"
      onKeyDown={(e) => {
        if (e.key === "Escape") setSelected(null);
      }}
    >
      <svg
        className="absolute inset-0 h-full w-full text-zinc-400 dark:text-zinc-500"
        viewBox={`0 0 ${SPACE} ${SPACE}`}
        aria-hidden="true"
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {lines.map((l) =>
          l ? (
            <line
              key={l.edge.id}
              x1={l.seg.x1}
              y1={l.seg.y1}
              x2={l.seg.x2}
              y2={l.seg.y2}
              stroke="currentColor"
              strokeWidth={3}
              strokeDasharray={l.edge.style.startsWith("dashed") ? "12 9" : undefined}
              markerEnd={l.edge.style.endsWith("arrow") ? `url(#${markerId})` : undefined}
            />
          ) : null,
        )}
      </svg>
      {lines.map((l) => (l ? renderLabel(l) : null))}
      {all.map(renderNode)}
    </div>
  );

  const at = (align: string) =>
    (["nodes", "edges"] as Kind[]).filter((k) => trays[k]?.align === align).map(renderTray);

  return (
    <div className="flex flex-col gap-3">
      {at("top")}
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start">
        {at("left")}
        <div className="min-w-0 flex-1">{diagram}</div>
        {at("right")}
      </div>
      {at("bottom")}
      {selected && (
        <p className="text-center text-xs text-zinc-500">
          Now choose where “{selected.text}” goes, or press Escape.
        </p>
      )}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      {drag && dragStart.current?.moved && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-lg border-2 border-blue-500 bg-white px-3 py-1 text-sm shadow-lg dark:bg-zinc-800 dark:text-zinc-100"
          style={{ left: drag.x, top: drag.y }}
        >
          <RichText text={drag.text} />
        </div>
      )}
    </div>
  );
}
