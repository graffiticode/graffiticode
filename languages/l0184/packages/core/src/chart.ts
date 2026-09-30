// SPDX-License-Identifier: MIT
/**
 * One chart: its parts resolved, checked and lowered to an ECharts option.
 *
 * Order matters and is fixed: datasets are selected, every column reference is resolved, the
 * plots' family is settled, axes are normalized and plots bound to them by id, and only then are
 * data shapes checked — so an error can name the chart, the plot and the column it came from.
 *
 * Families decide what may share a chart. Cartesian plots (BAR, LINE, SCATTER, BOXPLOT,
 * CANDLESTICK) share X and Y axes; HISTOGRAM, HEATMAP, FUNNEL and PIE each take a chart of their
 * own; GAUGEs sit side by side, one to four; RADAR plots share one RADIAL axis.
 */
import { assertKnownAttributes, KINDS, labelPositions, plotKindAttributes, sourceWord } from "./attributes.js";
import { resolveColor, resolveColors } from "./colors.js";
import { type Cell, type Dataset, resolveData, scopeDatasets, selectDataset } from "./data.js";
import { boxplot, constantRange, histogram, niceCeil } from "./stats.js";

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

type Direction = "X" | "Y" | "RADIAL";
type Scale = "CATEGORY" | "LINEAR" | "LOG" | "TIME";

interface Axis {
  id: string;
  direction: Direction;
  scale: Scale;
  categories?: string[];
  name?: string;
  position: string;
  offset: number;
  minValue?: number | string;
  maxValue?: number | string;
  inverse?: boolean;
  rotate?: number;
  index: number;
  where: string;
}

type Kind = (typeof KINDS)[number];
type Family = "cartesian" | "single" | "gauge" | "radar";
type Resolve = (v: any, prop: string, w: string, shape?: "flat" | "nested") => { values: any[]; column?: string };

interface Plot {
  id: string;
  kind: Kind;
  name: string;
  where: string;
  src: any;
  /** How the plot is written: over categories, as x/y pairs, or as slices; other kinds are their own. */
  form: "category" | "xy" | "slices" | "hist" | "box" | "candle" | "heat" | "gauge" | "radar";
  values?: Cell[];
  names?: string[];
  x?: Cell[];
  y?: Cell[];
  xAxis?: Axis;
  yAxis?: Axis;
  base?: Axis;
  /** HISTOGRAM: bin labels and counts. */
  bins?: { labels: string[]; counts: number[] };
  /** BOXPLOT: observations flat with their groups, or (and once bound) one list per category. */
  observations?: number[];
  groups?: string[];
  nested?: number[][];
  /** CANDLESTICK: the four columns. */
  ohlc?: { open: number[]; close: number[]; low: number[]; high: number[] };
  /** HEATMAP: a matrix (rows = Y), bound to `[xIndex, yIndex, value]` cells. */
  matrix?: (number | null)[][];
  cells?: [number, number, number][];
  /** GAUGE. */
  gauge?: { value: number; min: number; max: number };
}

const FAMILY: Record<Kind, Family> = {
  BAR: "cartesian",
  LINE: "cartesian",
  SCATTER: "cartesian",
  BOXPLOT: "cartesian",
  CANDLESTICK: "cartesian",
  HISTOGRAM: "single",
  HEATMAP: "single",
  FUNNEL: "single",
  PIE: "single",
  GAUGE: "gauge",
  RADAR: "radar",
};
const MAX_GAUGES = 4;

const q = (s: string) => JSON.stringify(s);
const lower = (tag: string) => tag.toLowerCase();
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const listOf = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0]);

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

function sameLength(w: string, cols: [string, unknown[]][]): void {
  const [a, av] = cols[0];
  for (const [b, bv] of cols.slice(1)) {
    if (av.length !== bv.length) throw new Error(`${w}: ${a} has ${av.length} items but ${b} has ${bv.length}. They pair up, so they must be the same length.`);
  }
}

/* ------------------------------------------------------------------ axes */

function normalizeAxes(recs: any[], where: string, resolve: Resolve, defaultScale: Scale = "LINEAR"): Axis[] {
  const count: Record<Direction, number> = { X: 0, Y: 0, RADIAL: 0 };
  const axes: Axis[] = recs.map((rec, i) => {
    const w = `${where} axis ${rec.id ? q(rec.id) : i + 1}`;
    if (!rec.direction) throw new Error(`${w}: needs a direction, X, Y or RADIAL, e.g. axis direction X {}.`);
    const direction = rec.direction as Direction;
    const radial = direction === "RADIAL";
    const n = ++count[direction];
    if (radial && rec.scale !== undefined && rec.scale !== "CATEGORY") {
      throw new Error(`${w}: a RADIAL axis is CATEGORY — its categories are the spokes — not ${rec.scale}.`);
    }
    const scale: Scale = radial ? "CATEGORY" : (rec.scale ?? (rec.categories !== undefined ? "CATEGORY" : defaultScale));
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
      where: w,
    };
    if (rec.categories !== undefined) {
      if (scale !== "CATEGORY") throw new Error(`${w}: categories belong on a CATEGORY axis; this axis is ${scale}.`);
      const cats = labels(resolve(rec.categories, "categories", w).values, "categories", w);
      const dup = cats.find((c, j) => cats.indexOf(c) !== j);
      if (dup !== undefined) throw new Error(`${w}: the ${radial ? "spoke" : "category"} ${q(dup)} appears twice. ${radial ? "Spokes" : "Categories"} must differ.`);
      axis.categories = cats;
    }
    for (const b of ["minValue", "maxValue"] as const) {
      const v = rec[b];
      if (v === undefined) continue;
      const word = sourceWord(b);
      if (radial) {
        if (typeof v !== "number") throw new Error(`${w}: ${word} must be a number on a RADIAL axis, got ${q(String(v))}.`);
      } else if (scale === "CATEGORY") {
        throw new Error(`${w}: ${word} does not apply to a CATEGORY axis.`);
      } else if (scale === "TIME") {
        if (!(typeof v === "number" || !Number.isNaN(Date.parse(v)))) throw new Error(`${w}: ${word} ${q(String(v))} is not a date.`);
      } else if (typeof v !== "number") {
        throw new Error(`${w}: ${word} must be a number on a ${scale} axis, got ${q(String(v))}.`);
      } else if (scale === "LOG" && !(v > 0)) {
        throw new Error(`${w}: ${word} is ${v}, but a LOG axis only shows values above 0.`);
      }
      axis[b] = v;
    }
    if (typeof axis.minValue === "number" && typeof axis.maxValue === "number" && axis.minValue >= axis.maxValue) {
      throw new Error(`${w}: min-value (${axis.minValue}) must be less than max-value (${axis.maxValue}).`);
    }
    if (radial) {
      for (const word of ["position", "rotate"]) {
        if (rec[word] !== undefined) throw new Error(`${w}: a RADIAL axis has no ${word}; its spokes are spaced evenly around the circle.`);
      }
      if (!axis.categories) throw new Error(`${w}: a RADIAL axis needs categories, one per spoke, e.g. categories ["Speed" "Power" "Range"].`);
      if (axis.categories.length < 3) throw new Error(`${w}: a RADIAL axis needs at least 3 spokes; it has ${axis.categories.length}. For fewer, use a BAR chart.`);
      return axis;
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

const isNested = (v: any) => Array.isArray(v) && v.some((row) => Array.isArray(row));

function normalizePlot(rec: any, i: number, where: string, resolve: Resolve): Plot {
  const w = `${where} plot ${rec.id ? q(rec.id) : i + 1}`;
  if (!rec.kind) throw new Error(`${w}: needs a kind, one of ${KINDS.join(", ")}, e.g. plot kind BAR values [1 2 3] {}.`);
  const kind = rec.kind as Kind;
  const allowed = plotKindAttributes[kind];
  const stray = Object.keys(rec).map(sourceWord).find((k) => !allowed.includes(k));
  if (stray) {
    const kinds = Object.keys(plotKindAttributes).filter((k) => plotKindAttributes[k].includes(stray));
    throw new Error(`${w}: \`${stray}\` does not apply to a ${kind} plot. A ${kind} plot takes: ${allowed.join(", ")}.${kinds.length ? ` \`${stray}\` is for ${kinds.join(", ")} plots.` : ""}`);
  }
  const plot: Plot = { id: rec.id ?? `p${i + 1}`, kind, name: "", where: w, src: rec, form: "category" };
  let column: string | undefined;
  const need = (prop: string) => {
    if (rec[prop] === undefined) throw new Error(`${w}: a ${kind} plot needs ${sourceWord(prop)}.`);
    return resolve(rec[prop], sourceWord(prop), w);
  };
  const needNumbers = (prop: string) => numbers(need(prop).values, prop, w, { nulls: false }) as number[];

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
  } else if (kind === "PIE" || kind === "FUNNEL") {
    plot.form = "slices";
    plot.names = labels(need("names").values, "names", w);
    const r = need("values");
    column = r.column;
    plot.values = numbers(r.values, "values", w, { nulls: false });
    plot.values.forEach((v, j) => {
      if ((v as number) < 0) throw new Error(`${w}: values item ${j + 1} is ${v}; a ${kind} ${kind === "PIE" ? "slice" : "stage"} cannot be negative.`);
    });
  } else if (kind === "HISTOGRAM") {
    plot.form = "hist";
    if (isNested(rec.values)) {
      throw new Error(`${w}: a HISTOGRAM counts raw observations, so values is one flat list, e.g. values [3 7 7 9 12]. To draw counts you already have, use a BAR.`);
    }
    const r = need("values");
    column = r.column;
    const obs = numbers(r.values, "values", w, { nulls: false }) as number[];
    const k = rec.binCount;
    if (k !== undefined && !(Number.isInteger(k) && k > 0)) throw new Error(`${w}: bin-count must be a whole number above 0, got ${k}.`);
    plot.bins = histogram(obs, k);
  } else if (kind === "BOXPLOT") {
    plot.form = "box";
    if (isNested(rec.values)) {
      if (rec.group !== undefined) {
        throw new Error(`${w}: values is a list of lists, which already groups the observations by category. Remove group, or write values as one flat list with group.`);
      }
      const rows = resolve(rec.values, "values", w, "nested").values as Cell[][];
      plot.nested = rows.map((row, j) => numbers(row, `values list ${j + 1}`, w, { nulls: false }) as number[]);
    } else {
      if (typeof rec.values === "string" && rec.group === undefined) resolve(rec.values, "values", w, "nested");
      if (rec.values !== undefined && rec.group === undefined) {
        throw new Error(`${w}: a BOXPLOT needs its observations grouped by category: values with group (the category of each value), or values as a list of lists, one per category.`);
      }
      const r = need("values");
      column = r.column;
      plot.observations = numbers(r.values, "values", w, { nulls: false }) as number[];
      plot.groups = labels(need("group").values, "group", w);
      sameLength(w, [["values", plot.observations], ["group", plot.groups]]);
    }
  } else if (kind === "CANDLESTICK") {
    plot.form = "candle";
    const [open, close, low, high] = ["open", "close", "low", "high"].map(needNumbers);
    column = resolve(rec.close, "close", w).column;
    sameLength(w, [["open", open], ["close", close], ["low", low], ["high", high]]);
    open.forEach((o, j) => {
      const c = close[j];
      const rule = "low must be at most both, and high at least both.";
      if (low[j] > Math.min(o, c)) throw new Error(`${w}: row ${j + 1} has low ${low[j]} above its open (${o}) or close (${c}). ${rule}`);
      if (high[j] < Math.max(o, c)) throw new Error(`${w}: row ${j + 1} has high ${high[j]} below its open (${o}) or close (${c}). ${rule}`);
    });
    plot.ohlc = { open, close, low, high };
  } else if (kind === "HEATMAP") {
    plot.form = "heat";
    if (rec.x !== undefined || rec.y !== undefined) {
      if (isNested(rec.values)) {
        throw new Error(`${w}: write a HEATMAP either as a matrix (values as rows of cells) or as cells (x, y and values, one each), not both.`);
      }
      if (rec.x === undefined || rec.y === undefined || rec.values === undefined) {
        throw new Error(`${w}: a HEATMAP written as cells needs x, y and values, one of each per cell.`);
      }
      plot.x = labels(resolve(rec.x, "x", w).values, "x", w);
      plot.y = labels(resolve(rec.y, "y", w).values, "y", w);
      const r = resolve(rec.values, "values", w);
      column = r.column;
      plot.values = numbers(r.values, "values", w, { nulls: true });
      sameLength(w, [["x", plot.x], ["y", plot.y], ["values", plot.values]]);
    } else {
      if (typeof rec.values === "string") resolve(rec.values, "values", w, "nested");
      if (!isNested(rec.values)) {
        throw new Error(`${w}: a HEATMAP needs values as a matrix — one list of cells per Y category, e.g. values [[1 2] [3 4]] — or x, y and values, one of each per cell.`);
      }
      const rows = resolve(rec.values, "values", w, "nested").values as Cell[][];
      plot.matrix = rows.map((row, j) => numbers(row, `values row ${j + 1}`, w, { nulls: true }) as (number | null)[]);
    }
  } else if (kind === "GAUGE") {
    plot.form = "gauge";
    if (rec.value === undefined) throw new Error(`${w}: a GAUGE plot needs value, e.g. plot kind GAUGE value 72 {}.`);
    const min = rec.minValue ?? 0;
    const max = rec.maxValue ?? 100;
    for (const [word, v] of [["min-value", min], ["max-value", max]] as const) {
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${w}: ${word} must be a number for a GAUGE, got ${q(String(v))}.`);
    }
    if (!(min < max)) throw new Error(`${w}: min-value (${min}) must be less than max-value (${max}).`);
    const value = rec.value;
    if (!Number.isFinite(value)) throw new Error(`${w}: value must be a finite number, got ${value}.`);
    if (value < min || value > max) {
      throw new Error(`${w}: value ${value} is off the dial, which runs from ${min} to ${max}. Set min-value or max-value to include it.`);
    }
    plot.gauge = { value, min, max };
  } else {
    plot.form = "radar";
    const r = need("values");
    column = r.column;
    plot.values = numbers(r.values, "values", w, { nulls: false });
  }

  const pairs: [string, Cell[] | string[] | undefined, string, Cell[] | string[] | undefined][] = [
    ["x", plot.form === "xy" ? plot.x : undefined, "y", plot.y],
    ["names", plot.names, plot.form === "xy" ? "y" : "values", plot.form === "xy" ? plot.y : plot.values],
  ];
  for (const [a, av, b, bv] of pairs) {
    if (av && bv && av.length !== bv.length) throw new Error(`${w}: ${a} has ${av.length} items but ${b} has ${bv.length}. They pair up, so they must be the same length.`);
  }
  if (rec.stack !== undefined && plot.form !== "category") throw new Error(`${w}: stack groups plots over categories; it does not apply to a plot of x/y pairs.`);
  plot.name = rec.name ?? column ?? `Series ${i + 1}`;
  return plot;
}

/** How many category steps a plot on a category axis fills. */
const steps = (p: Plot): number => (p.form === "candle" ? p.ohlc!.open.length : p.form === "box" ? p.nested!.length : p.values!.length);

/** Bind a Cartesian plot to its axes and check each value against the axis it lands on. */
function bindPlot(plot: Plot, axes: Axis[]): void {
  const w = plot.where;
  const xa = bindAxis(plot.src.xAxis, "X", axes, w);
  const ya = bindAxis(plot.src.yAxis, "Y", axes, w);
  plot.xAxis = xa;
  plot.yAxis = ya;
  if (plot.form === "xy") {
    if (xa.scale === "CATEGORY" || ya.scale === "CATEGORY") {
      throw new Error(`${w}: a ${plot.kind} of x/y pairs is drawn on numeric or time axes; axis ${q((xa.scale === "CATEGORY" ? xa : ya).id)} is CATEGORY.`);
    }
    if (ya.scale === "TIME") throw new Error(`${w}: y values are drawn on axis ${q(ya.id)}, which is TIME; the Y axis of x/y pairs must be LINEAR or LOG.`);
    plot.x = xa.scale === "TIME" ? timeValues(plot.x!, "x", w) : numbers(plot.x!, "x", w, { nulls: false });
    if (xa.scale === "LOG") positiveOnLog(plot.x!, "x", xa, w);
    if (ya.scale === "LOG") positiveOnLog(plot.y!, "y", ya, w);
    return;
  }
  const cats = [xa, ya].filter((a) => a.scale === "CATEGORY");
  if (cats.length !== 1) {
    const of = plot.form === "category" ? `${plot.kind} of values` : plot.kind;
    throw new Error(
      cats.length
        ? `${w}: both of its axes are CATEGORY; a ${plot.kind} needs one CATEGORY axis for its steps and one numeric axis for its values.`
        : `${w}: a ${of} needs a CATEGORY axis for its steps; axes ${q(xa.id)} and ${q(ya.id)} are ${xa.scale} and ${ya.scale}.${plot.kind === "LINE" ? " For a LINE over numbers or dates, write x and y instead of values." : ""}`,
    );
  }
  const base = cats[0];
  plot.base = base;
  const valueAxis = base === xa ? ya : xa;
  if (valueAxis.scale === "TIME") throw new Error(`${w}: values are drawn on axis ${q(valueAxis.id)}, which is TIME; use LINEAR or LOG for values.`);
  const log = valueAxis.scale === "LOG";
  if (plot.form === "category" && log) positiveOnLog(plot.values!, "values", valueAxis, w);
  if (plot.form === "candle" && log) {
    for (const k of ["open", "close", "low", "high"] as const) positiveOnLog(plot.ohlc![k], k, valueAxis, w);
  }
  if (plot.form === "box") {
    if (plot.groups) {
      // The flat form: groups follow the axis's categories when given, else first-seen order.
      if (base.categories) {
        plot.groups.forEach((g, j) => {
          if (!base.categories!.includes(g)) {
            throw new Error(`${w}: group item ${j + 1} is ${q(g)}, which is not a category of axis ${q(base.id)}. Its categories are: ${base.categories!.map(q).join(", ")}.`);
          }
        });
      } else {
        base.categories = [...new Set(plot.groups)];
      }
      plot.nested = base.categories.map((c) => plot.observations!.filter((_, j) => plot.groups![j] === c));
    }
    if (log) plot.nested!.forEach((row) => positiveOnLog(row, "values", valueAxis, w));
  }
}

/** A CATEGORY axis's steps: as written, or 1..n when left out; every plot on it must fit. */
function settleCategories(axis: Axis, plots: Plot[], where: string): void {
  const on = plots.filter((p) => p.base === axis);
  if (axis.categories) {
    for (const p of on) {
      const n = steps(p);
      const k = axis.categories.length;
      if (n === k) continue;
      if (p.form === "box") throw new Error(`${p.where}: has ${n} lists of values but axis ${q(axis.id)} has ${k} categories. Give one list per category ([] for none).`);
      if (p.form === "candle") throw new Error(`${p.where}: has ${plural(n, "row")} but axis ${q(axis.id)} has ${k} categories. Give one open, close, low and high per category.`);
      throw new Error(`${p.where}: has ${n} values but axis ${q(axis.id)} has ${k} categories. Give one value per category (null for a gap).`);
    }
    return;
  }
  const lengths = [...new Set(on.map(steps))];
  if (lengths.length > 1) {
    throw new Error(`${where}: plots on axis ${q(axis.id)} have different lengths (${on.map((p) => `${q(p.id)}: ${steps(p)}`).join(", ")}). Give the axis categories, one per value.`);
  }
  axis.categories = Array.from({ length: lengths[0] ?? 0 }, (_, j) => String(j + 1));
}

/* ------------------------------------------------------------------ families */

/** Which plots may share this chart: one family, and within the one-plot families one plot. */
function checkFamilies(plots: Plot[], where: string): Family {
  const special = plots.find((p) => FAMILY[p.kind] !== "cartesian");
  if (!special) return "cartesian";
  const fam = FAMILY[special.kind];
  const other = plots.find((p) => p !== special && (FAMILY[p.kind] !== fam || (fam === "single" && p.kind !== special.kind)));
  if (other) {
    throw new Error(`${where}: a ${special.kind} cannot share a chart with ${other.kind} plots. Put the ${lower(special.kind)} in its own chart in the collection.`);
  }
  if (fam === "single" && plots.length > 1) {
    throw new Error(`${where}: a chart holds one ${special.kind}; put each ${lower(special.kind)} in its own chart.`);
  }
  if (fam === "gauge" && plots.length > MAX_GAUGES) {
    throw new Error(`${where}: a chart holds at most ${MAX_GAUGES} gauges side by side; this one has ${plots.length}. Put the rest in another chart.`);
  }
  return fam;
}

/** A HISTOGRAM's axes are generated; an author may only name them (and pick their ids). */
function histogramAxes(parts: ChartParts, plot: Plot, where: string, resolve: Resolve): Axis[] {
  const byDir: Record<string, any> = {};
  (parts.axes?.items ?? []).forEach((rec, i) => {
    const w = `${where} axis ${rec.id ? q(rec.id) : i + 1}`;
    const want = rec.direction === "X" ? "CATEGORY" : rec.direction === "Y" ? "LINEAR" : undefined;
    if (!want) throw new Error(`${w}: a HISTOGRAM is drawn on one X axis and one Y axis, not ${rec.direction ?? "an axis without a direction"}.`);
    const extra = Object.keys(rec).map(sourceWord).find((k) => !["id", "direction", "scale", "name"].includes(k));
    if (extra) {
      throw new Error(`${w}: a HISTOGRAM's axes are generated — bins across a CATEGORY X axis, counts up a LINEAR Y axis — so an axis here takes only id, direction, scale and name, not \`${extra}\`.`);
    }
    if (byDir[rec.direction]) throw new Error(`${where}: a HISTOGRAM has one ${rec.direction} axis; remove the others.`);
    if (rec.scale !== undefined && rec.scale !== want) throw new Error(`${w}: a HISTOGRAM's ${rec.direction} axis is ${want}, not ${rec.scale}.`);
    byDir[rec.direction] = rec;
  });
  const axes = normalizeAxes([{ ...byDir.X, direction: "X", scale: "CATEGORY" }, { ...byDir.Y, direction: "Y", scale: "LINEAR" }], where, resolve);
  plot.xAxis = bindAxis(plot.src.xAxis, "X", axes, plot.where);
  plot.yAxis = bindAxis(plot.src.yAxis, "Y", axes, plot.where);
  plot.base = plot.xAxis;
  plot.xAxis.categories = plot.bins!.labels;
  return axes;
}

/** A HEATMAP: both axes CATEGORY; cells become `[xIndex, yIndex, value]`, empty cells left out. */
function bindHeatmap(plot: Plot, axes: Axis[]): void {
  const w = plot.where;
  const xa = bindAxis(plot.src.xAxis, "X", axes, w);
  const ya = bindAxis(plot.src.yAxis, "Y", axes, w);
  plot.xAxis = xa;
  plot.yAxis = ya;
  for (const a of [xa, ya]) {
    if (a.scale !== "CATEGORY") throw new Error(`${w}: a HEATMAP is a grid of categories, so both axes are CATEGORY; axis ${q(a.id)} is ${a.scale}.`);
  }
  const cells: [number, number, number][] = [];
  if (plot.matrix) {
    for (const a of [xa, ya]) {
      if (!a.categories) throw new Error(`${w}: a HEATMAP written as a matrix needs categories on both axes, to name its rows and columns. Axis ${q(a.id)} has none.`);
    }
    const [cols, rows] = [xa.categories!, ya.categories!];
    if (plot.matrix.length !== rows.length) {
      throw new Error(`${w}: values has ${plural(plot.matrix.length, "row")} but axis ${q(ya.id)} has ${rows.length} categories. A HEATMAP matrix has one row per Y category.`);
    }
    plot.matrix.forEach((row, yi) => {
      if (row.length !== cols.length) {
        throw new Error(`${w}: values row ${yi + 1} has ${plural(row.length, "cell")} but axis ${q(xa.id)} has ${cols.length} categories. Each row has one cell per X category (null for none).`);
      }
      row.forEach((v, xi) => {
        if (v !== null) cells.push([xi, yi, v]);
      });
    });
  } else {
    const xs = plot.x as string[];
    const ys = plot.y as string[];
    const index = (a: Axis, vals: string[], prop: string) => {
      if (!a.categories) a.categories = [...new Set(vals)];
      return vals.map((v, j) => {
        const k = a.categories!.indexOf(v);
        if (k < 0) throw new Error(`${w}: ${prop} item ${j + 1} is ${q(v)}, which is not a category of axis ${q(a.id)}. Its categories are: ${a.categories!.map(q).join(", ")}.`);
        return k;
      });
    };
    const xi = index(xa, xs, "x");
    const yi = index(ya, ys, "y");
    const seen = new Map<string, number>();
    xi.forEach((x, j) => {
      const key = `${x},${yi[j]}`;
      if (seen.has(key)) {
        throw new Error(`${w}: the cell (${q(xs[j])}, ${q(ys[j])}) is given twice, at items ${seen.get(key)! + 1} and ${j + 1}. Give each cell once.`);
      }
      seen.set(key, j);
      const v = plot.values![j];
      if (v !== null) cells.push([x, yi[j], v as number]);
    });
  }
  plot.cells = cells;
}

/** RADAR bounds: min defaults to 0; max is explicit, or a round number above the largest value. */
function radarBounds(axis: Axis, plots: Plot[]): { min: number; max: number } {
  const min = (axis.minValue as number | undefined) ?? 0;
  let max = axis.maxValue as number | undefined;
  for (const p of plots) {
    if (p.values!.length !== axis.categories!.length) {
      throw new Error(`${p.where}: has ${p.values!.length} values but axis ${q(axis.id)} has ${axis.categories!.length} spokes. Give one value per spoke.`);
    }
  }
  if (max === undefined) {
    let top = -Infinity;
    for (const p of plots) for (const v of p.values as number[]) if (v > top) top = v;
    max = top > min ? min + niceCeil(top - min) : min + 1;
    // At large magnitudes `min + 1` is `min`, and the round number or the sum can overflow.
    if (!(Number.isFinite(max) && min < max)) {
      throw new Error(`${axis.where}: no max-value can be chosen above min-value ${min} for these values: at this size, no round number above them can be represented. Write both min-value and max-value on the axis.`);
    }
  }
  for (const p of plots) {
    (p.values as number[]).forEach((v, j) => {
      if (v < min || v > max!) {
        const hint = v < min && axis.minValue === undefined
          ? " A RADIAL axis starts at 0 unless you set min-value."
          : ` Widen the axis's ${v < min ? "min-value" : "max-value"} to include it.`;
        throw new Error(`${p.where}: values item ${j + 1} is ${v}, outside axis ${q(axis.id)}, which runs from ${min} to ${max}.${hint}`);
      }
    });
  }
  return { min, max };
}

/* ------------------------------------------------------------------ lowering */

const AXIS_TYPE: Record<string, string> = { CATEGORY: "category", LINEAR: "value", LOG: "log", TIME: "time" };

function lowerAxis(a: Axis, extra: Record<string, any> = {}): Record<string, any> {
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
    ...extra,
  };
}

/**
 * Series ids are generated, never an authored id as written: `p:<plot id>` for a plot's series,
 * `g:<plot id>:<role>` for a series it adds. Plot ids are unique per chart and the prefixes keep
 * the two apart, so no authored id can collide with a generated one.
 */
const plotId = (p: Plot) => `p:${p.id}`;
const genId = (p: Plot, role: string) => `g:${p.id}:${role}`;

function sliceColors(p: Plot, noun: string): string[] | undefined {
  const colors = p.src.colors !== undefined ? resolveColors(p.src.colors, `${p.where} colors`) : undefined;
  if (colors && colors.length !== p.names!.length) throw new Error(`${p.where}: colors has ${colors.length} colours but there are ${p.names!.length} ${noun}.`);
  return colors;
}

interface Frame {
  pieCenter: [string, string];
  box: { left: number; right: number; top: number; bottom: number };
  /** This plot's place among the chart's plots, for gauges side by side. */
  slot: [number, number];
}

function lowerSeries(p: Plot, label: Record<string, any> | undefined, frame: Frame): Record<string, any>[] {
  const r = p.src;
  const color = r.color !== undefined ? resolveColor(r.color, `${p.where} color`) : undefined;
  const common = { id: plotId(p), name: p.name, ...(color ? { color } : {}), ...(label ? { label } : {}) };
  const slices = (noun: string) => {
    const colors = sliceColors(p, noun);
    return p.names!.map((name, j) => ({ name, value: p.values![j], ...(colors ? { itemStyle: { color: colors[j] } } : {}) }));
  };
  if (p.kind === "PIE") {
    const outer = r.radius ?? "70%";
    return [{
      ...common,
      type: "pie",
      data: slices("slices"),
      radius: r.innerRadius !== undefined ? [r.innerRadius, outer] : outer,
      center: frame.pieCenter,
      ...(r.rose ? { roseType: lower(r.rose) } : {}),
      ...(r.startAngle !== undefined ? { startAngle: r.startAngle } : {}),
    }];
  }
  if (p.kind === "FUNNEL") {
    return [{ ...common, type: "funnel", sort: "descending", ...frame.box, data: slices("stages") }];
  }
  if (p.kind === "GAUGE") {
    const [i, n] = frame.slot;
    const g = p.gauge!;
    // Side by side, a dial's tick labels and split lines crowd it; several gauges show only the
    // arc, the pointer, the name and the reading.
    const compact = n > 1
      ? { axisLabel: { show: false }, splitLine: { length: 6 }, axisTick: { show: false }, title: { offsetCenter: [0, "70%"], fontSize: 12 }, detail: { offsetCenter: [0, "40%"], fontSize: 18 } }
      : {};
    return [{
      ...common,
      type: "gauge",
      center: [`${((i + 0.5) / n) * 100}%`, "55%"],
      radius: `${Math.min(75, 90 / n)}%`,
      min: g.min,
      max: g.max,
      data: [{ value: g.value, name: r.name ?? "" }],
      ...compact,
      ...(color ? { itemStyle: { color }, progress: { show: true } } : {}),
    }];
  }
  if (p.kind === "RADAR") {
    return [{ ...common, type: "radar", data: [{ name: p.name, value: p.values, ...(r.area ? { areaStyle: {} } : {}) }] }];
  }
  const axes = { xAxisIndex: p.xAxis!.index, yAxisIndex: p.yAxis!.index };
  if (p.kind === "HEATMAP") return [{ ...common, ...axes, type: "heatmap", data: p.cells }];
  if (p.kind === "HISTOGRAM") {
    // Touching bars: the bins are adjacent ranges, not separate categories.
    return [{ ...common, ...axes, type: "bar", barCategoryGap: "0%", data: p.bins!.counts, itemStyle: { borderColor: "rgba(128,128,128,0.35)", borderWidth: 1 } }];
  }
  const vertical = p.base === p.xAxis;
  if (p.kind === "BOXPLOT") {
    const stats = p.nested!.map(boxplot);
    const outliers = stats.flatMap((s, j) => s.outliers.map((v) => (vertical ? [j, v] : [v, j])));
    // Both series carry the plot's name, so one legend entry toggles the box and its outliers,
    // and the palette (assigned by name) colours them alike.
    return [
      { ...common, ...axes, type: "boxplot", layout: vertical ? "horizontal" : "vertical", data: stats.map((s) => s.box ?? []) },
      { id: genId(p, "outliers"), name: p.name, ...(color ? { color } : {}), ...axes, type: "scatter", data: outliers },
    ];
  }
  if (p.kind === "CANDLESTICK") {
    const { open, close, low, high } = p.ohlc!;
    // Rising green, falling red: ECharts defaults to the reverse.
    const [up, down] = ["#16a34a", "#dc2626"];
    return [{
      ...common,
      ...axes,
      type: "candlestick",
      layout: vertical ? "horizontal" : "vertical",
      itemStyle: { color: up, color0: down, borderColor: up, borderColor0: down },
      data: open.map((o, j) => [o, close[j], low[j], high[j]]),
    }];
  }
  const pairs = p.form === "xy" ? p.x!.map((x, j) => [x, p.y![j]]) : undefined;
  if (p.kind === "BAR") {
    const colors = r.colors !== undefined ? resolveColors(r.colors, `${p.where} colors`) : undefined;
    if (colors && colors.length !== p.values!.length) throw new Error(`${p.where}: colors has ${colors.length} colours but there are ${p.values!.length} bars.`);
    return [{
      ...common,
      ...axes,
      type: "bar",
      data: colors ? p.values!.map((v, j) => ({ value: v, itemStyle: { color: colors[j] } })) : p.values,
      ...(r.stack !== undefined ? { stack: r.stack } : {}),
      ...(r.barWidth !== undefined ? { barWidth: r.barWidth } : {}),
    }];
  }
  const marker = {
    ...(r.symbol !== undefined ? { symbol: r.symbol === "RECT" ? "rect" : lower(r.symbol) } : {}),
    ...(r.symbolSize !== undefined ? { symbolSize: r.symbolSize } : {}),
  };
  if (p.kind === "LINE") {
    return [{
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
    }];
  }
  return [{ ...common, ...axes, ...marker, type: "scatter", data: p.names ? pairs!.map((value, j) => ({ name: p.names![j], value })) : pairs }];
}

/** Whether a plot has nothing to draw. A gauge always has its reading. */
function isEmpty(p: Plot): boolean {
  switch (p.form) {
    case "slices":
      return !p.values!.some((v) => (v as number) > 0);
    case "xy":
      return !p.y!.some((v) => v !== null);
    case "hist":
      return p.bins!.counts.length === 0;
    case "box":
      return p.nested!.every((row) => row.length === 0);
    case "candle":
      return p.ohlc!.open.length === 0;
    case "heat":
      return p.cells!.length === 0;
    case "gauge":
      return false;
    default:
      return !p.values!.some((v) => v !== null);
  }
}

const kindWord: Record<Kind, string> = {
  BAR: "bar",
  LINE: "line",
  PIE: "pie",
  SCATTER: "scatter",
  HISTOGRAM: "histogram",
  BOXPLOT: "box",
  CANDLESTICK: "candlestick",
  HEATMAP: "heatmap",
  FUNNEL: "funnel",
  GAUGE: "gauge",
  RADAR: "radar",
};

/** A one-sentence summary for screen readers, when the author gave no description. */
function summarize(title: string | undefined, name: string, plots: Plot[]): string {
  const head = title ?? name;
  const p0 = plots[0];
  if (p0.kind === "PIE") return `${head}: a pie chart of ${p0.names!.length} slices.`;
  if (p0.kind === "FUNNEL") return `${head}: a funnel of ${p0.names!.length} stages.`;
  if (p0.kind === "HISTOGRAM") return `${head}: a histogram of ${p0.bins!.counts.reduce((a, b) => a + b, 0)} values in ${p0.bins!.counts.length} bins.`;
  if (p0.kind === "HEATMAP") return `${head}: a heatmap of ${p0.xAxis!.categories!.length} by ${p0.yAxis!.categories!.length} cells.`;
  const parts = plots.map((p) => (p.kind === "GAUGE" ? `gauge ${q(p.name)} reading ${p.gauge!.value}` : `${kindWord[p.kind]} plot ${q(p.name)}`));
  return `${head}: ${listOf(parts)}.`;
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
  const resolve: Resolve = (v, prop, w, shape = "flat") => resolveData(v, prop, selected, visible, w, shape);

  // Plots, and which of them may share this chart.
  const plots = parts.plots.items.map((rec, i) => normalizePlot(rec, i, where, resolve));
  const seenPlot = new Map<string, Plot>();
  for (const p of plots) {
    if (seenPlot.has(p.id)) throw new Error(`${where}: two plots have the id ${q(p.id)}. Give each plot its own id.`);
    seenPlot.set(p.id, p);
  }
  const family = checkFamilies(plots, where);
  const single = family === "single" ? plots[0] : undefined;
  const sliced = single?.form === "slices" ? single : undefined;
  const heat = single?.kind === "HEATMAP" ? single : undefined;

  // Axes, by family.
  let axes: Axis[] = [];
  let radar: { axis: Axis; min: number; max: number } | undefined;
  const needXY = () => {
    for (const d of ["X", "Y"] as const) {
      if (!axes.some((a) => a.direction === d)) throw new Error(`${where}: axes has no ${d} axis. Add axis direction ${d} … {}.`);
    }
    const radial = axes.find((a) => a.direction === "RADIAL");
    if (radial) throw new Error(`${radial.where}: a RADIAL axis holds the spokes of RADAR plots, and this chart's plots are ${plots[0].kind}. Remove it, or put the radar in its own chart.`);
  };
  if (family === "cartesian") {
    if (parts.axes) {
      axes = normalizeAxes(parts.axes.items, where, resolve);
      needXY();
    } else {
      const byCategory = plots.some((p) => p.form !== "xy");
      axes = normalizeAxes([{ direction: "X", scale: byCategory ? "CATEGORY" : "LINEAR" }, { direction: "Y", scale: "LINEAR" }], where, resolve);
    }
    plots.forEach((p) => bindPlot(p, axes));
    // ECharts offsets box plots that share a base category axis, which outliers drawn at the
    // category centre would not follow; one box plot per category axis keeps them aligned.
    const boxes = plots.filter((p) => p.kind === "BOXPLOT");
    boxes.forEach((b, j) => {
      const other = boxes.slice(0, j).find((o) => o.base === b.base);
      if (other) {
        throw new Error(`${where}: plots ${q(other.id)} and ${q(b.id)} are both BOXPLOTs on category axis ${q(b.base!.id)}. Put each box plot on its own category axis, or in its own chart.`);
      }
    });
    axes.filter((a) => a.scale === "CATEGORY").forEach((a) => settleCategories(a, plots, where));
  } else if (single?.kind === "HISTOGRAM") {
    axes = histogramAxes(parts, single, where, resolve);
  } else if (heat) {
    axes = normalizeAxes(parts.axes?.items ?? [{ direction: "X" }, { direction: "Y" }], where, resolve, "CATEGORY");
    needXY();
    bindHeatmap(heat, axes);
  } else if (family === "radar") {
    const recs = parts.axes?.items ?? [];
    if (!recs.length) throw new Error(`${where}: a RADAR plot needs a RADIAL axis for its spokes. Add axes [ axis direction RADIAL categories ["…" "…" "…"] {} ] {}.`);
    axes = normalizeAxes(recs, where, resolve);
    const flat = axes.find((a) => a.direction !== "RADIAL");
    if (flat) throw new Error(`${flat.where}: a RADAR chart is drawn on one RADIAL axis; it has no ${flat.direction} axis. Remove it.`);
    if (axes.length > 1) throw new Error(`${where}: a RADAR chart has one RADIAL axis, shared by its plots; this one has ${axes.length}.`);
    radar = { axis: axes[0], ...radarBounds(axes[0], plots) };
  } else if (parts.axes) {
    throw new Error(`${where}: a ${plots[0].kind} has no axes. Remove \`axes\` from this chart.`);
  }

  // Legend: shown by default for several plots, or a pie's or funnel's slices; off for gauges.
  // Selection is by name, so names shown in a legend must differ — two entries with one name
  // would toggle together. This checks authored plots, before any generated series is added.
  if (parts.legend) assertKnownAttributes("legend", parts.legend, `${where} legend`);
  if (parts.tooltip) assertKnownAttributes("tooltip", parts.tooltip, `${where} tooltip`);
  const legendRec = parts.legend ?? {};
  const legendShow = legendRec.show ?? (family !== "gauge" && (plots.length > 1 || !!sliced));
  const legendPos = legendRec.position ?? "BOTTOM";
  if (!["TOP", "BOTTOM", "LEFT", "RIGHT"].includes(legendPos)) throw new Error(`${where} legend: position is TOP, BOTTOM, LEFT or RIGHT, not ${legendPos}.`);
  if (legendShow) {
    if (sliced) {
      const names = sliced.names!;
      const dup = names.findIndex((n, j) => names.indexOf(n) !== j);
      if (dup >= 0) {
        const noun = sliced.kind === "PIE" ? "slice" : "stage";
        throw new Error(`${sliced.where}: two ${noun}s are named ${q(names[dup])} (items ${names.indexOf(names[dup]) + 1} and ${dup + 1}). Legend entries toggle ${noun}s by name, so give each ${noun} its own name, or hide the legend with legend show false {}.`);
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
  const byCategory = family === "cartesian" && plots.some((p) => p.form !== "xy");
  const trigger = tooltipRec.trigger ?? (byCategory ? "AXIS" : "ITEM");
  option.tooltip = { show: tooltipRec.show ?? true, trigger: lower(trigger) };

  const pieCenter: [string, string] = [
    `${50 + (legendPos === "LEFT" && legendShow ? 8 : 0) - (legendPos === "RIGHT" && legendShow ? 8 : 0)}%`,
    `${50 + (titleH ? 6 : 0) + (legendPos === "TOP" && legendShow ? 4 : 0) - (legendPos === "BOTTOM" && legendShow ? 4 : 0)}%`,
  ];
  const box = {
    left: 16 + legendBand.LEFT,
    right: 16 + legendBand.RIGHT,
    top: 16 + titleH + legendBand.TOP,
    bottom: 16 + legendBand.BOTTOM,
  };

  // A heatmap's colour scale is generated from its cells, on the side the legend is not on.
  if (heat && heat.cells!.length) {
    const vals = heat.cells!.map((c) => c[2]);
    let [min, max] = [Math.min(...vals), Math.max(...vals)];
    if (min === max) [min, max] = constantRange(min);
    const side = legendShow && legendPos === "RIGHT" ? "left" : "right";
    option.visualMap = { type: "continuous", dimension: 2, min, max, calculable: true, orient: "vertical", [side]: 8, top: "middle" };
    box[side] += 72;
  }

  if (axes.length && !radar) {
    option.grid = { ...box, outerBoundsMode: "same", outerBoundsContain: "all" };
    const cellAxes = heat ? { boundaryGap: true, splitArea: { show: true } } : {};
    // Prices sit far from 0, so a value axis under a candlestick fits the data rather than
    // starting at 0 (`min-value` still wins).
    const priced = new Set(plots.filter((p) => p.kind === "CANDLESTICK").map((p) => (p.base === p.xAxis ? p.yAxis : p.xAxis)));
    const fit = (a: Axis) => (priced.has(a) ? { scale: true } : {});
    option.xAxis = axes.filter((a) => a.direction === "X").map((a) => lowerAxis(a, { ...cellAxes, ...fit(a) }));
    // A heatmap reads like its matrix: the first Y category is the top row (`inverse` flips it).
    option.yAxis = axes.filter((a) => a.direction === "Y").map((a) => lowerAxis(a, heat ? { ...cellAxes, inverse: !a.inverse } : fit(a)));
  }
  if (radar) {
    // One scalar range on every spoke: per-spoke scales are a documented limitation.
    option.radar = { indicator: radar.axis.categories!.map((c) => ({ name: c, min: radar.min, max: radar.max })), center: pieCenter, radius: "65%" };
  }
  option.series = plots.flatMap((p, i) => {
    let label = checkLabel(p.src.label, p.kind, p.where);
    // A named scatter point is labelled with its name unless the author said otherwise.
    if (!label && p.kind === "SCATTER" && p.names) label = { show: true, position: "top", formatter: "{b}" };
    return lowerSeries(p, label, { pieCenter, box, slot: [i, plots.length] });
  });

  const description = settings.description ?? summarize(title, name, plots);
  option.aria = { enabled: true, label: { enabled: true, description } };

  if (settings.height !== undefined && !(settings.height > 0)) throw new Error(`${where}: height must be above 0 pixels, got ${settings.height}.`);
  return {
    id,
    name,
    option,
    view: { width: settings.width ?? "100%", height: settings.height ?? 384, empty: plots.every(isEmpty), description },
  };
}
