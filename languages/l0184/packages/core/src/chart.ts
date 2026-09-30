// SPDX-License-Identifier: MIT
/**
 * One chart: its parts resolved, checked and lowered to an ECharts option.
 *
 * Order matters and is fixed: datasets are selected, every column reference is resolved, axes
 * are normalized and plots bound to them by id, and only then are data shapes checked — so an
 * error can name the chart, the plot and the column it came from.
 */
import { assertKnownAttributes, labelPositions, plotKindAttributes, sourceWord } from "./attributes.js";
import { resolveColor, resolveColors } from "./colors.js";
import { type Cell, type Dataset, resolveData, scopeDatasets, selectDataset } from "./data.js";

export interface ChartParts {
  datasets?: { items: any[] };
  axes?: { items: any[] };
  plots: { items: any[] };
  legend?: any;
  tooltip?: any;
}

export interface CompiledChart {
  id: string;
  name: string;
  option: Record<string, any>;
  view: { width: number | string; height: number; empty: boolean; description: string };
}

interface Axis {
  id: string;
  direction: "X" | "Y";
  scale: "CATEGORY" | "LINEAR" | "LOG" | "TIME";
  categories?: string[];
  name?: string;
  position: string;
  offset: number;
  minValue?: number | string;
  maxValue?: number | string;
  inverse?: boolean;
  rotate?: number;
  index: number;
}

interface Plot {
  id: string;
  kind: "BAR" | "LINE" | "PIE" | "SCATTER";
  name: string;
  where: string;
  src: any;
  form: "category" | "xy" | "slices";
  values?: Cell[];
  names?: string[];
  x?: Cell[];
  y?: Cell[];
  xAxis?: Axis;
  yAxis?: Axis;
  base?: Axis;
}

const CARTESIAN = new Set(["BAR", "LINE", "SCATTER"]);
const q = (s: string) => JSON.stringify(s);
const lower = (tag: string) => tag.toLowerCase();

/* ------------------------------------------------------------------ values */

function numbers(values: Cell[], prop: string, where: string, { nulls }: { nulls: boolean }): Cell[] {
  values.forEach((v, i) => {
    if (v === null) {
      if (!nulls) throw new Error(`${where}: ${prop} item ${i + 1} is null. A missing value is only allowed where the plot can show a gap.`);
      return;
    }
    if (typeof v !== "number") throw new Error(`${where}: ${prop} item ${i + 1} is ${q(String(v))}, not a number.`);
  });
  return values;
}

function labels(values: Cell[], prop: string, where: string): string[] {
  return values.map((v, i) => {
    if (v === null || typeof v === "boolean") throw new Error(`${where}: ${prop} item ${i + 1} must be a name in "quotes" or a number, got ${String(v)}.`);
    return String(v);
  });
}

function timeValues(values: Cell[], prop: string, where: string): Cell[] {
  values.forEach((v, i) => {
    const ok = (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && !Number.isNaN(Date.parse(v)));
    if (!ok) throw new Error(`${where}: ${prop} item ${i + 1} is ${v === null ? "null" : q(String(v))}, not a date (e.g. "2026-03-01") or a millisecond timestamp.`);
  });
  return values;
}

function positiveOnLog(values: Cell[], prop: string, axis: Axis, where: string): void {
  values.forEach((v, i) => {
    if (typeof v === "number" && !(v > 0)) {
      throw new Error(`${where}: ${prop} item ${i + 1} is ${v}, but axis ${q(axis.id)} is LOG, which only shows values above 0.`);
    }
  });
}

/* ------------------------------------------------------------------ axes */

function normalizeAxes(recs: any[], where: string, resolve: (v: any, prop: string, w: string) => { values: Cell[] }): Axis[] {
  const count = { X: 0, Y: 0 };
  const axes: Axis[] = recs.map((rec, i) => {
    const w = `${where} axis ${rec.id ? q(rec.id) : i + 1}`;
    if (!rec.direction) throw new Error(`${w}: needs a direction, X or Y, e.g. axis direction X {}.`);
    const direction = rec.direction as "X" | "Y";
    const n = ++count[direction];
    const scale = rec.scale ?? (rec.categories !== undefined ? "CATEGORY" : "LINEAR");
    const axis: Axis = {
      id: rec.id ?? `${direction.toLowerCase()}${n}`,
      direction,
      scale,
      position: "",
      offset: 0,
      index: n - 1,
      name: rec.name,
      inverse: rec.inverse,
      rotate: rec.rotate,
    };
    if (rec.categories !== undefined) {
      if (scale !== "CATEGORY") throw new Error(`${w}: categories belong on a CATEGORY axis; this axis is ${scale}.`);
      const cats = labels(resolve(rec.categories, "categories", w).values, "categories", w);
      const dup = cats.find((c, j) => cats.indexOf(c) !== j);
      if (dup !== undefined) throw new Error(`${w}: the category ${q(dup)} appears twice. Categories must differ.`);
      axis.categories = cats;
    }
    for (const b of ["minValue", "maxValue"] as const) {
      const v = rec[b];
      if (v === undefined) continue;
      const word = sourceWord(b);
      if (scale === "CATEGORY") throw new Error(`${w}: ${word} does not apply to a CATEGORY axis.`);
      if (scale === "TIME") {
        if (!(typeof v === "number" || !Number.isNaN(Date.parse(v)))) throw new Error(`${w}: ${word} ${q(String(v))} is not a date.`);
      } else if (typeof v !== "number") {
        throw new Error(`${w}: ${word} must be a number on a ${scale} axis, got ${q(String(v))}.`);
      } else if (scale === "LOG" && !(v > 0)) {
        throw new Error(`${w}: ${word} is ${v}, but a LOG axis only shows values above 0.`);
      }
      axis[b] = v;
    }
    if (axis.minValue !== undefined && axis.maxValue !== undefined && typeof axis.minValue === "number" && typeof axis.maxValue === "number" && axis.minValue >= axis.maxValue) {
      throw new Error(`${w}: min-value (${axis.minValue}) must be less than max-value (${axis.maxValue}).`);
    }
    if (rec.rotate !== undefined && (rec.rotate < -90 || rec.rotate > 90)) throw new Error(`${w}: rotate must be between -90 and 90, got ${rec.rotate}.`);
    const legal = direction === "X" ? ["BOTTOM", "TOP"] : ["LEFT", "RIGHT"];
    if (rec.position !== undefined && !legal.includes(rec.position)) {
      throw new Error(`${w}: an ${direction} axis sits at ${legal.join(" or ")}, not ${rec.position}.`);
    }
    axis.position = rec.position ?? (n === 1 ? legal[0] : legal[1]);
    return axis;
  });
  const seen = new Map<string, Axis>();
  for (const a of axes) {
    if (seen.has(a.id)) throw new Error(`${where}: two axes have the id ${q(a.id)}. Give each axis its own id.`);
    seen.set(a.id, a);
  }
  // Axes that share a side are pushed outward so they do not draw over each other.
  for (const a of axes) {
    a.offset = 56 * axes.filter((b) => b.index < a.index && b.direction === a.direction && b.position === a.position).length;
  }
  return axes;
}

function bindAxis(ref: string | undefined, direction: "X" | "Y", axes: Axis[], where: string): Axis {
  const word = direction === "X" ? "x-axis" : "y-axis";
  const candidates = axes.filter((a) => a.direction === direction);
  if (ref !== undefined) {
    const a = axes.find((b) => b.id === ref);
    if (!a) throw new Error(`${where}: ${word} ${q(ref)} names no axis. ${direction} axes here: ${candidates.map((c) => q(c.id)).join(", ") || "none"}.`);
    if (a.direction !== direction) throw new Error(`${where}: ${word} ${q(ref)} is a ${a.direction} axis, not ${direction}.`);
    return a;
  }
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw new Error(`${where}: there is no ${direction} axis to draw against. Add axis direction ${direction} … {} to the chart's axes.`);
  throw new Error(`${where}: there are ${candidates.length} ${direction} axes (${candidates.map((c) => q(c.id)).join(", ")}), so write ${word} "…" to pick one.`);
}

/* ------------------------------------------------------------------ plots */

function checkLabel(rec: any, kind: string, where: string): Record<string, any> | undefined {
  if (rec === undefined) return undefined;
  assertKnownAttributes("label", rec, `${where} label`);
  if (rec.position !== undefined && !labelPositions[kind].includes(rec.position)) {
    throw new Error(`${where} label: a ${kind} label sits at ${labelPositions[kind].join(", ")}, not ${rec.position}.`);
  }
  return {
    show: rec.show ?? true,
    ...(rec.position !== undefined ? { position: lower(rec.position) } : {}),
    ...(rec.formatter !== undefined ? { formatter: rec.formatter } : {}),
  };
}

function normalizePlot(rec: any, i: number, where: string, resolve: (v: any, prop: string, w: string) => { values: Cell[]; column?: string }): Plot {
  const w = `${where} plot ${rec.id ? q(rec.id) : i + 1}`;
  if (!rec.kind) throw new Error(`${w}: needs a kind, one of BAR, LINE, PIE, SCATTER, e.g. plot kind BAR values [1 2 3] {}.`);
  const kind = rec.kind as Plot["kind"];
  const allowed = plotKindAttributes[kind];
  const stray = Object.keys(rec).map(sourceWord).find((k) => !allowed.includes(k));
  if (stray) {
    const kinds = Object.keys(plotKindAttributes).filter((k) => plotKindAttributes[k].includes(stray));
    throw new Error(`${w}: \`${stray}\` does not apply to a ${kind} plot. A ${kind} plot takes: ${allowed.join(", ")}.${kinds.length ? ` \`${stray}\` is for ${kinds.join(", ")} plots.` : ""}`);
  }
  const plot: Plot = { id: rec.id ?? `p${i + 1}`, kind, name: "", where: w, src: rec, form: "category" };
  let column: string | undefined;
  const need = (prop: string) => {
    if (rec[prop] === undefined) throw new Error(`${w}: a ${kind} plot needs ${prop}.`);
    const r = resolve(rec[prop], prop, w);
    return r;
  };

  if (kind === "BAR") {
    const r = need("values");
    column = r.column;
    plot.values = numbers(r.values, "values", w, { nulls: true });
  } else if (kind === "LINE") {
    const xy = rec.x !== undefined || rec.y !== undefined;
    if (xy && rec.values !== undefined) {
      throw new Error(`${w}: write a LINE either with values (one per category) or with x and y (pairs), not both.`);
    }
    if (xy) {
      if (rec.x === undefined || rec.y === undefined) throw new Error(`${w}: a LINE written with pairs needs both x and y.`);
      plot.form = "xy";
      plot.x = resolve(rec.x, "x", w).values;
      const r = resolve(rec.y, "y", w);
      column = r.column;
      plot.y = numbers(r.values, "y", w, { nulls: true });
    } else {
      const r = need("values");
      column = r.column;
      plot.values = numbers(r.values, "values", w, { nulls: true });
    }
    if (rec.smooth && rec.step !== undefined) throw new Error(`${w}: a LINE is smooth or stepped, not both.`);
  } else if (kind === "SCATTER") {
    plot.form = "xy";
    plot.x = need("x").values;
    const r = need("y");
    column = r.column;
    plot.y = numbers(r.values, "y", w, { nulls: true });
    if (rec.names !== undefined) plot.names = labels(resolve(rec.names, "names", w).values, "names", w);
  } else {
    plot.form = "slices";
    plot.names = labels(need("names").values, "names", w);
    const r = need("values");
    column = r.column;
    plot.values = numbers(r.values, "values", w, { nulls: false });
    plot.values.forEach((v, j) => {
      if ((v as number) < 0) throw new Error(`${w}: values item ${j + 1} is ${v}; a PIE slice cannot be negative.`);
    });
  }

  const pairs: [string, Cell[] | string[] | undefined, string, Cell[] | string[] | undefined][] = [
    ["x", plot.x, "y", plot.y],
    ["names", plot.names, plot.form === "xy" ? "y" : "values", plot.form === "xy" ? plot.y : plot.values],
  ];
  for (const [a, av, b, bv] of pairs) {
    if (av && bv && av.length !== bv.length) throw new Error(`${w}: ${a} has ${av.length} items but ${b} has ${bv.length}. They pair up, so they must be the same length.`);
  }
  if (rec.stack !== undefined && plot.form !== "category") throw new Error(`${w}: stack groups plots over categories; it does not apply to a plot of x/y pairs.`);
  plot.name = rec.name ?? column ?? `Series ${i + 1}`;
  return plot;
}

/** Bind a Cartesian plot to its axes and check each value against the axis it lands on. */
function bindPlot(plot: Plot, axes: Axis[]): void {
  const w = plot.where;
  const xa = bindAxis(plot.src.xAxis, "X", axes, w);
  const ya = bindAxis(plot.src.yAxis, "Y", axes, w);
  plot.xAxis = xa;
  plot.yAxis = ya;
  if (plot.form === "category") {
    const cats = [xa, ya].filter((a) => a.scale === "CATEGORY");
    if (cats.length !== 1) {
      throw new Error(
        cats.length
          ? `${w}: both of its axes are CATEGORY; a ${plot.kind} needs one CATEGORY axis for its steps and one numeric axis for its values.`
          : `${w}: a ${plot.kind} of values needs a CATEGORY axis for its steps; axes ${q(xa.id)} and ${q(ya.id)} are ${xa.scale} and ${ya.scale}.${plot.kind === "LINE" ? " For a LINE over numbers or dates, write x and y instead of values." : ""}`,
      );
    }
    plot.base = cats[0];
    const valueAxis = plot.base === xa ? ya : xa;
    if (valueAxis.scale === "TIME") throw new Error(`${w}: values are drawn on axis ${q(valueAxis.id)}, which is TIME; use LINEAR or LOG for values.`);
    if (valueAxis.scale === "LOG") positiveOnLog(plot.values!, "values", valueAxis, w);
  } else {
    if (xa.scale === "CATEGORY" || ya.scale === "CATEGORY") {
      throw new Error(`${w}: a ${plot.kind} of x/y pairs is drawn on numeric or time axes; axis ${q((xa.scale === "CATEGORY" ? xa : ya).id)} is CATEGORY.`);
    }
    if (ya.scale === "TIME") throw new Error(`${w}: y values are drawn on axis ${q(ya.id)}, which is TIME; the Y axis of x/y pairs must be LINEAR or LOG.`);
    plot.x = xa.scale === "TIME" ? timeValues(plot.x!, "x", w) : numbers(plot.x!, "x", w, { nulls: false });
    if (xa.scale === "LOG") positiveOnLog(plot.x!, "x", xa, w);
    if (ya.scale === "LOG") positiveOnLog(plot.y!, "y", ya, w);
  }
}

/** A CATEGORY axis's steps: as written, or 1..n when left out; every plot on it must fit. */
function settleCategories(axis: Axis, plots: Plot[], where: string): void {
  const on = plots.filter((p) => p.base === axis);
  if (axis.categories) {
    for (const p of on) {
      if (p.values!.length !== axis.categories.length) {
        throw new Error(`${p.where}: has ${p.values!.length} values but axis ${q(axis.id)} has ${axis.categories.length} categories. Give one value per category (null for a gap).`);
      }
    }
    return;
  }
  const lengths = [...new Set(on.map((p) => p.values!.length))];
  if (lengths.length > 1) {
    throw new Error(`${where}: plots on axis ${q(axis.id)} have different lengths (${on.map((p) => `${q(p.id)}: ${p.values!.length}`).join(", ")}). Give the axis categories, one per value.`);
  }
  axis.categories = Array.from({ length: lengths[0] ?? 0 }, (_, j) => String(j + 1));
}

/* ------------------------------------------------------------------ lowering */

const AXIS_TYPE: Record<string, string> = { CATEGORY: "category", LINEAR: "value", LOG: "log", TIME: "time" };

function lowerAxis(a: Axis): Record<string, any> {
  return {
    id: a.id,
    type: AXIS_TYPE[a.scale],
    gridIndex: 0,
    position: lower(a.position),
    ...(a.offset ? { offset: a.offset } : {}),
    ...(a.categories ? { data: a.categories } : {}),
    ...(a.name !== undefined ? { name: a.name, nameLocation: "middle" } : {}),
    ...(a.minValue !== undefined ? { min: a.minValue } : {}),
    ...(a.maxValue !== undefined ? { max: a.maxValue } : {}),
    ...(a.inverse ? { inverse: true } : {}),
    ...(a.rotate !== undefined ? { axisLabel: { rotate: a.rotate } } : {}),
  };
}

function lowerSeries(p: Plot, label: Record<string, any> | undefined, center: [string, string]): Record<string, any> {
  const r = p.src;
  const color = r.color !== undefined ? resolveColor(r.color, `${p.where} color`) : undefined;
  const common = { id: p.id, name: p.name, ...(color ? { color } : {}), ...(label ? { label } : {}) };
  if (p.kind === "PIE") {
    const colors = r.colors !== undefined ? resolveColors(r.colors, `${p.where} colors`) : undefined;
    if (colors && colors.length !== p.names!.length) throw new Error(`${p.where}: colors has ${colors.length} colours but there are ${p.names!.length} slices.`);
    const outer = r.radius ?? "70%";
    return {
      ...common,
      type: "pie",
      data: p.names!.map((name, j) => ({ name, value: p.values![j], ...(colors ? { itemStyle: { color: colors[j] } } : {}) })),
      radius: r.innerRadius !== undefined ? [r.innerRadius, outer] : outer,
      center,
      ...(r.rose ? { roseType: lower(r.rose) } : {}),
      ...(r.startAngle !== undefined ? { startAngle: r.startAngle } : {}),
    };
  }
  const axes = { xAxisIndex: p.xAxis!.index + 0, yAxisIndex: p.yAxis!.index + 0 };
  const pairs = p.form === "xy" ? p.x!.map((x, j) => [x, p.y![j]]) : undefined;
  if (p.kind === "BAR") {
    const colors = r.colors !== undefined ? resolveColors(r.colors, `${p.where} colors`) : undefined;
    if (colors && colors.length !== p.values!.length) throw new Error(`${p.where}: colors has ${colors.length} colours but there are ${p.values!.length} bars.`);
    return {
      ...common,
      ...axes,
      type: "bar",
      data: colors ? p.values!.map((v, j) => ({ value: v, itemStyle: { color: colors[j] } })) : p.values,
      ...(r.stack !== undefined ? { stack: r.stack } : {}),
      ...(r.barWidth !== undefined ? { barWidth: r.barWidth } : {}),
    };
  }
  const marker = {
    ...(r.symbol !== undefined ? { symbol: r.symbol === "RECT" ? "rect" : lower(r.symbol) } : {}),
    ...(r.symbolSize !== undefined ? { symbolSize: r.symbolSize } : {}),
  };
  if (p.kind === "LINE") {
    return {
      ...common,
      ...axes,
      ...marker,
      type: "line",
      data: pairs ?? p.values,
      connectNulls: false,
      ...(r.smooth ? { smooth: true } : {}),
      ...(r.area ? { areaStyle: {} } : {}),
      ...(r.step !== undefined ? { step: lower(r.step) } : {}),
      ...(r.stack !== undefined ? { stack: r.stack } : {}),
    };
  }
  return {
    ...common,
    ...axes,
    ...marker,
    type: "scatter",
    data: p.names ? pairs!.map((value, j) => ({ name: p.names![j], value })) : pairs,
  };
}

const kindWord: Record<string, string> = { BAR: "bar", LINE: "line", PIE: "pie", SCATTER: "scatter" };

/** A one-sentence summary for screen readers, when the author gave no description. */
function summarize(title: string | undefined, name: string, plots: Plot[]): string {
  const head = title ?? name;
  if (plots[0]?.kind === "PIE") return `${head}: a pie chart of ${plots[0].names!.length} slices.`;
  const parts = plots.map((p) => `${kindWord[p.kind]} plot ${q(p.name)}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `${head}: ${list}.`;
}

/* ------------------------------------------------------------------ chart */

export function buildChart(
  chart: { parts: ChartParts; settings: any },
  id: string,
  name: string,
  where: string,
  shared: Map<string, Dataset>,
  look: { palette?: string[]; background?: string },
): CompiledChart {
  const { parts, settings } = chart;
  const local = scopeDatasets(parts.datasets?.items ?? [], `${where} datasets`);
  const { selected, visible } = selectDataset(shared, local, settings.datasetId, where);
  const resolve = (v: any, prop: string, w: string) => resolveData(v, prop, selected, visible, w);

  // Plots.
  const plots = parts.plots.items.map((rec, i) => normalizePlot(rec, i, where, resolve));
  const seenPlot = new Map<string, Plot>();
  for (const p of plots) {
    if (seenPlot.has(p.id)) throw new Error(`${where}: two plots have the id ${q(p.id)}. Give each plot its own id.`);
    seenPlot.set(p.id, p);
  }
  const cartesian = plots.filter((p) => CARTESIAN.has(p.kind));
  const pies = plots.filter((p) => p.kind === "PIE");
  if (cartesian.length && pies.length) {
    throw new Error(`${where}: a PIE cannot share a chart with ${cartesian[0].kind} plots. Put the pie in its own chart in the collection.`);
  }
  if (pies.length > 1) throw new Error(`${where}: a chart holds one PIE; put each pie in its own chart.`);

  // Axes.
  let axes: Axis[] = [];
  if (cartesian.length) {
    if (parts.axes) {
      axes = normalizeAxes(parts.axes.items, where, resolve);
      for (const d of ["X", "Y"] as const) {
        if (!axes.some((a) => a.direction === d)) throw new Error(`${where}: axes has no ${d} axis. Add axis direction ${d} … {}.`);
      }
    } else {
      const byCategory = cartesian.some((p) => p.form === "category");
      axes = normalizeAxes(
        [{ direction: "X", scale: byCategory ? "CATEGORY" : "LINEAR" }, { direction: "Y", scale: "LINEAR" }],
        where,
        resolve,
      );
    }
    cartesian.forEach((p) => bindPlot(p, axes));
    axes.filter((a) => a.scale === "CATEGORY").forEach((a) => settleCategories(a, cartesian, where));
  } else if (parts.axes) {
    throw new Error(`${where}: a PIE has no axes. Remove \`axes\` from this chart.`);
  }

  // Legend: shown by default for several plots or a pie. Selection is by name, so names shown
  // in a legend must differ — two entries with one name would toggle together.
  if (parts.legend) assertKnownAttributes("legend", parts.legend, `${where} legend`);
  if (parts.tooltip) assertKnownAttributes("tooltip", parts.tooltip, `${where} tooltip`);
  const legendRec = parts.legend ?? {};
  const legendShow = legendRec.show ?? (plots.length > 1 || pies.length > 0);
  const legendPos = legendRec.position ?? "BOTTOM";
  if (!["TOP", "BOTTOM", "LEFT", "RIGHT"].includes(legendPos)) throw new Error(`${where} legend: position is TOP, BOTTOM, LEFT or RIGHT, not ${legendPos}.`);
  if (legendShow) {
    if (pies.length) {
      const names = pies[0].names!;
      const dup = names.findIndex((n, j) => names.indexOf(n) !== j);
      if (dup >= 0) {
        throw new Error(`${pies[0].where}: two slices are named ${q(names[dup])} (items ${names.indexOf(names[dup]) + 1} and ${dup + 1}). Legend entries toggle slices by name, so give each slice its own name, or hide the legend with legend show false {}.`);
      }
    } else {
      for (const p of plots) {
        const other = plots.find((o) => o !== p && o.name === p.name);
        if (other) {
          throw new Error(`${where}: plots ${q(p.id)} and ${q(other.id)} are both named ${q(p.name)}. Legend entries toggle plots by name, so give each plot its own name, or hide the legend with legend show false {}.`);
        }
      }
    }
  }

  // Layout: title at the top, legend on its side, the plot area in what is left.
  const title = settings.title;
  const titleH = title !== undefined ? (settings.subtitle !== undefined ? 56 : 34) : 0;
  const legendBand = { TOP: 0, BOTTOM: 0, LEFT: 0, RIGHT: 0 } as Record<string, number>;
  if (legendShow) legendBand[legendPos] = legendPos === "TOP" || legendPos === "BOTTOM" ? 30 : 120;
  const option: Record<string, any> = {
    animation: settings.animation ?? true,
    ...(look.palette ? { color: look.palette } : {}),
    // The viewer paints the background (the theme's, or the collection's `background`), so the
    // canvas is transparent unless a background was given — otherwise a dark chart sits in a
    // light frame, or the reverse.
    backgroundColor: look.background ?? "transparent",
  };
  if (title !== undefined) option.title = { text: title, ...(settings.subtitle !== undefined ? { subtext: settings.subtitle } : {}), left: "center", top: 8 };
  if (legendShow) {
    const place =
      legendPos === "TOP" ? { top: 8 + titleH, left: "center" }
        : legendPos === "BOTTOM" ? { bottom: 8, left: "center" }
          : legendPos === "LEFT" ? { left: 8, top: "middle", orient: "vertical" }
            : { right: 8, top: "middle", orient: "vertical" };
    option.legend = { show: true, type: "scroll", ...place };
  }

  const tooltipRec = parts.tooltip ?? {};
  const trigger = tooltipRec.trigger ?? (cartesian.some((p) => p.form === "category") ? "AXIS" : "ITEM");
  option.tooltip = { show: tooltipRec.show ?? true, trigger: lower(trigger) };

  const pieCenter: [string, string] = [
    `${50 + (legendPos === "LEFT" && legendShow ? 8 : 0) - (legendPos === "RIGHT" && legendShow ? 8 : 0)}%`,
    `${50 + (titleH ? 6 : 0) + (legendPos === "TOP" && legendShow ? 4 : 0) - (legendPos === "BOTTOM" && legendShow ? 4 : 0)}%`,
  ];
  if (cartesian.length) {
    option.grid = {
      left: 16 + legendBand.LEFT,
      right: 16 + legendBand.RIGHT,
      top: 16 + titleH + legendBand.TOP,
      bottom: 16 + legendBand.BOTTOM,
      outerBoundsMode: "same",
      outerBoundsContain: "all",
    };
    option.xAxis = axes.filter((a) => a.direction === "X").map(lowerAxis);
    option.yAxis = axes.filter((a) => a.direction === "Y").map(lowerAxis);
  }
  option.series = plots.map((p) => {
    let label = checkLabel(p.src.label, p.kind, p.where);
    // A named scatter point is labelled with its name unless the author said otherwise.
    if (!label && p.kind === "SCATTER" && p.names) label = { show: true, position: "top", formatter: "{b}" };
    return lowerSeries(p, label, pieCenter);
  });

  const description = settings.description ?? summarize(title, name, plots);
  option.aria = { enabled: true, label: { enabled: true, description } };

  const drawable = plots.some((p) =>
    p.form === "slices"
      ? p.values!.some((v) => (v as number) > 0)
      : p.form === "xy"
        ? p.y!.some((v) => v !== null)
        : p.values!.some((v) => v !== null),
  );

  if (settings.height !== undefined && !(settings.height > 0)) throw new Error(`${where}: height must be above 0 pixels, got ${settings.height}.`);
  return {
    id,
    name,
    option,
    view: { width: settings.width ?? "100%", height: settings.height ?? 384, empty: !drawable, description },
  };
}
