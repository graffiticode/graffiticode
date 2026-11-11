// SPDX-License-Identifier: MIT
/**
 * Content that can never be bigger than its box.
 *
 * Prose wraps at `maxW` — `overflow-wrap: anywhere`, so even one unbreakable word breaks rather
 * than running out. Anything still too big after wrapping (typeset math, which does not wrap, or
 * a great deal of text) is scaled down uniformly to fit, and the FitBox's own layout box is the
 * scaled size. What is drawn is therefore never larger than what was measured, which is what
 * lets the layout reserve room from a measurement.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function FitBox({ maxW, maxH, children }: { maxW: number; maxH: number; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ w: number; h: number; k: number } | null>(null);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => {
      const w = Math.max(el.scrollWidth, el.offsetWidth);
      const h = Math.max(el.scrollHeight, el.offsetHeight);
      if (!w || !h) return;
      const k = Math.min(1, maxW / w, maxH / h);
      setFit((f) => (f && f.w === w && f.h === h && f.k === k ? f : { w, h, k }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [maxW, maxH, children]);

  const k = fit?.k ?? 1;
  return (
    <div
      style={{
        width: fit ? fit.w * k : undefined,
        height: fit ? fit.h * k : undefined,
        maxWidth: maxW,
        maxHeight: maxH,
        overflow: "hidden",
      }}
    >
      <div
        ref={inner}
        style={{
          width: "max-content",
          maxWidth: maxW,
          whiteSpace: "normal",
          overflowWrap: "anywhere",
          transform: k < 1 ? `scale(${k})` : undefined,
          transformOrigin: "top left",
        }}
      >
        {children}
      </div>
    </div>
  );
}
