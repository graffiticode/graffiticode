<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0184 Specification

L0184 is a Graffiticode dialect for charts, drawn with Apache ECharts. A program is one `charts`
collection of one or more `chart`s; each chart holds `plots` (BAR, LINE, PIE, SCATTER, HISTOGRAM, BOXPLOT, CANDLESTICK, HEATMAP,
FUNNEL, GAUGE, RADAR), and
optionally `axes`, `datasets`, a `legend` and a `tooltip`. Data is written inline or in datasets
and referred to by column name, and is resolved when the program compiles.

# Program

A program is one collection, ending in `..`:

```
charts [
  chart [
    plots [ plot kind LINE name "Visitors" values [120 132 101 134 90 230 210] {} ] {}
    axes [
      axis direction X categories ["Mon" "Tue" "Wed" "Thu" "Fri" "Sat" "Sun"] {}
      axis direction Y {}
    ] {}
  ] title "Visitors this week" {}
] {}..
```

Every description — a `plot`, `axis`, `dataset`, `legend`, `tooltip` or `label`, and each
list's settings after its `]` — ends in exactly one `{}` after its last word.

# Words

| Word | Signature | Meaning |
| --- | --- | --- |
| `id` | `<string record: record>` | A name other parts refer to. Charts default to c1, c2, …; datasets to d1, d2, …; axes to x1, y1, …; plots to p1, p2, …. |
| `name` | `<string record: record>` | A label people see: a chart's tab name, an axis title, or a plot's legend entry. A plot's name defaults to the column its values come from. |
| `title` | `<string record: record>` | A heading: above a chart, or, after the outer `]`, above the whole collection. |
| `subtitle` | `<string record: record>` | A second line under a chart's title. |
| `description` | `<string record: record>` | What the chart shows, for screen readers. Defaults to a summary generated from its plots. |
| `instructions` | `<string record: record>` | Guidance shown under the collection's title. |
| `theme` | `<tag record: record>` | The colour scheme for every chart, LIGHT or DARK. Defaults to LIGHT. |
| `palette` | `<list record: record>` | The colours plots take in order, e.g. `palette ["blue-500" "amber-500" "#10b981"]`. Tailwind tokens or hex codes. |
| `background` | `<string record: record>` | The background colour behind every chart. |
| `show-chart-tabs` | `<boolean record: record>` | Show a tab per chart. Defaults to true with two or more charts, false with one. |
| `hide-chart-menu` | `<boolean record: record>` | Hide the chart menu, which lists every chart. Defaults to false. |
| `dataset-id` | `<string record: record>` | Which dataset a chart's column names refer to. May be left out when exactly one dataset is visible. |
| `width` | `<number|string record: record>` | A chart's width, in pixels or as a percentage like "100%". Defaults to "100%". |
| `height` | `<number record: record>` | A chart's height in pixels. Defaults to 384. |
| `animation` | `<boolean record: record>` | Animate the chart as it draws. Defaults to true. |
| `columns` | `<list record: record>` | A dataset's column names, in order, e.g. `columns ["month" "revenue"]`. |
| `rows` | `<list record: record>` | A dataset's rows: lists in column order, e.g. `rows [["Jan" 120] ["Feb" 132]]`, or records, e.g. `rows [{month: "Jan" revenue: 120}]`. |
| `direction` | `<tag record: record>` | Which way an axis runs: X (across), Y (up), or RADIAL (the spokes of a radar chart). Required. |
| `scale` | `<tag record: record>` | An axis's scale: CATEGORY, LINEAR, LOG or TIME. Defaults to CATEGORY when the axis has categories, LINEAR otherwise. |
| `categories` | `<list|string record: record>` | A CATEGORY axis's steps: a list, or the name of a dataset column, e.g. `categories "month"`. |
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
| `group` | `<list|string record: record>` | Which category each BOXPLOT value belongs to, one per value: a list, or a column name, e.g. `group "class"`. |
| `open` | `<list|string record: record>` | A CANDLESTICK's opening values, one per category: a list, or a column name. |
| `close` | `<list|string record: record>` | A CANDLESTICK's closing values, one per category: a list, or a column name. |
| `low` | `<list|string record: record>` | A CANDLESTICK's lowest values, one per category: a list, or a column name. |
| `high` | `<list|string record: record>` | A CANDLESTICK's highest values, one per category: a list, or a column name. |
| `color` | `<string record: record>` | A plot's colour: a Tailwind token like "blue-500", or a hex code. |
| `colors` | `<list record: record>` | One colour per bar (BAR) or per slice (PIE), in order. |
| `stack` | `<string record: record>` | Stack BAR or LINE plots that share this group name, e.g. `stack "total"`. Category values only. |
| `smooth` | `<boolean record: record>` | Draw a LINE as a smooth curve. |
| `area` | `<boolean record: record>` | Fill the area under a LINE, or inside a RADAR plot. |
| `step` | `<tag record: record>` | Draw a LINE as steps: START, MIDDLE or END. Not with smooth. |
| `symbol` | `<tag record: record>` | The marker on a LINE or SCATTER: CIRCLE, RECT, TRIANGLE, DIAMOND, PIN, ARROW, NONE. |
| `symbol-size` | `<number record: record>` | The marker's size in pixels. |
| `bar-width` | `<number|string record: record>` | A BAR's width, in pixels or as a percentage of its category, e.g. `"60%"`. |
| `inner-radius` | `<number|string record: record>` | Makes a PIE a donut with a hole this size, e.g. `inner-radius "50%"`. |
| `radius` | `<number|string record: record>` | A PIE's outer radius. Defaults to "70%". |
| `rose` | `<tag record: record>` | Makes a PIE a rose (nightingale) chart: RADIUS or AREA shows the value. |
| `start-angle` | `<number record: record>` | Where a PIE's first slice starts, in degrees. Defaults to 90 (twelve o'clock). |
| `label` | `<record record: record>` | Labels on a plot's bars, points or slices, e.g. `label show true position TOP formatter "{c}%" {}`. |
| `show` | `<boolean record: record>` | Whether a label, legend or tooltip shows. |
| `formatter` | `<string record: record>` | A label's template: {a} is the plot name, {b} the category or slice name, {c} the value, {d} a PIE slice's percent, e.g. `"{b}: {d}%"`. |
| `trigger` | `<tag record: record>` | What a tooltip reports: AXIS (everything at a category) or ITEM (one bar, point or slice). |
| `dataset` | `<record: record>` | A table of data, e.g. `dataset id "sales" columns ["month" "revenue"] rows [["Jan" 120]] {}`. |
| `axis` | `<record: record>` | One axis, e.g. `axis id "month" direction X scale CATEGORY categories "month" {}`. |
| `plot` | `<record: record>` | One plot, e.g. `plot kind BAR values "revenue" {}`. |
| `legend` | `<record: record>` | A chart's legend, e.g. `legend show true position TOP {}`. |
| `tooltip` | `<record: record>` | A chart's tooltip, e.g. `tooltip trigger ITEM {}`. |
| `charts` | `<list record: record>` | The program: its datasets and charts, then the collection's settings (title, instructions, theme, palette, …). |
| `chart` | `<list record: record>` | One chart: its parts (datasets, axes, plots, legend, tooltip), then its settings (id, name, title, …). |
| `datasets` | `<list record: record>` | A list of datasets, then `{}`. |
| `axes` | `<list record: record>` | A chart's axes, then `{}`. |
| `plots` | `<list record: record>` | A chart's plots, then `{}`. |

# Tags

Closed sets are uppercase tags, written bare.

| Word | Tags |
| --- | --- |
| `theme` | LIGHT, DARK |
| `direction` | X, Y, RADIAL |
| `scale` | CATEGORY, LINEAR, LOG, TIME |
| `kind` | BAR, LINE, PIE, SCATTER, HISTOGRAM, BOXPLOT, CANDLESTICK, HEATMAP, FUNNEL, GAUGE, RADAR |
| `position` | TOP, BOTTOM, LEFT, RIGHT, INSIDE, OUTSIDE, CENTER |
| `step` | START, MIDDLE, END |
| `symbol` | CIRCLE, RECT, TRIANGLE, DIAMOND, PIN, ARROW, NONE |
| `rose` | RADIUS, AREA |
| `trigger` | AXIS, ITEM |

# Plot kinds

Plots that share X and Y axes — BAR, LINE, SCATTER, BOXPLOT, CANDLESTICK — may share a chart.
A HISTOGRAM, HEATMAP, FUNNEL or PIE takes a chart of its own. A chart of GAUGEs holds one to
four, side by side. RADAR plots share a chart's one RADIAL axis, whose categories are the spokes.

| Kind | Data |
| --- | --- |
| BAR | `values`, one per category |
| LINE | `values`, one per category, or `x` and `y` pairs |
| SCATTER | `x` and `y`, one per point; optional `names` |
| PIE, FUNNEL | `names` and `values`, one per slice or stage |
| HISTOGRAM | `values`: raw observations, counted into `bin-count` equal bins (default: Sturges' rule) |
| BOXPLOT | `values` with `group` (a category per value), or `values` as one list per category |
| CANDLESTICK | `open`, `close`, `low`, `high`, one per category |
| HEATMAP | `values` as a matrix, one row per Y category; or `x`, `y` and `values`, one per cell |
| GAUGE | `value`, within `min-value` and `max-value` (default 0 to 100) |
| RADAR | `values`, one per spoke |

```
charts [
  chart [
    plots [ plot kind HISTOGRAM name "Scores" values [52 61 64 68 70 71 73 75 78 81 84 90] {} ] {}
  ] id "hist" name "Histogram" {}
  chart [
    plots [
      plot kind BOXPLOT name "Minutes" values [12 15 14 30 22 25 21 24 60] group ["A" "A" "A" "A" "B" "B" "B" "B" "B"] {}
    ] {}
  ] id "box" name "Box plot" {}
  chart [
    axes [
      axis direction X categories ["Mon" "Tue" "Wed"] {}
      axis direction Y categories ["AM" "PM"] {}
    ] {}
    plots [ plot kind HEATMAP values [[3 5 2] [8 null 6]] label show true {} {} ] {}
  ] id "heat" name "Heatmap" {}
  chart [
    plots [ plot kind GAUGE name "Progress" value 72 {} ] {}
  ] id "gauge" name "Gauge" {}
  chart [
    axes [ axis direction RADIAL categories ["Speed" "Power" "Range" "Cost"] max-value 10 {} ] {}
    plots [
      plot kind RADAR name "Model A" values [8 6 7 4] area true {}
      plot kind RADAR name "Model B" values [5 9 6 7] {}
    ] {}
  ] id "radar" name "Radar" {}
] title "More plot kinds" {}..
```

# Datasets

A dataset is a table with an id, unique column names and rectangular rows. Data words take an
inline list or a column name, and every column name is resolved when the program compiles:

```
charts [
  datasets [
    dataset id "grades" rows [
      {subject: "Math" fall: 78 spring: 85}
      {subject: "Reading" fall: 82 spring: 88}
      {subject: "Science" fall: 74 spring: 81}
    ] {}
  ] {}
  chart [
    axes [ axis direction X categories "subject" {} axis direction Y min-value 0 max-value 100 {} ] {}
    plots [
      plot kind BAR name "Fall" values "fall" {}
      plot kind BAR name "Spring" values "spring" {}
    ] {}
  ] title "Average grade by subject" {}
] {}..
```

# Several charts

A collection shows one chart at a time, with a tab per chart once there are two or more:

```
charts [
  datasets [
    dataset id "q" columns ["quarter" "north" "south"]
      rows [["Q1" 40 32] ["Q2" 44 30] ["Q3" 51 38] ["Q4" 49 41]] {}
  ] {}
  chart [
    axes [ axis direction X categories "quarter" {} axis direction Y {} ] {}
    plots [
      plot kind LINE values "north" {}
      plot kind LINE values "south" {}
    ] {}
  ] id "trend" name "Trend" {}
  chart [
    axes [ axis direction X categories "quarter" {} axis direction Y {} ] {}
    plots [
      plot kind BAR values "north" stack "all" {}
      plot kind BAR values "south" stack "all" {}
    ] {}
  ] id "total" name "Total" {}
] title "Units by quarter" {}..
```

# Output

A program compiles to `{type: "charts", charts, view}`: each chart carries its `id`, `name`,
ECharts `option` (with its data inline) and a `view` of its size and whether it is empty; the
collection's `view` carries its title, instructions, theme, background and navigation.
