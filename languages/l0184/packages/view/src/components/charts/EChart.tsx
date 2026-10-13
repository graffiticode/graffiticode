// SPDX-License-Identifier: MIT
/**
 * One ECharts instance, and the rules for when it is created, resized, replaced and disposed.
 *
 * - It is created only once its container is visible and has a size. ECharts measures its
 *   container at `init`; a hidden (0×0) container gives a 0×0 chart that stays wrong.
 * - A ResizeObserver resizes it, skipping the zero-size updates a hidden tab reports, and the
 *   chart is resized again when it is revealed.
 * - On recompile, it is left alone when its render config is unchanged (see `lib/config.ts`),
 *   replaced with `notMerge` when it changed — which resets its zoom and legend selections —
 *   and recreated when theme, renderer or locale changed, since those are fixed at `init`.
 * - It is disposed on unmount, never on a tab switch: a hidden chart keeps its state.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { type ECharts, getECharts } from "../../lib/echarts";
import { initKey, renderKey } from "../../lib/config";

export interface EChartProps {
  option: Record<string, any>;
  formats?: Record<string, any>;
  width: number | string;
  height: number;
  theme: "light" | "dark";
  renderer: "canvas" | "svg";
  locale: string;
  /** Whether this chart's panel is showing. */
  active: boolean;
  /** Test seam: the ECharts module. */
  lib?: ECharts;
}

const sized = (el: HTMLElement | null): boolean => !!el && el.clientWidth > 0 && el.clientHeight > 0;

export const EChart = ({ option, formats, width, height, theme, renderer, locale, active, lib = getECharts() }: EChartProps) => {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<any>(null);
  const applied = useRef<{ init: string; render: string } | null>(null);
  const latest = useRef({ option, formats, theme, renderer, locale });
  latest.current = { option, formats, theme, renderer, locale };

  /** Create the instance if it does not exist and the container can hold it. */
  const ensure = () => {
    if (chart.current || !sized(el.current)) return;
    const { option: o, formats: f, theme: t, renderer: r, locale: l } = latest.current;
    chart.current = lib.init(el.current!, t === "dark" ? "dark" : null, { renderer: r, locale: l });
    chart.current.setOption(o, { notMerge: true });
    applied.current = { init: initKey(t, r, l), render: renderKey(o, f) };
  };

  const dispose = () => {
    chart.current?.dispose();
    chart.current = null;
    applied.current = null;
  };

  // Observe the container for its whole life; resize only when it has a size.
  useEffect(() => {
    const node = el.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (!box || box.width === 0 || box.height === 0) return;
      if (chart.current) chart.current.resize();
      else ensure();
    });
    ro.observe(node);
    return () => {
      ro.disconnect();
      dispose();
    };
  }, []);

  // Reveal: create on first showing, and re-measure on every showing after that.
  useLayoutEffect(() => {
    if (!active) return;
    if (chart.current) chart.current.resize();
    else ensure();
  }, [active]);

  // Recompile: recreate for an init-time change, replace for a render change, else nothing.
  useEffect(() => {
    if (!chart.current || !applied.current) return;
    const init = initKey(theme, renderer, locale);
    const render = renderKey(option, formats);
    if (init !== applied.current.init) {
      dispose();
      ensure();
      return;
    }
    if (render !== applied.current.render) {
      chart.current.setOption(option, { notMerge: true });
      applied.current = { init, render };
    }
  }, [option, formats, theme, renderer, locale]);

  return <div ref={el} className="l0184-echart" style={{ width, height }} data-testid="echart" />;
};
