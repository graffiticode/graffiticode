# L0184 — charts

L0184 draws **charts** with Apache ECharts: bar, line, pie (donut, rose), scatter, histogram,
box plot, candlestick, heatmap, funnel, gauge and radar plots, over data written inline or in
datasets, one chart or a collection of charts shown as tabs.

OUT_OF_SCOPE: spreadsheets and editable tables are L0179; concept maps and other diagrams are
L0183; Venn diagrams are L0171; quizzes and assessment items are L0180. Fetching or transforming
data from a URL or a file is not built yet: L0184 plots only the data given in the request.
Reference and trend lines, annotations, colour scales the author configures, network charts
(graph, sankey, tree, treemap, sunburst) and maps are not built yet.

**Every description ends in exactly one `{}`, after its last word — every `plot`, `axis`,
`dataset`, `legend`, `tooltip` and `label`, and every list's settings after its `]`.** Leaving a
`{}` off (`plot kind BAR values [1 2] ]`) fails in the PARSER, before any compiler message can
say what went wrong. Writing one too early (`plot kind BAR {} values [1 2] {}`) ends the plot
there and leaves `values …` stranded.

## The shape of a program

Every program is ONE `charts` collection, even when it holds a single chart:

```
charts [
  chart [
    plots [
      plot kind BAR name "Visitors" values [120 132 101 134] {}
    ] {}
  ] title "Weekly visitors" {}
] {}..
```

- `charts [ … ] settings {}` is the program. Its list holds `chart`s, and optionally one
  `datasets` shared by every chart. Its settings, after the outer `]`, apply to the whole
  collection: `title`, `instructions`, `theme`, `palette`, `background`, `show-chart-tabs`,
  `show-chart-menu`.
- `chart [ … ] settings {}` is one chart. Its list holds its parts — `plots` (required), and
  optionally `axes`, `datasets`, `legend`, `tooltip`, each at most once. Its settings come after
  its `]`: `id`, `name`, `title`, `subtitle`, `description`, `dataset-id`, `width`, `height`,
  `animation`.
- `plots`, `axes` and `datasets` are lists of ONE kind of thing — `plot`, `axis`, `dataset` —
  each written with its word and ending in `{}`. Each list is followed by `{}`.
- `legend`, `tooltip` and `label` each take one description: `legend position TOP {}`,
  `label show true formatter "{c}%" {}`.
- Closed sets are UPPERCASE tags, written bare: `kind BAR`, `theme DARK`, `direction X`,
  `scale LOG`, `position TOP`. Never quote them and never lowercase them.
- Each word appears once in a description, and order within a description does not matter.

A chart title goes in the CHART's settings (`chart [ … ] title "…" {}`); a title for the whole
collection goes after the OUTER `]`. A `title` written inside a chart's `[ … ]` is an error.

## Data: a list, or a column name

Every data word — `values`, `names`, `categories`, `x`, `y`, `group`, `open`, `close`, `low`,
`high` — takes **either an inline list or
a string naming a column** of the chart's dataset:

```
charts [
  datasets [
    dataset id "sales" columns ["month" "revenue" "cost"]
      rows [["Jan" 120 80] ["Feb" 132 90] ["Mar" 101 70]] {}
  ] {}
  chart [
    axes [
      axis direction X categories "month" {}
      axis direction Y name "USD" {}
    ] {}
    plots [
      plot kind BAR values "revenue" {}
      plot kind LINE values "cost" {}
    ] {}
  ] title "Revenue and cost" {}
] {}..
```

- A dataset has an `id`, `columns` (unique names) and `rows`: lists in column order, or records
  like `{month: "Jan" revenue: 120}`. Every row has every column; write `null` for a missing value.
- Datasets in the outer `charts` list are shared by every chart. A dataset in a chart's own
  `datasets` is local to that chart, and hides a shared one with the same id.
- A chart's column names refer to its selected dataset: the one named by `dataset-id` in its
  settings, or the only dataset it can see. With two or more visible, write `dataset-id "…"`.
- A plot's `name` defaults to the column its values come from.
- A column is always one flat list. The two forms that nest lists — a BOXPLOT's `values` as one
  list per category, a HEATMAP's matrix — are written inline; from a dataset, use the flat forms
  (`values` with `group`, and `x`, `y` and `values`).

## Plot kinds and their data

| Kind | Data | Notes |
| --- | --- | --- |
| `BAR` | `values`, one per category | Drawn against a CATEGORY axis. `null` leaves a gap. |
| `LINE` | `values`, one per category — OR — `x` and `y` pairs | Never both. Use `x`/`y` for numbers or dates across. `null` in `values`/`y` leaves a gap. |
| `PIE` | `names` and `values`, one per slice | Values 0 or above, no `null`. One PIE per chart; no axes. |
| `SCATTER` | `x` and `y`, one per point; optional `names` | Always `x` and `y` — never `values`. Named points are labelled. |
| `FUNNEL` | `names` and `values`, one per stage | As PIE. Drawn largest first. One FUNNEL per chart; no axes. |
| `HISTOGRAM` | `values`: raw observations, one flat list | Counted into `bin-count` equal-width bins (default: Sturges' rule), each from its lower edge up to its upper; the last includes the maximum. Never counts you already have — for those, use BAR. No `null`. One per chart. |
| `BOXPLOT` | `values` with `group` (the category of each value) — OR — `values` as one list per category | Never `group` with nested `values`. Quartiles, whiskers at 1.5 × IQR, outliers as points. No `null`. At most one BOXPLOT per category axis. |
| `CANDLESTICK` | `open`, `close`, `low` and `high`, one each per category | `low` at most `open` and `close`; `high` at least both. |
| `HEATMAP` | `values` as a matrix, one row per Y category, one cell per X category — OR — `x`, `y` and `values`, one each per cell | A matrix needs `categories` on both axes; its first row is the top row. Cells name each (x, y) once; `null` or a missing cell is empty. One per chart. |
| `GAUGE` | `value`: one number | Within `min-value` and `max-value` (default 0 to 100). One to four GAUGEs per chart; no axes. |
| `RADAR` | `values`, one per spoke | Drawn on the chart's RADIAL axis. `area true` fills it. |

Lengths that pair up must match: `values` and the axis's `categories`, `x` and `y`, `names` and
`values`.

## Axes

Without `axes`, a chart gets a CATEGORY X axis (steps 1, 2, 3 … unless given `categories`) and a
LINEAR Y axis — or, for x/y plots, LINEAR on both. Write `axes` to name categories, add a second
axis, set bounds, or change scales:

```
charts [
  chart [
    axes [
      axis direction X categories ["Q1" "Q2" "Q3" "Q4"] {}
      axis id "usd" direction Y name "Revenue" {}
      axis id "pct" direction Y name "Margin %" min-value 0 max-value 100 {}
    ] {}
    plots [
      plot kind BAR name "Revenue" y-axis "usd" values [120 132 101 134] {}
      plot kind LINE name "Margin" y-axis "pct" values [32 35 28 40] smooth true {}
    ] {}
  ] title "Revenue and margin" {}
] {}..
```

- `direction` (X or Y) is required. `scale` is CATEGORY, LINEAR, LOG or TIME, and defaults to
  CATEGORY when the axis has `categories`, LINEAR otherwise.
- A plot names its axes by id with `x-axis "…"` and `y-axis "…"`. It may leave one out only
  when the chart has exactly one axis in that direction. The second axis in a direction sits on
  the other side (TOP, RIGHT) unless `position` says otherwise.
- Bounds are `min-value` and `max-value`. A LOG axis shows only values above 0.
- Put `categories` on the Y axis for a horizontal bar chart.
- A BAR, a LINE of `values`, a BOXPLOT or a CANDLESTICK needs one CATEGORY axis and one LINEAR
  or LOG axis. An x/y LINE or a SCATTER needs LINEAR, LOG or TIME axes. A HEATMAP needs two
  CATEGORY axes (its axes default to CATEGORY).
- A HISTOGRAM's axes are generated — its bins across a CATEGORY X axis, their counts up a LINEAR
  Y axis. `axes` may only name them (`axis direction X name "Score" {}`).

## Radar charts: the RADIAL axis

A RADAR chart has exactly one axis, `direction RADIAL`, and no X or Y axis. Its `categories` are
the spokes — at least 3, all different — and every RADAR plot gives one value per spoke:

```
charts [
  chart [
    axes [ axis direction RADIAL categories ["Speed" "Power" "Range" "Cost" "Comfort"] {} ] {}
    plots [
      plot kind RADAR name "Model A" values [8 6 7 4 9] area true {}
      plot kind RADAR name "Model B" values [5 9 6 7 6] {}
    ] {}
  ] title "Two models compared" {}
] {}..
```

- Every spoke shares one scale. `min-value` defaults to 0; `max-value` defaults to a round
  number (1, 2 or 5 × a power of ten) above the largest value. Values below 0 need `min-value`.
- A RADIAL axis takes `categories`, `name`, `min-value` and `max-value` — never `position` or
  `rotate` — and its scale is always CATEGORY.

## What may share a chart

- BAR, LINE, SCATTER, BOXPLOT and CANDLESTICK share X and Y axes and may be combined.
- A HISTOGRAM, HEATMAP, FUNNEL or PIE takes a chart of its own, alone.
- GAUGEs share a chart only with other GAUGEs: one to four, side by side.
- RADAR plots share a chart only with other RADAR plots.

To show kinds that cannot share, put each in its own chart of the collection.

## Several charts

A collection shows one chart at a time. With two or more charts, a tab for each appears under the
chart; `show-chart-menu true` adds a menu that lists them all. A single chart shows neither:

```
charts [
  chart [ plots [ plot kind BAR values [3 5 2] {} ] {} ] id "sales" name "Sales" {}
  chart [ plots [ plot kind PIE names ["North" "South"] values [60 40] {} ] {} ] id "regions" name "Regions" {}
] title "Q1 report" {}..
```

Charts keep the order written. `id`s default to c1, c2, …, must differ, and `name` (the tab label)
defaults to the id. `show-chart-tabs false` hides the tabs; with two or more charts it then needs
`show-chart-menu true`, or no chart but the first can be reached. Plots that cannot share a chart (see above) go in separate charts of
the collection.

## Legends, tooltips and labels

- A legend shows by default with two or more plots, or for a pie or funnel; never by default for
  gauges. `legend show false {}` hides
  it; `legend position TOP {}` moves it (TOP, BOTTOM, LEFT, RIGHT; default BOTTOM).
- While a legend shows, the names in it must differ: two plots, or two pie slices or funnel
  stages, with one name are an error, because the legend turns entries on and off by name. A
  BOXPLOT's outliers share its entry.
- A tooltip shows by default: AXIS (everything at a category) for charts of BAR, LINE of values,
  BOXPLOT or CANDLESTICK, ITEM (one point, cell or slice) otherwise. `tooltip trigger ITEM {}` or `tooltip show false {}` change it.
- `label` puts text on bars, points or slices: `label show true position TOP formatter "{c}" {}`.
  In `formatter`, {a} is the plot name, {b} the category or slice name, {c} the value, {d} a
  pie slice's percent. Positions: BAR and SCATTER TOP, BOTTOM, LEFT, RIGHT, INSIDE; LINE TOP,
  BOTTOM, LEFT, RIGHT; PIE INSIDE, OUTSIDE, CENTER; HISTOGRAM as BAR; HEATMAP INSIDE; FUNNEL
  INSIDE, OUTSIDE, LEFT, RIGHT.

## Colours

Colours are Tailwind tokens (`"blue-500"`, shades 50–950) or hex codes (`"#3b82f6"`). `color`
colours a plot; `colors` gives one per bar, slice or funnel stage; a HEATMAP's colour scale is
generated from its values; `palette` in the collection's settings
is the order plots take colours in; `background` sets what is behind every chart.
`theme DARK` switches every chart to the dark theme.

## Functions

| Word | Signature | Meaning |
| --- | --- | --- |
| `id` | `<string record: record>` | A name other parts refer to. Charts default to c1, c2, …; datasets to d1, d2, …; axes to x1, y1, …; plots to p1, p2, …. |
| `name` | `<string record: record>` | A label people see: a chart's tab name, an axis title, or a plot's legend entry. A plot's name defaults to the column its values come from. |
| `title` | `<string record: record>` | A heading: above a chart, or, after the outer `]`, above the whole collection. |
| `subtitle` | `<string record: record>` | A second line under a chart's title. |
| `description` | `<string record: record>` | What the chart shows, for screen readers. Defaults to a summary generated from its plots. |
| `instructions` | `<string record: record>` | Guidance shown under the collection's title. |
| `theme` | `<tag record: record>` | The colour scheme for every chart, LIGHT or DARK. Defaults to LIGHT. |
| `palette` | `<list record: record>` | The colours plots take in order, e.g. palette ["blue-500" "amber-500" "#10b981"]. Tailwind tokens or hex codes. |
| `background` | `<string record: record>` | The background colour behind every chart. |
| `show-chart-tabs` | `<boolean record: record>` | Show a tab per chart. Defaults to true with two or more charts, false with one. |
| `show-chart-menu` | `<boolean record: record>` | Show the chart menu, which lists every chart. Defaults to false. |
| `dataset-id` | `<string record: record>` | Which dataset a chart's column names refer to. May be left out when exactly one dataset is visible. |
| `width` | `<number|string record: record>` | A chart's width, in pixels or as a percentage like "100%". Defaults to "100%". |
| `height` | `<number record: record>` | A chart's height in pixels. Defaults to 384. |
| `animation` | `<boolean record: record>` | Animate the chart as it draws. Defaults to true. |
| `columns` | `<list record: record>` | A dataset's column names, in order, e.g. columns ["month" "revenue"]. |
| `rows` | `<list record: record>` | A dataset's rows: lists in column order, e.g. rows [["Jan" 120] ["Feb" 132]], or records, e.g. rows [{month: "Jan" revenue: 120}]. |
| `direction` | `<tag record: record>` | Which way an axis runs: X (across), Y (up), or RADIAL (the spokes of a radar chart). Required. |
| `scale` | `<tag record: record>` | An axis's scale: CATEGORY, LINEAR, LOG or TIME. Defaults to CATEGORY when the axis has categories, LINEAR otherwise. |
| `categories` | `<list|string record: record>` | A CATEGORY axis's steps: a list, or the name of a dataset column, e.g. categories "month". |
| `min-value` | `<number|string record: record>` | Where a numeric, time or RADIAL axis starts, or the bottom of a GAUGE's dial (default 0). Defaults to fitting the data on an axis, 0 on a RADIAL axis. |
| `max-value` | `<number|string record: record>` | Where a numeric, time or RADIAL axis ends, or the top of a GAUGE's dial (default 100). On a RADIAL axis it defaults to a round number above the largest value. |
| `position` | `<tag record: record>` | Where something sits. An X axis: BOTTOM or TOP. A Y axis: LEFT or RIGHT. A legend: TOP, BOTTOM, LEFT or RIGHT. A label: see its plot kind. |
| `inverse` | `<boolean record: record>` | Run an axis the other way. Defaults to false. |
| `rotate` | `<number record: record>` | Rotate an axis's labels by this many degrees, from -90 to 90. |
| `kind` | `<tag record: record>` | What a plot draws: BAR, LINE, PIE, SCATTER, HISTOGRAM, BOXPLOT, CANDLESTICK, HEATMAP, FUNNEL, GAUGE or RADAR. Required. |
| `x-axis` | `<string record: record>` | The id of the X axis a plot is drawn against. May be left out when the chart has one X axis. |
| `y-axis` | `<string record: record>` | The id of the Y axis a plot is drawn against. May be left out when the chart has one Y axis. |
| `values` | `<list|string record: record>` | A plot's values: a list, or the name of a dataset column. One per category for BAR and LINE, one per spoke for RADAR, one per slice for PIE and FUNNEL, raw observations for HISTOGRAM and BOXPLOT, and rows of cells (or one per x/y pair) for HEATMAP. |
| `names` | `<list|string record: record>` | A PIE's or FUNNEL's slice names, or a SCATTER's point names: a list, or a column name. |
| `x` | `<list|string record: record>` | The x of each point, for SCATTER and x/y LINE, or each cell's X category for a HEATMAP written as x/y/values: a list, or a column name. |
| `y` | `<list|string record: record>` | The y of each point, for SCATTER and x/y LINE, or each cell's Y category for a HEATMAP written as x/y/values: a list, or a column name. |
| `value` | `<number record: record>` | A GAUGE's reading: one number within its min-value and max-value (0 to 100 by default). |
| `bin-count` | `<number record: record>` | How many equal-width bins a HISTOGRAM uses: a whole number above 0. Defaults to Sturges' rule. |
| `group` | `<list|string record: record>` | Which category each BOXPLOT value belongs to, one per value: a list, or a column name, e.g. group "class". |
| `open` | `<list|string record: record>` | A CANDLESTICK's opening values, one per category: a list, or a column name. |
| `close` | `<list|string record: record>` | A CANDLESTICK's closing values, one per category: a list, or a column name. |
| `low` | `<list|string record: record>` | A CANDLESTICK's lowest values, one per category: a list, or a column name. |
| `high` | `<list|string record: record>` | A CANDLESTICK's highest values, one per category: a list, or a column name. |
| `color` | `<string record: record>` | A plot's colour: a Tailwind token like "blue-500", or a hex code. |
| `colors` | `<list record: record>` | One colour per bar (BAR) or per slice (PIE), in order. |
| `stack` | `<string record: record>` | Stack BAR or LINE plots that share this group name, e.g. stack "total". Category values only. |
| `smooth` | `<boolean record: record>` | Draw a LINE as a smooth curve. |
| `area` | `<boolean record: record>` | Fill the area under a LINE, or inside a RADAR plot. |
| `step` | `<tag record: record>` | Draw a LINE as steps: START, MIDDLE or END. Not with smooth. |
| `symbol` | `<tag record: record>` | The marker on a LINE or SCATTER: CIRCLE, RECT, TRIANGLE, DIAMOND, PIN, ARROW, NONE. |
| `symbol-size` | `<number record: record>` | The marker's size in pixels. |
| `bar-width` | `<number|string record: record>` | A BAR's width, in pixels or as a percentage of its category, e.g. "60%". |
| `inner-radius` | `<number|string record: record>` | Makes a PIE a donut with a hole this size, e.g. inner-radius "50%". |
| `radius` | `<number|string record: record>` | A PIE's outer radius. Defaults to "70%". |
| `rose` | `<tag record: record>` | Makes a PIE a rose (nightingale) chart: RADIUS or AREA shows the value. |
| `start-angle` | `<number record: record>` | Where a PIE's first slice starts, in degrees. Defaults to 90 (twelve o'clock). |
| `label` | `<record record: record>` | Labels on a plot's bars, points or slices, e.g. label show true position TOP formatter "{c}%" {}. |
| `show` | `<boolean record: record>` | Whether a label, legend or tooltip shows. |
| `formatter` | `<string record: record>` | A label's template: {a} is the plot name, {b} the category or slice name, {c} the value, {d} a PIE slice's percent, e.g. "{b}: {d}%". |
| `trigger` | `<tag record: record>` | What a tooltip reports: AXIS (everything at a category) or ITEM (one bar, point or slice). |
| `dataset` | `<record: record>` | A table of data, e.g. dataset id "sales" columns ["month" "revenue"] rows [["Jan" 120]] {}. |
| `axis` | `<record: record>` | One axis, e.g. axis id "month" direction X scale CATEGORY categories "month" {}. |
| `plot` | `<record: record>` | One plot, e.g. plot kind BAR values "revenue" {}. |
| `legend` | `<record: record>` | A chart's legend, e.g. legend show true position TOP {}. |
| `tooltip` | `<record: record>` | A chart's tooltip, e.g. tooltip trigger ITEM {}. |
| `charts` | `<list record: record>` | The program: its datasets and charts, then the collection's settings (title, instructions, theme, palette, …). |
| `chart` | `<list record: record>` | One chart: its parts (datasets, axes, plots, legend, tooltip), then its settings (id, name, title, …). |
| `datasets` | `<list record: record>` | A list of datasets, then `{}`. |
| `axes` | `<list record: record>` | A chart's axes, then `{}`. |
| `plots` | `<list record: record>` | A chart's plots, then `{}`. |

## Which parts each container holds

| Container | Parts |
| --- | --- |
| `charts` | datasets, chart |
| `chart` | datasets, axes, plots, legend, tooltip |

## Which words each description takes

| Description | Words |
| --- | --- |
| `dataset` | id, columns, rows |
| `axis` | id, direction, scale, categories, name, position, min-value, max-value, inverse, rotate |
| `plot` | id, kind, name, x-axis, y-axis, values, names, x, y, color, colors, stack, smooth, area, step, symbol, symbol-size, bar-width, inner-radius, radius, rose, start-angle, label, value, min-value, max-value, bin-count, group, open, close, low, high |
| `label` | show, position, formatter |
| `legend` | show, position |
| `tooltip` | show, trigger |

## Which words each plot kind takes

| Kind | Words |
| --- | --- |
| `BAR` | id, kind, name, x-axis, y-axis, values, color, colors, stack, bar-width, label |
| `LINE` | id, kind, name, x-axis, y-axis, values, x, y, color, stack, smooth, area, step, symbol, symbol-size, label |
| `PIE` | id, kind, name, names, values, colors, inner-radius, radius, rose, start-angle, label |
| `SCATTER` | id, kind, name, x-axis, y-axis, x, y, names, color, symbol, symbol-size, label |
| `HISTOGRAM` | id, kind, name, x-axis, y-axis, values, bin-count, color, label |
| `BOXPLOT` | id, kind, name, x-axis, y-axis, values, group, color |
| `CANDLESTICK` | id, kind, name, x-axis, y-axis, open, close, low, high |
| `HEATMAP` | id, kind, name, x-axis, y-axis, values, x, y, label |
| `FUNNEL` | id, kind, name, names, values, colors, label |
| `GAUGE` | id, kind, name, value, min-value, max-value, color |
| `RADAR` | id, kind, name, values, color, area |

## Which settings each container takes

| Container | Settings |
| --- | --- |
| `charts` | title, instructions, theme, palette, background, show-chart-tabs, show-chart-menu |
| `chart` | id, name, title, subtitle, description, dataset-id, width, height, animation |
| `datasets` | — |
| `axes` | — |
| `plots` | — |

## If you know L0173

L0184 replaces L0173 and does not accept its programs. The old spellings map like this:

| L0173 | L0184 |
| --- | --- |
| `chart … series [ bar … {} ] {}` | `charts [ chart [ plots [ plot kind BAR … {} ] {} ] {} ] {}` |
| `bar`, `line`, `pie`, `scatter` | `plot kind BAR`, `LINE`, `PIE`, `SCATTER` |
| `x-axis type category categories [ … ] {}` | `axis direction X categories [ … ] {}` inside `axes [ … ] {}` |
| `y-axis-right …` and `axis right` | a second `axis id "…" direction Y {}`, and `y-axis "…"` on the plot |
| `min`, `max`, `type log` | `min-value`, `max-value`, `scale LOG` |
| `label-show`, `label-position`, `label-formatter` | `label show … position … formatter … {}` |
| `area-style`, `outer-radius`, `rose-type` | `area`, `radius`, `rose` |
| `theme dark` | `theme DARK` after the outer `]` |

## Guidelines

- Plot only the numbers the request gives. Never invent data the request does not state.
- Prefer one dataset with named columns when several plots share the same rows.
- Name every plot a reader would need to tell apart — the names are the legend.
- Write `null` for a missing value; never write 0 for it.
- Use separate charts in one collection for different views of the same data (a trend and a
  breakdown), rather than one crowded chart.

## Example patterns

A donut with its percentages on the slices:

```
charts [
  chart [
    plots [
      plot kind PIE names ["Search" "Direct" "Email" "Social"] values [48 26 14 12]
        inner-radius "50%" label formatter "{b}: {d}%" {} {}
    ] {}
    legend position RIGHT {}
  ] title "Traffic sources" {}
] {}..
```

A scatter of named points on bounded axes:

```
charts [
  chart [
    axes [
      axis direction X name "Hours studied" {}
      axis direction Y name "Score" min-value 0 max-value 100 {}
    ] {}
    plots [
      plot kind SCATTER x [1 2 3 4 5] y [52 58 65 70 78] names ["Ana" "Ben" "Cy" "Di" "Ed"] {}
    ] {}
  ] title "Study time and score" {}
] {}..
```

A stacked, horizontal bar chart in the dark theme with a palette:

```
charts [
  chart [
    axes [
      axis direction X {}
      axis direction Y categories ["North" "South" "East"] {}
    ] {}
    plots [
      plot kind BAR name "2025" values [40 32 28] stack "total" {}
      plot kind BAR name "2026" values [44 30 35] stack "total" {}
    ] {}
  ] title "Units by region" {}
] theme DARK palette ["sky-400" "amber-400"] {}..
```

A line over dates, with a gap:

```
charts [
  chart [
    axes [
      axis direction X scale TIME {}
      axis direction Y name "°C" {}
    ] {}
    plots [
      plot kind LINE name "Temperature" x ["2026-03-01" "2026-03-02" "2026-03-03" "2026-03-04"]
        y [11.5 null 13.2 12.8] symbol CIRCLE {}
    ] {}
  ] title "Daily high" {}
] {}..
```

A histogram of raw scores, with named axes:

```
charts [
  chart [
    axes [ axis direction X name "Score" {} axis direction Y name "Students" {} ] {}
    plots [ plot kind HISTOGRAM name "Scores" values [52 61 64 68 70 71 73 75 78 81 84 90 93] bin-count 5 {} ] {}
  ] title "Test scores" {}
] {}..
```

Box plots from a dataset, one box per class:

```
charts [
  datasets [
    dataset columns ["class" "minutes"]
      rows [["A" 12] ["A" 15] ["A" 14] ["A" 30] ["B" 22] ["B" 25] ["B" 21] ["B" 24] ["B" 60]] {}
  ] {}
  chart [
    axes [ axis direction X categories ["A" "B"] {} axis direction Y name "Minutes" {} ] {}
    plots [ plot kind BOXPLOT values "minutes" group "class" {} ] {}
  ] title "Time on task by class" {}
] {}..
```

A candlestick of daily prices:

```
charts [
  chart [
    axes [ axis direction X categories ["Mon" "Tue" "Wed" "Thu"] {} axis direction Y name "USD" {} ] {}
    plots [
      plot kind CANDLESTICK name "ACME" open [20 24 23 27] close [24 23 27 26]
        low [19 22 22 25] high [25 25 28 28] {}
    ] {}
  ] title "ACME this week" {}
] {}..
```

A heatmap written as a matrix, one row per Y category:

```
charts [
  chart [
    axes [
      axis direction X categories ["Mon" "Tue" "Wed" "Thu" "Fri"] {}
      axis direction Y categories ["Morning" "Afternoon"] {}
    ] {}
    plots [ plot kind HEATMAP name "Visits" values [[5 8 6 9 4] [7 null 10 8 3]] label show true {} {} ] {}
  ] title "Visits by day and time" {}
] {}..
```

A funnel, and three gauges, as two charts of one collection:

```
charts [
  chart [
    plots [ plot kind FUNNEL names ["Visited" "Signed up" "Paid"] values [1000 240 60] {} ] {}
  ] id "funnel" name "Conversion" {}
  chart [
    plots [
      plot kind GAUGE name "CPU" value 64 {}
      plot kind GAUGE name "Memory" value 81 {}
      plot kind GAUGE name "Temp °C" value 58 min-value 20 max-value 90 {}
    ] {}
  ] id "health" name "Health" {}
] {}..
```
