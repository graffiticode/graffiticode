// SPDX-License-Identifier: MIT
/**
 * The vocabulary as data.
 *
 * Adding a word is a row in this file: its lexicon entry, its Checker method and its Transformer
 * method are generated from the row, arity included, so a word can never be declared with one
 * arity and handled with another. Never hand-write a word's handler.
 *
 * The style is `console/docs/language-style-typed-chains.md`. Everything that describes one thing
 * is a CHAIN: each word takes its value and the rest of the chain, and the chain ends in a
 * record, so `id "sales" columns ["month" "revenue"] {}` computes `{id, columns}`.
 *
 * Four construct shapes, and only four:
 *
 * - CONTAINER (arity 2): a member list, then a settings chain. `charts`, `chart`, `datasets`,
 *   `axes`, `plots`.
 * - MEMBER (arity 1): one description chain. `dataset`, `axis`, `plot`, `legend`, `tooltip`.
 * - PROPERTY (arity 2): a value, then the rest of the chain. Everything else.
 * - TAG (arity 0): a closed-set value, written bare and uppercase: `kind BAR`, `theme DARK`.
 */

/* ------------------------------------------------------------------ closed sets */

export const THEMES = ["LIGHT", "DARK"] as const;
export const DIRECTIONS = ["X", "Y", "RADIAL"] as const;
export const SCALES = ["CATEGORY", "LINEAR", "LOG", "TIME"] as const;
export const POSITIONS = ["TOP", "BOTTOM", "LEFT", "RIGHT", "INSIDE", "OUTSIDE", "CENTER"] as const;
export const KINDS = ["BAR", "LINE", "PIE", "SCATTER", "HISTOGRAM", "BOXPLOT", "CANDLESTICK", "HEATMAP", "FUNNEL", "GAUGE", "RADAR"] as const;
export const STEPS = ["START", "MIDDLE", "END"] as const;
export const SYMBOLS = ["CIRCLE", "RECT", "TRIANGLE", "DIAMOND", "PIN", "ARROW", "NONE"] as const;
export const ROSES = ["RADIUS", "AREA"] as const;
export const TRIGGERS = ["AXIS", "ITEM"] as const;

/** Every tag, with the line its lexicon entry carries. One entry per spelling. */
export const TAGS: Record<string, string> = {
  LIGHT: "The light theme (the default).",
  DARK: "The dark theme.",
  X: "An axis that runs across (horizontal).",
  Y: "An axis that runs up (vertical).",
  CATEGORY: "An axis of named steps, e.g. months.",
  LINEAR: "An evenly spaced numeric axis.",
  LOG: "A logarithmic numeric axis. Every value on it must be above 0.",
  TIME: "A date/time axis. Values are dates like \"2026-03-01\" or millisecond timestamps.",
  TOP: "At the top.",
  BOTTOM: "At the bottom.",
  LEFT: "At the left.",
  RIGHT: "At the right.",
  INSIDE: "Inside the bar, slice or point.",
  OUTSIDE: "Outside the slice.",
  CENTER: "In the centre of a donut.",
  BAR: "A bar plot: one bar per category.",
  LINE: "A line plot: values over categories, or x/y pairs.",
  PIE: "A pie (or donut, or rose): one slice per name.",
  SCATTER: "A scatter plot: one point per x/y pair.",
  HISTOGRAM: "A histogram: raw values counted into equal-width bins.",
  BOXPLOT: "A box plot: quartiles, whiskers and outliers per category.",
  CANDLESTICK: "A candlestick: open, close, low and high per category.",
  HEATMAP: "A heatmap: a colour per cell of two category axes.",
  FUNNEL: "A funnel: stages narrowing by value.",
  GAUGE: "A gauge: one reading on a dial.",
  RADAR: "A radar (spider) plot: one value per spoke of a RADIAL axis.",
  RADIAL: "The spokes of a radar chart.",
  START: "A step that rises at the start of each interval.",
  MIDDLE: "A step that rises in the middle of each interval.",
  END: "A step that rises at the end of each interval.",
  CIRCLE: "A circle marker.",
  RECT: "A square marker.",
  TRIANGLE: "A triangle marker.",
  DIAMOND: "A diamond marker.",
  PIN: "A pin marker.",
  ARROW: "An arrow marker.",
  NONE: "No marker.",
  RADIUS: "A rose whose slice radius shows the value.",
  AREA: "A rose whose slice area shows the value.",
  AXIS: "A tooltip for everything at the pointer's category.",
  ITEM: "A tooltip for the single bar, slice or point under the pointer.",
};

/* ------------------------------------------------------------------ word metadata */

/**
 * How a value is checked and turned into the field it emits.
 *
 * - `text`: a string (a number is accepted and emitted as a string).
 * - `number`: a finite number.
 * - `bound`: a number, or a date string (on a TIME axis) — checked against the axis later.
 * - `size`: a non-negative number of pixels, or a percentage string like "50%".
 * - `boolean`: a bare `true` or `false`.
 * - `tag`: one of `oneOf`, written bare.
 * - `data`: an inline list, or a string naming a dataset column — resolved in `data.ts`.
 * - `list`: a bracket list, checked by whoever reads it.
 * - `color`: a colour — a Tailwind token ("blue-500") or a hex code ("#3b82f6").
 * - `colors`: a list of colours.
 * - `record`: a nested description ending in `{}` (`label …`).
 */
export type Expects =
  | "text"
  | "number"
  | "bound"
  | "size"
  | "boolean"
  | "tag"
  | "data"
  | "list"
  | "color"
  | "colors"
  | "record";

export interface AttributeMeta {
  field: string;
  expects: Expects;
  oneOf?: readonly string[];
  description: string;
}

/** Arity 2: properties. Each takes its value AND the rest of the chain. */
export const chainFields: Record<string, AttributeMeta> = {
  // Shared by several descriptions.
  ID: {
    field: "id",
    expects: "text",
    description:
      "A name other parts refer to. Charts default to c1, c2, …; datasets to d1, d2, …; axes to x1, y1, …; plots to p1, p2, ….",
  },
  NAME: {
    field: "name",
    expects: "text",
    description:
      "A label people see: a chart's tab name, an axis title, or a plot's legend entry. A plot's name defaults to the column its values come from.",
  },
  TITLE: {
    field: "title",
    expects: "text",
    description: "A heading: above a chart, or, after the outer `]`, above the whole collection.",
  },
  SUBTITLE: { field: "subtitle", expects: "text", description: "A second line under a chart's title." },
  DESCRIPTION: {
    field: "description",
    expects: "text",
    description:
      "What the chart shows, for screen readers. Defaults to a summary generated from its plots.",
  },
  INSTRUCTIONS: {
    field: "instructions",
    expects: "text",
    description: "Guidance shown under the collection's title.",
  },
  THEME: {
    field: "theme",
    expects: "tag",
    oneOf: THEMES,
    description: "The colour scheme for every chart, LIGHT or DARK. Defaults to LIGHT.",
  },
  PALETTE: {
    field: "palette",
    expects: "colors",
    description:
      'The colours plots take in order, e.g. palette ["blue-500" "amber-500" "#10b981"]. Tailwind tokens or hex codes.',
  },
  BACKGROUND: {
    field: "background",
    expects: "color",
    description: "The background colour behind every chart.",
  },
  SHOW_CHART_TABS: {
    field: "showChartTabs",
    expects: "boolean",
    description: "Show a tab per chart. Defaults to true with two or more charts, false with one.",
  },
  SHOW_CHART_MENU: {
    field: "showChartMenu",
    expects: "boolean",
    description: "Show the chart menu, which lists every chart. Defaults to false.",
  },
  DATASET_ID: {
    field: "datasetId",
    expects: "text",
    description:
      "Which dataset a chart's column names refer to. May be left out when exactly one dataset is visible.",
  },
  WIDTH: {
    field: "width",
    expects: "size",
    description: 'A chart\'s width, in pixels or as a percentage like "100%". Defaults to "100%".',
  },
  HEIGHT: {
    field: "height",
    expects: "number",
    description: "A chart's height in pixels. Defaults to 384.",
  },
  ANIMATION: {
    field: "animation",
    expects: "boolean",
    description: "Animate the chart as it draws. Defaults to true.",
  },

  // dataset
  COLUMNS: {
    field: "columns",
    expects: "list",
    description: 'A dataset\'s column names, in order, e.g. columns ["month" "revenue"].',
  },
  ROWS: {
    field: "rows",
    expects: "list",
    description:
      'A dataset\'s rows: lists in column order, e.g. rows [["Jan" 120] ["Feb" 132]], or records, e.g. rows [{month: "Jan" revenue: 120}].',
  },

  // axis
  DIRECTION: {
    field: "direction",
    expects: "tag",
    oneOf: DIRECTIONS,
    description: "Which way an axis runs: X (across), Y (up), or RADIAL (the spokes of a radar chart). Required.",
  },
  SCALE: {
    field: "scale",
    expects: "tag",
    oneOf: SCALES,
    description:
      "An axis's scale: CATEGORY, LINEAR, LOG or TIME. Defaults to CATEGORY when the axis has categories, LINEAR otherwise.",
  },
  CATEGORIES: {
    field: "categories",
    expects: "data",
    description:
      'A CATEGORY axis\'s steps: a list, or the name of a dataset column, e.g. categories "month".',
  },
  MIN_VALUE: {
    field: "minValue",
    expects: "bound",
    description: "Where a numeric, time or RADIAL axis starts, or the bottom of a GAUGE's dial (default 0). Defaults to fitting the data on an axis, 0 on a RADIAL axis.",
  },
  MAX_VALUE: {
    field: "maxValue",
    expects: "bound",
    description: "Where a numeric, time or RADIAL axis ends, or the top of a GAUGE's dial (default 100). On a RADIAL axis it defaults to a round number above the largest value.",
  },
  POSITION: {
    field: "position",
    expects: "tag",
    oneOf: POSITIONS,
    description:
      "Where something sits. An X axis: BOTTOM or TOP. A Y axis: LEFT or RIGHT. A legend: TOP, BOTTOM, LEFT or RIGHT. A label: see its plot kind.",
  },
  INVERSE: {
    field: "inverse",
    expects: "boolean",
    description: "Run an axis the other way. Defaults to false.",
  },
  ROTATE: {
    field: "rotate",
    expects: "number",
    description: "Rotate an axis's labels by this many degrees, from -90 to 90.",
  },

  // plot
  KIND: {
    field: "kind",
    expects: "tag",
    oneOf: KINDS,
    description: "What a plot draws: BAR, LINE, PIE, SCATTER, HISTOGRAM, BOXPLOT, CANDLESTICK, HEATMAP, FUNNEL, GAUGE or RADAR. Required.",
  },
  X_AXIS: {
    field: "xAxis",
    expects: "text",
    description:
      "The id of the X axis a plot is drawn against. May be left out when the chart has one X axis.",
  },
  Y_AXIS: {
    field: "yAxis",
    expects: "text",
    description:
      "The id of the Y axis a plot is drawn against. May be left out when the chart has one Y axis.",
  },
  VALUES: {
    field: "values",
    expects: "data",
    description:
      "A plot's values: a list, or the name of a dataset column. One per category for BAR and LINE, one per spoke for RADAR, one per slice for PIE and FUNNEL, raw observations for HISTOGRAM and BOXPLOT, and rows of cells (or one per x/y pair) for HEATMAP.",
  },
  NAMES: {
    field: "names",
    expects: "data",
    description: "A PIE's or FUNNEL's slice names, or a SCATTER's point names: a list, or a column name.",
  },
  X: {
    field: "x",
    expects: "data",
    description: "The x of each point, for SCATTER and x/y LINE, or each cell's X category for a HEATMAP written as x/y/values: a list, or a column name.",
  },
  Y: {
    field: "y",
    expects: "data",
    description: "The y of each point, for SCATTER and x/y LINE, or each cell's Y category for a HEATMAP written as x/y/values: a list, or a column name.",
  },
  VALUE: {
    field: "value",
    expects: "number",
    description: "A GAUGE's reading: one number within its min-value and max-value (0 to 100 by default).",
  },
  BIN_COUNT: {
    field: "binCount",
    expects: "number",
    description: "How many equal-width bins a HISTOGRAM uses: a whole number above 0. Defaults to Sturges' rule.",
  },
  GROUP: {
    field: "group",
    expects: "data",
    description: 'Which category each BOXPLOT value belongs to, one per value: a list, or a column name, e.g. group "class".',
  },
  OPEN: { field: "open", expects: "data", description: "A CANDLESTICK's opening values, one per category: a list, or a column name." },
  CLOSE: { field: "close", expects: "data", description: "A CANDLESTICK's closing values, one per category: a list, or a column name." },
  LOW: { field: "low", expects: "data", description: "A CANDLESTICK's lowest values, one per category: a list, or a column name." },
  HIGH: { field: "high", expects: "data", description: "A CANDLESTICK's highest values, one per category: a list, or a column name." },
  COLOR: {
    field: "color",
    expects: "color",
    description: 'A plot\'s colour: a Tailwind token like "blue-500", or a hex code.',
  },
  COLORS: {
    field: "colors",
    expects: "colors",
    description: "One colour per bar (BAR) or per slice (PIE), in order.",
  },
  STACK: {
    field: "stack",
    expects: "text",
    description:
      'Stack BAR or LINE plots that share this group name, e.g. stack "total". Category values only.',
  },
  SMOOTH: { field: "smooth", expects: "boolean", description: "Draw a LINE as a smooth curve." },
  AREA: { field: "area", expects: "boolean", description: "Fill the area under a LINE, or inside a RADAR plot." },
  STEP: {
    field: "step",
    expects: "tag",
    oneOf: STEPS,
    description: "Draw a LINE as steps: START, MIDDLE or END. Not with smooth.",
  },
  SYMBOL: {
    field: "symbol",
    expects: "tag",
    oneOf: SYMBOLS,
    description: `The marker on a LINE or SCATTER: ${SYMBOLS.join(", ")}.`,
  },
  SYMBOL_SIZE: {
    field: "symbolSize",
    expects: "number",
    description: "The marker's size in pixels.",
  },
  BAR_WIDTH: {
    field: "barWidth",
    expects: "size",
    description: 'A BAR\'s width, in pixels or as a percentage of its category, e.g. "60%".',
  },
  INNER_RADIUS: {
    field: "innerRadius",
    expects: "size",
    description: 'Makes a PIE a donut with a hole this size, e.g. inner-radius "50%".',
  },
  RADIUS: {
    field: "radius",
    expects: "size",
    description: 'A PIE\'s outer radius. Defaults to "70%".',
  },
  ROSE: {
    field: "rose",
    expects: "tag",
    oneOf: ROSES,
    description: "Makes a PIE a rose (nightingale) chart: RADIUS or AREA shows the value.",
  },
  START_ANGLE: {
    field: "startAngle",
    expects: "number",
    description: "Where a PIE's first slice starts, in degrees. Defaults to 90 (twelve o'clock).",
  },
  LABEL: {
    field: "label",
    expects: "record",
    description:
      'Labels on a plot\'s bars, points or slices, e.g. label show true position TOP formatter "{c}%" {}.',
  },

  // label, legend, tooltip
  SHOW: {
    field: "show",
    expects: "boolean",
    description: "Whether a label, legend or tooltip shows.",
  },
  FORMATTER: {
    field: "formatter",
    expects: "text",
    description:
      'A label\'s template: {a} is the plot name, {b} the category or slice name, {c} the value, {d} a PIE slice\'s percent, e.g. "{b}: {d}%".',
  },
  TRIGGER: {
    field: "trigger",
    expects: "tag",
    oneOf: TRIGGERS,
    description:
      "What a tooltip reports: AXIS (everything at a category) or ITEM (one bar, point or slice).",
  },
};

/** Arity 1: the typed members. Each takes a description and returns `{[word]: record}`. */
export const memberFields: Record<string, AttributeMeta> = {
  DATASET: {
    field: "dataset",
    expects: "record",
    description: 'A table of data, e.g. dataset id "sales" columns ["month" "revenue"] rows [["Jan" 120]] {}.',
  },
  AXIS: {
    field: "axis",
    expects: "record",
    description: 'One axis, e.g. axis id "month" direction X scale CATEGORY categories "month" {}.',
  },
  PLOT: {
    field: "plot",
    expects: "record",
    description: 'One plot, e.g. plot kind BAR values "revenue" {}.',
  },
  LEGEND: {
    field: "legend",
    expects: "record",
    description: "A chart's legend, e.g. legend show true position TOP {}.",
  },
  TOOLTIP: {
    field: "tooltip",
    expects: "record",
    description: "A chart's tooltip, e.g. tooltip trigger ITEM {}.",
  },
};

/** Arity 2: the containers. A member list, then a settings chain. */
export const containerFields: Record<string, { word: string; description: string }> = {
  CHARTS: {
    word: "charts",
    description:
      "The program: its datasets and charts, then the collection's settings (title, instructions, theme, palette, …).",
  },
  CHART: {
    word: "chart",
    description:
      "One chart: its parts (datasets, axes, plots, legend, tooltip), then its settings (id, name, title, …).",
  },
  DATASETS: { word: "datasets", description: "A list of datasets, then `{}`." },
  AXES: { word: "axes", description: "A chart's axes, then `{}`." },
  PLOTS: { word: "plots", description: "A chart's plots, then `{}`." },
};

/* ------------------------------------------------------------------ legality */

/**
 * Which words each description accepts, in source spelling.
 *
 * Maintained by hand, because a chain builds whatever record it is handed: a word written in the
 * wrong description lands in a record nothing reads, compiles clean, and silently does nothing.
 */
export const validAttributes: Record<string, string[]> = {
  dataset: ["id", "columns", "rows"],
  axis: [
    "id",
    "direction",
    "scale",
    "categories",
    "name",
    "position",
    "min-value",
    "max-value",
    "inverse",
    "rotate",
  ],
  plot: [
    "id",
    "kind",
    "name",
    "x-axis",
    "y-axis",
    "values",
    "names",
    "x",
    "y",
    "color",
    "colors",
    "stack",
    "smooth",
    "area",
    "step",
    "symbol",
    "symbol-size",
    "bar-width",
    "inner-radius",
    "radius",
    "rose",
    "start-angle",
    "label",
    "value",
    "min-value",
    "max-value",
    "bin-count",
    "group",
    "open",
    "close",
    "low",
    "high",
  ],
  label: ["show", "position", "formatter"],
  legend: ["show", "position"],
  tooltip: ["show", "trigger"],
};

/** Which words a plot of each kind accepts. A subset of `validAttributes.plot`. */
export const plotKindAttributes: Record<string, string[]> = {
  BAR: ["id", "kind", "name", "x-axis", "y-axis", "values", "color", "colors", "stack", "bar-width", "label"],
  LINE: [
    "id",
    "kind",
    "name",
    "x-axis",
    "y-axis",
    "values",
    "x",
    "y",
    "color",
    "stack",
    "smooth",
    "area",
    "step",
    "symbol",
    "symbol-size",
    "label",
  ],
  PIE: ["id", "kind", "name", "names", "values", "colors", "inner-radius", "radius", "rose", "start-angle", "label"],
  SCATTER: ["id", "kind", "name", "x-axis", "y-axis", "x", "y", "names", "color", "symbol", "symbol-size", "label"],
  HISTOGRAM: ["id", "kind", "name", "x-axis", "y-axis", "values", "bin-count", "color", "label"],
  BOXPLOT: ["id", "kind", "name", "x-axis", "y-axis", "values", "group", "color"],
  CANDLESTICK: ["id", "kind", "name", "x-axis", "y-axis", "open", "close", "low", "high"],
  HEATMAP: ["id", "kind", "name", "x-axis", "y-axis", "values", "x", "y", "label"],
  FUNNEL: ["id", "kind", "name", "names", "values", "colors", "label"],
  GAUGE: ["id", "kind", "name", "value", "min-value", "max-value", "color"],
  RADAR: ["id", "kind", "name", "values", "color", "area"],
};

/** Where a label may sit, per plot kind. */
export const labelPositions: Record<string, string[]> = {
  BAR: ["TOP", "BOTTOM", "LEFT", "RIGHT", "INSIDE"],
  LINE: ["TOP", "BOTTOM", "LEFT", "RIGHT"],
  SCATTER: ["TOP", "BOTTOM", "LEFT", "RIGHT", "INSIDE"],
  PIE: ["INSIDE", "OUTSIDE", "CENTER"],
  HISTOGRAM: ["TOP", "BOTTOM", "LEFT", "RIGHT", "INSIDE"],
  HEATMAP: ["INSIDE"],
  FUNNEL: ["INSIDE", "OUTSIDE", "LEFT", "RIGHT"],
};

/** Which settings each container's settings chain accepts. */
export const validSettings: Record<string, string[]> = {
  charts: ["title", "instructions", "theme", "palette", "background", "show-chart-tabs", "show-chart-menu"],
  chart: ["id", "name", "title", "subtitle", "description", "dataset-id", "width", "height", "animation"],
  datasets: [],
  axes: [],
  plots: [],
};

/** Which parts each container's list holds, and how many of each. `min`/`max` per part. */
export const containerParts: Record<string, Record<string, { min: number; max: number }>> = {
  charts: { datasets: { min: 0, max: 1 }, chart: { min: 1, max: Infinity } },
  chart: {
    datasets: { min: 0, max: 1 },
    axes: { min: 0, max: 1 },
    plots: { min: 1, max: 1 },
    legend: { min: 0, max: 1 },
    tooltip: { min: 0, max: 1 },
  },
};

/** The member each typed list holds. */
export const listMember: Record<string, string> = { datasets: "dataset", axes: "axis", plots: "plot" };

/* ------------------------------------------------------------------ spelling */

export const wordOf = (name: string): string => name.toLowerCase().replace(/_/g, "-");

const wordByField: Record<string, string> = Object.fromEntries(
  Object.entries({ ...chainFields, ...memberFields }).map(([name, meta]) => [meta.field, wordOf(name)]),
);
/** The source word that emits `field`, for error messages (`datasetId` is `dataset-id`). */
export const sourceWord = (field: string): string => wordByField[field] ?? field;

/** The signature string the generated spec renders, derived so it cannot drift from the row. */
export const typeOf = (meta: AttributeMeta, arity: 1 | 2): string => {
  const arg =
    meta.expects === "record"
      ? "record"
      : meta.expects === "number"
        ? "number"
        : meta.expects === "boolean"
          ? "boolean"
          : meta.expects === "tag"
            ? "tag"
            : meta.expects === "list" || meta.expects === "colors"
              ? "list"
              : meta.expects === "data"
                ? "list|string"
                : meta.expects === "size" || meta.expects === "bound"
                  ? "number|string"
                  : "string";
  return arity === 1 ? `<${arg}: record>` : `<${arg} record: record>`;
};

/* ------------------------------------------------------------------ values */

/**
 * Unwrap L0000's internal Record representation to plain JS.
 *
 * A `{...}` literal reaching a Transformer is `{_type: "record", _entries: Map}` with keys encoded
 * `tag:`/`str:`/`num:`. L0000 does not export a reader for it. Dot-access without this silently
 * misses.
 */
export function toPlainObject(val: any): any {
  if (val !== null && typeof val === "object" && val._type === "record" && val._entries instanceof Map) {
    const obj: any = {};
    for (const [k, v] of val._entries) obj[(k as string).replace(/^(tag|str|num):/, "")] = toPlainObject(v);
    return obj;
  }
  if (Array.isArray(val)) return val.map(toPlainObject);
  return val;
}

/** A bare tag (`DARK`) reaches the Transformer as `{tag: "DARK"}`. */
export const isTag = (v: any): boolean =>
  v !== null && typeof v === "object" && !Array.isArray(v) && typeof v.tag === "string";

export const isRecord = (v: any): boolean =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !isTag(v);

/** A value as it was written, for an error message. */
export function showValue(v: any): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (isTag(v)) return `the tag ${v.tag}`;
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "a record";
  return String(v);
}

const PERCENT = /^\d+(\.\d+)?%$/;

/**
 * Check and normalize a value. Returns `{value}` or `{error}`.
 *
 * This runs in the TRANSFORMER, not the Checker: `Checker.LIST` visits only `elts[0]`, so a rule
 * written as a Checker method would fire on the first element of a list and nowhere else.
 * Colours are resolved by the caller (`colors.ts`), which needs the resolved value.
 */
export function checkValue(name: string, meta: AttributeMeta, raw: any): { value?: any; error?: string } {
  const word = wordOf(name);
  switch (meta.expects) {
    case "text":
    case "color": {
      if (typeof raw === "number" && Number.isFinite(raw)) raw = String(raw);
      if (typeof raw !== "string") return { error: `${word}: expected a string in "quotes", got ${showValue(raw)}.` };
      if (!raw.trim() && name !== "FORMATTER") return { error: `${word}: must not be empty.` };
      return { value: raw };
    }
    case "number":
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { error: `${word}: expected a number, got ${showValue(raw)}.` };
      }
      return { value: raw };
    case "bound":
      if ((typeof raw === "number" && Number.isFinite(raw)) || (typeof raw === "string" && raw.trim())) {
        return { value: raw };
      }
      return { error: `${word}: expected a number (or a date string on a TIME axis), got ${showValue(raw)}.` };
    case "size":
      if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return { value: raw };
      if (typeof raw === "string" && PERCENT.test(raw.trim())) return { value: raw.trim() };
      return { error: `${word}: expected pixels (a number) or a percentage like "50%", got ${showValue(raw)}.` };
    case "boolean":
      if (typeof raw === "boolean") return { value: raw };
      return {
        error: `${word}: expected true or false, written bare, got ${showValue(raw)}.${
          raw === "true" || raw === "false" ? ` Write it without quotes: ${word} ${raw}.` : ""
        }`,
      };
    case "tag": {
      if (isTag(raw) && (!meta.oneOf || meta.oneOf.includes(raw.tag))) return { value: raw.tag };
      const legal = (meta.oneOf || []).join(", ");
      const bare =
        typeof raw === "string" ? meta.oneOf?.find((v) => v.toLowerCase() === raw.toLowerCase()) : undefined;
      const quoted = bare ? ` Write it bare and uppercase, without quotes: ${word} ${bare}.` : "";
      return { error: `${word}: expected one of ${legal}, got ${showValue(raw)}.${quoted}` };
    }
    case "data":
      if (Array.isArray(raw)) return { value: raw };
      if (typeof raw === "string" && raw.trim()) return { value: raw };
      return {
        error: `${word}: expected a list in [brackets] or the name of a dataset column in "quotes", got ${showValue(raw)}.`,
      };
    case "list":
    case "colors":
      if (!Array.isArray(raw)) return { error: `${word}: expected a list in [brackets], got ${showValue(raw)}.` };
      return { value: raw };
    case "record":
      if (!isRecord(raw)) {
        return { error: `${word}: expected a description ending in \`{}\`, e.g. ${exampleOf(word)}, got ${showValue(raw)}.` };
      }
      return { value: raw };
  }
}

/* ------------------------------------------------------------------ messages */

/** A description written the way it should be, for error messages. */
export const exampleOf = (word: string): string =>
  ({
    dataset: 'dataset id "sales" columns ["month" "revenue"] rows [["Jan" 120]] {}',
    axis: 'axis id "month" direction X scale CATEGORY categories "month" {}',
    plot: 'plot kind BAR values "revenue" {}',
    legend: "legend show true position TOP {}",
    tooltip: "tooltip trigger ITEM {}",
    label: 'label show true position TOP formatter "{c}" {}',
    datasets: 'datasets [ dataset id "sales" … {} ] {}',
    axes: "axes [ axis direction X … {} axis direction Y … {} ] {}",
    plots: "plots [ plot kind BAR … {} ] {}",
    chart: 'chart [ plots [ plot kind BAR values [1 2 3] {} ] {} ] title "…" {}',
    charts: "charts [ chart [ … ] {} ] {}",
  })[word] ?? `${word} … {}`;

const owners = (table: Record<string, string[]>): Record<string, string[]> =>
  Object.entries(table).reduce((acc: Record<string, string[]>, [container, words]) => {
    for (const w of words) (acc[w] = acc[w] || []).push(container);
    return acc;
  }, {});
const attributeOwners = owners(validAttributes);
const settingOwners = owners(validSettings);
const partOwners = owners(Object.fromEntries(Object.entries(containerParts).map(([c, p]) => [c, Object.keys(p)])));
const memberOwner: Record<string, string> = Object.fromEntries(Object.entries(listMember).map(([l, m]) => [m, l]));

/** Where a misplaced word belongs, as a sentence to append to the error. */
export function hintFor(w: string, here: string): string {
  if (memberOwner[w]) {
    return ` \`${w}\` is a member of \`${memberOwner[w]}\`, e.g. ${memberOwner[w]} [ ${exampleOf(w)} ] {}.`;
  }
  const parts = (partOwners[w] || []).filter((o) => o !== here);
  if (parts.length) return ` \`${w}\` is a part of ${parts.map((p) => `\`${p}\``).join(" or ")}: write it inside its \`[ … ]\`.`;
  const settings = (settingOwners[w] || []).filter((o) => o !== here);
  if (settings.length) {
    const s = settings[0];
    return s === "charts"
      ? ` \`${w}\` is a setting of the whole collection: write it after the outer \`]\`, e.g. charts [ … ] ${w} … {}.`
      : ` \`${w}\` is a setting of \`${s}\`: write it after the chart's \`]\`, e.g. chart [ … ] ${w} … {}.`;
  }
  const attrs = (attributeOwners[w] || []).filter((o) => o !== here);
  if (!attrs.length) return "";
  if (attrs.includes("label")) return ` \`${w}\` belongs inside \`label … {}\`, e.g. ${exampleOf("label")}.`;
  return ` \`${w}\` belongs in ${attrs.map((o) => `\`${o}\``).join(" or ")}.`;
}

/**
 * Reject a word a description does not accept, naming the legal set and where the misplaced word
 * belongs. The generator is an LLM that reads this and tries again, so the wording is a product
 * surface, not a diagnostic.
 */
export function assertKnownAttributes(kind: string, attrs: Record<string, any>, where = kind, allowed = validAttributes[kind]): void {
  const unknown = Object.keys(attrs).map(sourceWord).filter((w) => !allowed.includes(w));
  if (!unknown.length) return;
  const w = unknown[0];
  throw new Error(`${where}: \`${w}\` is not part of ${kind}. It takes: ${allowed.join(", ")}.${hintFor(w, kind)}`);
}

/** The same check for a settings chain. */
export function assertKnownSettings(container: string, settings: Record<string, any>, where = container): void {
  const allowed = validSettings[container];
  const unknown = Object.keys(settings).map(sourceWord).filter((w) => !allowed.includes(w));
  if (!unknown.length) return;
  const w = unknown[0];
  const takes = allowed.length ? `Its settings are: ${allowed.join(", ")}.` : "It takes no settings: write `{}`.";
  throw new Error(`${where}: \`${w}\` is not a setting of ${container}. ${takes}${hintFor(w, container)}`);
}
