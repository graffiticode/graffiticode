// SPDX-License-Identifier: MIT
// Exact wording, because the generator is an LLM that reads these messages and tries again:
// each one names what was wrong, where, and how to write it instead. Generated from the reviewed
// messages; change a message deliberately, then update its line here.
import { describe, expect, it } from "vitest";
import { compile, errorOf } from "./harness.js";


describe("errors", () => {
  it("earlyClose", async () => {
    expect(await errorOf("charts [ chart [ plots [ plot kind BAR {} values [1 2] {} ] {} ] {} ] {}")).toBe("plots: item 2 is a `values`, not a `plot`. Every item is written plot kind BAR values \"revenue\" {}. If `values` belongs to the plot before it, a `{}` ended that plot early: a description ends in exactly one `{}`, after its last word.");
  });
  it("earlyCloseTop", async () => {
    expect(await errorOf("charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {} title \"x\" {}")).toBe("A `{}` ended a description early: the program has 2 top-level expressions where one `charts [ … ] {}` was expected, and the words after the early `{}` started a new one. Every description ends in exactly one `{}`, after its last word: write `plot kind BAR values [1 2] {}`, not `plot kind BAR {} values [1 2] {}`.");
  });
  it("titleInChart", async () => {
    expect(await errorOf("charts [ chart [ plots [ plot kind BAR values [1] {} ] {} title \"x\" {} ] {} ] {}")).toBe("chart: item 2 is a `title`, which is not a part of chart. It holds: datasets, axes, plots, legend, tooltip. `title` is a setting of chart: write it after the chart's `]`, e.g. chart [ … ] title … {}.");
  });
  it("plotsInCharts", async () => {
    expect(await errorOf("charts [ plots [ plot kind BAR values [1] {} ] {} ] {}")).toBe("charts: item 1 is a `plots`, which is not a part of charts. It holds: datasets, chart. `plots` is a part of `chart`: write it inside its `[ … ]`.");
  });
  it("axisInPlot", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind BAR direction X values [1] {} ] {} ]  {} ] {}")).toBe("plot 1: `direction` is not part of plot. It takes: id, kind, name, x-axis, y-axis, values, names, x, y, color, colors, stack, smooth, area, step, symbol, symbol-size, bar-width, inner-radius, radius, rose, start-angle, label, value, min-value, max-value, bin-count, group, open, close, low, high. `direction` belongs in `axis`.");
  });
  it("labelWordInPlot", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind BAR formatter \"{c}\" values [1] {} ] {} ]  {} ] {}")).toBe("plot 1: `formatter` is not part of plot. It takes: id, kind, name, x-axis, y-axis, values, names, x, y, color, colors, stack, smooth, area, step, symbol, symbol-size, bar-width, inner-radius, radius, rose, start-angle, label, value, min-value, max-value, bin-count, group, open, close, low, high. `formatter` belongs inside `label … {}`, e.g. label show true position TOP formatter \"{c}\" {}.");
  });
  it("wrongKindWord", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind PIE names [\"a\"] values [1] smooth true {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: `smooth` does not apply to a PIE plot. A PIE plot takes: id, kind, name, names, values, colors, inner-radius, radius, rose, start-angle, label. `smooth` is for LINE plots.");
  });
  it("noKind", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot values [1] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: needs a kind, one of BAR, LINE, PIE, SCATTER, HISTOGRAM, BOXPLOT, CANDLESTICK, HEATMAP, FUNNEL, GAUGE, RADAR, e.g. plot kind BAR values [1 2 3] {}.");
  });
  it("twoPlots", async () => {
    expect(await errorOf("charts [ chart [ plots [ plot kind BAR values [1] {} ] {} plots [ plot kind BAR values [2] {} ] {} ] {} ] {}")).toBe("chart: `plots` appears 2 times. A chart takes one `plots`; put everything in it.");
  });
  it("noPlots", async () => {
    expect(await errorOf("charts [ chart [ legend show true {} ] {} ] {}")).toBe("chart: needs a `plots`, e.g. chart [ plots [ plot kind BAR values [1 2 3] {} ] {} ] title \"…\" {}.");
  });
  it("emptyPlots", async () => {
    expect(await errorOf("charts [ chart [ plots [ ] {} ] {} ] {}")).toBe("chart: plots is empty. A chart needs at least one plot, e.g. plots [ plot kind BAR … {} ] {}.");
  });
  it("noCharts", async () => {
    expect(await errorOf("charts [ ] {}")).toBe("charts: needs a `chart`, e.g. charts [ chart [ … ] {} ] {}.");
  });
  it("dupChartId", async () => {
    expect(await errorOf("charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] id \"a\" {} chart [ plots [ plot kind BAR values [1] {} ] {} ] id \"a\" {} ] {}")).toBe("charts: charts 1 and 2 both have the id \"a\". Ids pick a chart's tab, so give each chart its own id.");
  });
  it("dupPlotId", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot id \"p\" kind BAR values [1] {} plot id \"p\" kind LINE values [2] {} ] {} ]  {} ] {}")).toBe("chart \"c1\": two plots have the id \"p\". Give each plot its own id.");
  });
  it("dupAxisId", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis id \"a\" direction X {} axis id \"a\" direction Y {} ] {} plots [ plot kind BAR values [1] {} ] {} ]  {} ] {}")).toBe("chart \"c1\": two axes have the id \"a\". Give each axis its own id.");
  });
  it("dupDataset", async () => {
    expect(await errorOf("charts [ datasets [ dataset id \"d\" columns [\"v\"] rows [[1]] {} dataset id \"d\" columns [\"v\"] rows [[2]] {} ] {} chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {}")).toBe("charts datasets: two datasets have the id \"d\". Give each dataset in one list its own id.");
  });
  it("dupLegendPlots", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot name \"S\" kind BAR values [1] {} plot name \"S\" kind LINE values [2] {} ] {} ]  {} ] {}")).toBe("chart \"c1\": plots \"p1\" and \"p2\" are both named \"S\". Legend entries toggle plots by name, so give each plot its own name, or hide the legend with legend show false {}.");
  });
  it("dupLegendSlices", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind PIE names [\"a\" \"b\" \"a\"] values [1 2 3] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: two slices are named \"a\" (items 1 and 3). Legend entries toggle slices by name, so give each slice its own name, or hide the legend with legend show false {}.");
  });
  it("unknownColumn", async () => {
    expect(await errorOf("charts [ datasets [ dataset columns [\"month\" \"revenue\"] rows [[\"Jan\" 1]] {} ] {} chart [ plots [ plot kind BAR values \"rev\" {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: values \"rev\" is not a column of dataset \"d1\". Its columns are: \"month\", \"revenue\".");
  });
  it("ambiguousDataset", async () => {
    expect(await errorOf("charts [ datasets [ dataset id \"a\" columns [\"v\"] rows [[1]] {} dataset id \"b\" columns [\"v\"] rows [[2]] {} ] {} chart [ plots [ plot kind BAR values \"v\" {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: values \"v\" names a column, but 2 datasets are visible (\"a\", \"b\"), so write dataset-id \"…\" in the chart's settings to pick one.");
  });
  it("badDatasetId", async () => {
    expect(await errorOf("charts [ datasets [ dataset id \"a\" columns [\"v\"] rows [[1]] {} ] {} chart [ plots [ plot kind BAR values \"v\" {} ] {} ] dataset-id \"z\" {} ] {}")).toBe("chart \"c1\": dataset-id \"z\" names no dataset. Datasets here: \"a\".");
  });
  it("raggedRow", async () => {
    expect(await errorOf("charts [ datasets [ dataset columns [\"a\" \"b\"] rows [[\"x\" 1] [\"y\"]] {} ] {} chart [ plots [ plot kind BAR values \"b\" {} ] {} ] {} ] {}")).toBe("charts datasets dataset 1: row 2 has 1 value, but there are 2 columns (a, b).");
  });
  it("listRowsNoColumns", async () => {
    expect(await errorOf("charts [ datasets [ dataset rows [[\"x\" 1]] {} ] {} chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {}")).toBe("charts datasets dataset 1: rows written as lists need `columns` to name them, e.g. columns [\"month\" \"revenue\"].");
  });
  it("lineBothForms", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind LINE values [1 2] x [1 2] y [3 4] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: write a LINE either with values (one per category) or with x and y (pairs), not both.");
  });
  it("scatterValues", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind SCATTER values [1 2] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: `values` does not apply to a SCATTER plot. A SCATTER plot takes: id, kind, name, x-axis, y-axis, x, y, names, color, symbol, symbol-size, label. `values` is for BAR, LINE, PIE, HISTOGRAM, BOXPLOT, HEATMAP, FUNNEL, RADAR plots.");
  });
  it("scatterTuples", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind SCATTER x [1 2] y [[1 2] [3 4]] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: y item 1: a value must be a number, a string, true/false or null — got a list or a record.");
  });
  it("lengthMismatch", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X categories [\"a\" \"b\"] {} axis direction Y {} ] {} plots [ plot kind BAR values [1 2 3] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: has 3 values but axis \"x1\" has 2 categories. Give one value per category (null for a gap).");
  });
  it("pairLengths", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind SCATTER x [1 2 3] y [1 2] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: x has 3 items but y has 2. They pair up, so they must be the same length.");
  });
  it("nullInPie", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind PIE names [\"a\" \"b\"] values [1 null] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: values item 2 is null. A missing value is only allowed where the plot can show a gap.");
  });
  it("negativePie", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind PIE names [\"a\" \"b\"] values [1 -2] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: values item 2 is -2; a PIE slice cannot be negative.");
  });
  it("stringValue", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind BAR values [1 \"two\"] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: values item 2 is \"two\", not a number.");
  });
  it("logNonPositive", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X categories [\"a\" \"b\"] {} axis direction Y scale LOG {} ] {} plots [ plot kind BAR values [1 0] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: values item 2 is 0, but axis \"y1\" is LOG, which only shows values above 0.");
  });
  it("noXAxisRef", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis id \"m\" direction X {} axis direction Y {} ] {} plots [ plot kind BAR x-axis \"zz\" values [1] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: x-axis \"zz\" names no axis. X axes here: \"m\".");
  });
  it("wrongDirRef", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X categories [\"a\"] {} axis id \"v\" direction Y {} ] {} plots [ plot kind BAR x-axis \"v\" values [1] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: x-axis \"v\" is a Y axis, not X.");
  });
  it("ambiguousAxis", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X categories [\"a\"] {} axis direction Y {} axis direction Y {} ] {} plots [ plot kind BAR values [1] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: there are 2 Y axes (\"y1\", \"y2\"), so write y-axis \"…\" to pick one.");
  });
  it("barNoCategory", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X {} axis direction Y {} ] {} plots [ plot kind BAR values [1] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: a BAR of values needs a CATEGORY axis for its steps; axes \"x1\" and \"y1\" are LINEAR and LINEAR.");
  });
  it("pieWithBar", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind PIE names [\"a\"] values [1] {} plot kind BAR values [1] {} ] {} ]  {} ] {}")).toBe("chart \"c1\": a PIE cannot share a chart with BAR plots. Put the pie in its own chart in the collection.");
  });
  it("pieWithAxes", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X {} axis direction Y {} ] {} plots [ plot kind PIE names [\"a\"] values [1] {} ] {} ]  {} ] {}")).toBe("chart \"c1\": a PIE has no axes. Remove `axes` from this chart.");
  });
  it("noDirection", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis categories [\"a\"] {} axis direction Y {} ] {} plots [ plot kind BAR values [1] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" axis 1: needs a direction, X, Y or RADIAL, e.g. axis direction X {}.");
  });
  it("navBothOff", async () => {
    expect(await errorOf("charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] show-chart-tabs false {}")).toBe("charts: `show-chart-tabs false` without `show-chart-menu true` leaves no way to reach any chart but the first. Keep the tabs, or add show-chart-menu true.");
  });
  it("badColor", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind BAR values [1] color \"blu-500\" {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1 color: \"blu-500\" is not a colour. Use a Tailwind token like \"blue-500\" (shades 50–950) or a hex code like \"#3b82f6\".");
  });
  it("quotedTag", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind \"BAR\" values [1] {} ] {} ]  {} ] {}")).toBe("kind: expected one of BAR, LINE, PIE, SCATTER, HISTOGRAM, BOXPLOT, CANDLESTICK, HEATMAP, FUNNEL, GAUGE, RADAR, got \"BAR\". Write it bare and uppercase, without quotes: kind BAR.");
  });
  it("twice", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind BAR values [1] values [2] {} ] {} ]  {} ] {}")).toBe("values: is given twice. Each word may appear once in a description.");
  });
  it("labelPosPie", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind PIE names [\"a\"] values [1] label position TOP {} {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1 label: a PIE label sits at INSIDE, OUTSIDE, CENTER, not TOP.");
  });
  it("legendPos", async () => {
    expect(await errorOf("charts [ chart [ legend position INSIDE {} plots [ plot kind BAR values [1] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" legend: position is TOP, BOTTOM, LEFT or RIGHT, not INSIDE.");
  });
  it("stackXY", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X {} axis direction Y {} ] {} plots [ plot kind LINE x [1 2] y [3 4] stack \"s\" {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: stack groups plots over categories; it does not apply to a plot of x/y pairs.");
  });
  it("notCharts", async () => {
    expect(await errorOf("plot kind BAR values [1] {}")).toBe("A program is one charts collection, ending in `..`: e.g. charts [ chart [ plots [ plot kind BAR values [3 5 2] {} ] {} ] {} ] {}..");
  });
  it("histWithBar", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind HISTOGRAM values [1 2] {} plot kind BAR values [1] {} ] {} ] {} ] {}")).toBe("chart \"c1\": a HISTOGRAM cannot share a chart with BAR plots. Put the histogram in its own chart in the collection.");
  });
  it("twoFunnels", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind FUNNEL names [\"a\"] values [1] {} plot kind FUNNEL names [\"b\"] values [2] {} ] {} ] {} ] {}")).toBe("chart \"c1\": a chart holds one FUNNEL; put each funnel in its own chart.");
  });
  it("gaugeWithRadar", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction RADIAL categories [\"a\" \"b\" \"c\"]  {} ] {} plots [ plot kind GAUGE value 1 {} plot kind RADAR values [1 2 3] {} ] {} ] {} ] {}")).toBe("chart \"c1\": a GAUGE cannot share a chart with RADAR plots. Put the gauge in its own chart in the collection.");
  });
  it("fiveGauges", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind GAUGE value 0 {} plot kind GAUGE value 1 {} plot kind GAUGE value 2 {} plot kind GAUGE value 3 {} plot kind GAUGE value 4 {} ] {} ] {} ] {}")).toBe("chart \"c1\": a chart holds at most 4 gauges side by side; this one has 5. Put the rest in another chart.");
  });
  it("pieWithAxes2", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X  {} axis direction Y {} ] {} plots [ plot kind FUNNEL names [\"a\"] values [1] {} ] {} ] {} ] {}")).toBe("chart \"c1\": a FUNNEL has no axes. Remove `axes` from this chart.");
  });
  it("radialInBar", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X categories [\"k\"] {} axis direction Y {} axis direction RADIAL categories [\"a\" \"b\" \"c\"] {} ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}")).toBe("chart \"c1\" axis 3: a RADIAL axis holds the spokes of RADAR plots, and this chart's plots are BAR. Remove it, or put the radar in its own chart.");
  });
  it("twoBoxplotsOneAxis", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X categories [\"k\"] {} axis id \"l\" direction Y {} axis id \"r\" direction Y {} ] {} plots [ plot id \"b1\" kind BOXPLOT y-axis \"l\" values [[1 2 3]] {} plot id \"b2\" kind BOXPLOT y-axis \"r\" values [[4 5 6]] {} ] {} ] {} ] {}")).toBe("chart \"c1\": plots \"b1\" and \"b2\" are both BOXPLOTs on category axis \"x1\". Put each box plot on its own category axis, or in its own chart.");
  });
  it("boxNoGroup", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind BOXPLOT values [1 2 3] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: a BOXPLOT needs its observations grouped by category: values with group (the category of each value), or values as a list of lists, one per category.");
  });
  it("boxGroupNested", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind BOXPLOT values [[1 2] [3]] group [\"a\" \"b\"] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: values is a list of lists, which already groups the observations by category. Remove group, or write values as one flat list with group.");
  });
  it("boxGroupLength", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind BOXPLOT values [1 2 3] group [\"a\" \"b\"] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: values has 3 items but group has 2. They pair up, so they must be the same length.");
  });
  it("boxGroupUnknown", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X categories [\"a\" \"b\"] {} axis direction Y {} ] {} plots [ plot kind BOXPLOT values [1 2] group [\"a\" \"z\"] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: group item 2 is \"z\", which is not a category of axis \"x1\". Its categories are: \"a\", \"b\".");
  });
  it("boxNestedCount", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X categories [\"a\" \"b\" \"c\"] {} axis direction Y {} ] {} plots [ plot kind BOXPLOT values [[1 2] [3]] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: has 2 lists of values but axis \"x1\" has 3 categories. Give one list per category ([] for none).");
  });
  it("boxNull", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind BOXPLOT values [[1 null]] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: values list 1 item 2 is null. A missing value is only allowed where the plot can show a gap.");
  });
  it("nestedColumn", async () => {
    expect(await errorOf("charts [ datasets [ dataset columns [\"v\"] rows [[1]] {} ] {} chart [ plots [ plot kind HEATMAP values \"v\" {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: values \"v\" names a column, but a column is a flat list and this form needs a list of lists. With a dataset, use the long form: x, y and values for a HEATMAP, or values and group for a BOXPLOT.");
  });
  it("binCountZero", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind HISTOGRAM values [1 2] bin-count 0 {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: bin-count must be a whole number above 0, got 0.");
  });
  it("binCountFraction", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind HISTOGRAM values [1 2] bin-count 2.5 {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: bin-count must be a whole number above 0, got 2.5.");
  });
  it("binCountNegative", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind HISTOGRAM values [1 2] bin-count -3 {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: bin-count must be a whole number above 0, got -3.");
  });
  it("histNested", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind HISTOGRAM values [[1 2] [3]] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: a HISTOGRAM counts raw observations, so values is one flat list, e.g. values [3 7 7 9 12]. To draw counts you already have, use a BAR.");
  });
  it("histAxisWord", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X categories [\"a\"] {} axis direction Y {} ] {} plots [ plot kind HISTOGRAM values [1 2] {} ] {} ] {} ] {}")).toBe("chart \"c1\" axis 1: a HISTOGRAM's axes are generated — bins across a CATEGORY X axis, counts up a LINEAR Y axis — so an axis here takes only id, direction, scale and name, not `categories`.");
  });
  it("histAxisScale", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X  {} axis direction Y scale LOG {} ] {} plots [ plot kind HISTOGRAM values [1 2] {} ] {} ] {} ] {}")).toBe("chart \"c1\" axis 2: a HISTOGRAM's Y axis is LINEAR, not LOG.");
  });
  it("candleOrderLow", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind CANDLESTICK open [2] close [3] low [2.5] high [4] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: row 1 has low 2.5 above its open (2) or close (3). low must be at most both, and high at least both.");
  });
  it("candleOrderHigh", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind CANDLESTICK open [2] close [3] low [1] high [2.5] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: row 1 has high 2.5 below its open (2) or close (3). low must be at most both, and high at least both.");
  });
  it("candleLength", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind CANDLESTICK open [1 2] close [2] low [0] high [3] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: open has 2 items but close has 1. They pair up, so they must be the same length.");
  });
  it("candleCategories", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X categories [\"a\" \"b\"] {} axis direction Y {} ] {} plots [ plot kind CANDLESTICK open [1] close [2] low [0] high [3] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: has 1 row but axis \"x1\" has 2 categories. Give one open, close, low and high per category.");
  });
  it("gaugeNoValue", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind GAUGE {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: a GAUGE plot needs value, e.g. plot kind GAUGE value 72 {}.");
  });
  it("gaugeRange", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind GAUGE value 120 {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: value 120 is off the dial, which runs from 0 to 100. Set min-value or max-value to include it.");
  });
  it("gaugeMinMax", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind GAUGE value 5 min-value 10 max-value 10 {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: min-value (10) must be less than max-value (10).");
  });
  it("heatRows", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X categories [\"Mon\" \"Tue\"] {} axis direction Y categories [\"AM\" \"PM\"] {} ] {} plots [ plot kind HEATMAP values [[1 2]] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: values has 1 row but axis \"y1\" has 2 categories. A HEATMAP matrix has one row per Y category.");
  });
  it("heatCells", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X categories [\"Mon\" \"Tue\"] {} axis direction Y categories [\"AM\" \"PM\"] {} ] {} plots [ plot kind HEATMAP values [[1 2] [3]] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: values row 2 has 1 cell but axis \"x1\" has 2 categories. Each row has one cell per X category (null for none).");
  });
  it("heatMatrixNoCats", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind HEATMAP values [[1 2] [3 4]] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: a HEATMAP written as a matrix needs categories on both axes, to name its rows and columns. Axis \"x1\" has none.");
  });
  it("heatFlat", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind HEATMAP values [1 2] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: a HEATMAP needs values as a matrix — one list of cells per Y category, e.g. values [[1 2] [3 4]] — or x, y and values, one of each per cell.");
  });
  it("heatBothForms", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind HEATMAP x [\"a\"] y [\"b\"] values [[1]] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: write a HEATMAP either as a matrix (values as rows of cells) or as cells (x, y and values, one each), not both.");
  });
  it("heatPartialCells", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind HEATMAP x [\"a\"] values [1] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: a HEATMAP written as cells needs x, y and values, one of each per cell.");
  });
  it("heatDupPair", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind HEATMAP x [\"a\" \"b\" \"a\"] y [\"u\" \"u\" \"u\"] values [1 2 3] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: the cell (\"a\", \"u\") is given twice, at items 1 and 3. Give each cell once.");
  });
  it("heatUnknown", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X categories [\"Mon\" \"Tue\"] {} axis direction Y categories [\"AM\" \"PM\"] {} ] {} plots [ plot kind HEATMAP x [\"Mon\" \"Wed\"] y [\"AM\" \"AM\"] values [1 2] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: x item 2 is \"Wed\", which is not a category of axis \"x1\". Its categories are: \"Mon\", \"Tue\".");
  });
  it("heatLinear", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction X scale LINEAR {} axis direction Y {} ] {} plots [ plot kind HEATMAP x [\"a\"] y [\"b\"] values [1] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: a HEATMAP is a grid of categories, so both axes are CATEGORY; axis \"x1\" is LINEAR.");
  });
  it("radarNoAxis", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind RADAR values [1 2 3] {} ] {} ] {} ] {}")).toBe("chart \"c1\": a RADAR plot needs a RADIAL axis for its spokes. Add axes [ axis direction RADIAL categories [\"…\" \"…\" \"…\"] {} ] {}.");
  });
  it("radarWithX", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction RADIAL categories [\"a\" \"b\" \"c\"] {} axis direction X {} ] {} plots [ plot kind RADAR values [1 2 3] {} ] {} ] {} ] {}")).toBe("chart \"c1\" axis 2: a RADAR chart is drawn on one RADIAL axis; it has no X axis. Remove it.");
  });
  it("radialTwoSpokes", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction RADIAL categories [\"a\" \"b\"] {} ] {} plots [ plot kind RADAR values [1 2] {} ] {} ] {} ] {}")).toBe("chart \"c1\" axis 1: a RADIAL axis needs at least 3 spokes; it has 2. For fewer, use a BAR chart.");
  });
  it("radialDupSpoke", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction RADIAL categories [\"a\" \"b\" \"a\"] {} ] {} plots [ plot kind RADAR values [1 2 3] {} ] {} ] {} ] {}")).toBe("chart \"c1\" axis 1: the spoke \"a\" appears twice. Spokes must differ.");
  });
  it("radialNoCategories", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction RADIAL {} ] {} plots [ plot kind RADAR values [1 2 3] {} ] {} ] {} ] {}")).toBe("chart \"c1\" axis 1: a RADIAL axis needs categories, one per spoke, e.g. categories [\"Speed\" \"Power\" \"Range\"].");
  });
  it("radialPosition", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction RADIAL categories [\"a\" \"b\" \"c\"] position LEFT {} ] {} plots [ plot kind RADAR values [1 2 3] {} ] {} ] {} ] {}")).toBe("chart \"c1\" axis 1: a RADIAL axis has no position; its spokes are spaced evenly around the circle.");
  });
  it("radialScale", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction RADIAL scale LINEAR categories [\"a\" \"b\" \"c\"] {} ] {} plots [ plot kind RADAR values [1 2 3] {} ] {} ] {} ] {}")).toBe("chart \"c1\" axis 1: a RADIAL axis is CATEGORY — its categories are the spokes — not LINEAR.");
  });
  it("radialMinMax", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction RADIAL categories [\"a\" \"b\" \"c\"] min-value 5 max-value 5 {} ] {} plots [ plot kind RADAR values [5 5 5] {} ] {} ] {} ] {}")).toBe("chart \"c1\" axis 1: min-value (5) must be less than max-value (5).");
  });
  it("radarNegative", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction RADIAL categories [\"a\" \"b\" \"c\"]  {} ] {} plots [ plot kind RADAR values [1 -2 3] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: values item 2 is -2, outside axis \"radial1\", which runs from 0 to 5. A RADIAL axis starts at 0 unless you set min-value.");
  });
  it("radarAboveMax", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction RADIAL categories [\"a\" \"b\" \"c\"] max-value 10 {} ] {} plots [ plot kind RADAR values [1 12 3] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: values item 2 is 12, outside axis \"radial1\", which runs from 0 to 10. Widen the axis's max-value to include it.");
  });
  it("radarSpokeCount", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction RADIAL categories [\"a\" \"b\" \"c\"]  {} ] {} plots [ plot kind RADAR values [1 2] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: has 2 values but axis \"radial1\" has 3 spokes. Give one value per spoke.");
  });
  it("radarBigMin", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction RADIAL categories [\"a\" \"b\" \"c\"] min-value 100000000000000000 {} ] {} plots [ plot kind RADAR values [100000000000000000 100000000000000000 100000000000000000] {} ] {} ] {} ] {}")).toBe("chart \"c1\" axis 1: no max-value can be chosen above min-value 100000000000000000 for these values: at this size, no round number above them can be represented. Write both min-value and max-value on the axis.");
  });
  it("radarOverflow", async () => {
    expect(await errorOf("charts [ chart [ axes [ axis direction RADIAL categories [\"a\" \"b\" \"c\"] min-value -100000000000000001097906362944045541740492309677311846336810682903157585404911491537163328978494688899061249669721172515611590283743140088328307009198146046031271664502933027185697489699588559043338384466165001178426897626212945177628091195786707458122783970171784415105291802893207873272974885715430223118336 {} ] {} plots [ plot kind RADAR values [169999999999999993883079578865998174333346074304075874502773119193537729178160565864330091787584707988572262467983188919169916105593357174268369962062473635296474636515660464935663040684957844303524367815028553272712298986386310828644513212353921123253311675499856875650512437415429217994623324794855339589632 1 1] {} ] {} ] {} ] {}")).toBe("chart \"c1\" axis 1: no max-value can be chosen above min-value -1e+308 for these values: at this size, no round number above them can be represented. Write both min-value and max-value on the axis.");
  });
  it("dupLegendStages", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind FUNNEL names [\"a\" \"a\"] values [2 1] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: two stages are named \"a\" (items 1 and 2). Legend entries toggle stages by name, so give each stage its own name, or hide the legend with legend show false {}.");
  });
  it("negativeFunnel", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind FUNNEL names [\"a\" \"b\"] values [2 -1] {} ] {} ] {} ] {}")).toBe("chart \"c1\" plot 1: values item 2 is -1; a FUNNEL stage cannot be negative.");
  });
});

describe("what is allowed", () => {
  it("allows repeated plot names when the legend is hidden", async () => {
    await expect(compile("charts [ chart [ legend show false {} plots [ plot name \"S\" kind BAR values [1] {} plot name \"S\" kind LINE values [2] {} ] {} ]  {} ] {}")).resolves.toBeTruthy();
  });
  it("skips nulls when checking a LOG axis", async () => {
    await expect(compile("charts [ chart [ axes [ axis direction X categories [\"a\" \"b\"] {} axis direction Y scale LOG {} ] {} plots [ plot kind BAR values [1 null] {} ] {} ]  {} ] {}")).resolves.toBeTruthy();
  });
});
