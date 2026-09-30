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
    expect(await errorOf("charts [ chart [  plots [ plot kind BAR direction X values [1] {} ] {} ]  {} ] {}")).toBe("plot 1: `direction` is not part of plot. It takes: id, kind, name, x-axis, y-axis, values, names, x, y, color, colors, stack, smooth, area, step, symbol, symbol-size, bar-width, inner-radius, radius, rose, start-angle, label. `direction` belongs in `axis`.");
  });
  it("labelWordInPlot", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind BAR formatter \"{c}\" values [1] {} ] {} ]  {} ] {}")).toBe("plot 1: `formatter` is not part of plot. It takes: id, kind, name, x-axis, y-axis, values, names, x, y, color, colors, stack, smooth, area, step, symbol, symbol-size, bar-width, inner-radius, radius, rose, start-angle, label. `formatter` belongs inside `label … {}`, e.g. label show true position TOP formatter \"{c}\" {}.");
  });
  it("wrongKindWord", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind PIE names [\"a\"] values [1] smooth true {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: `smooth` does not apply to a PIE plot. A PIE plot takes: id, kind, name, names, values, colors, inner-radius, radius, rose, start-angle, label. `smooth` is for LINE plots.");
  });
  it("noKind", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot values [1] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: needs a kind, one of BAR, LINE, PIE, SCATTER, e.g. plot kind BAR values [1 2 3] {}.");
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
    expect(await errorOf("charts [ chart [  plots [ plot kind SCATTER values [1 2] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1: `values` does not apply to a SCATTER plot. A SCATTER plot takes: id, kind, name, x-axis, y-axis, x, y, names, color, symbol, symbol-size, label. `values` is for BAR, LINE, PIE plots.");
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
    expect(await errorOf("charts [ chart [ axes [ axis categories [\"a\"] {} axis direction Y {} ] {} plots [ plot kind BAR values [1] {} ] {} ]  {} ] {}")).toBe("chart \"c1\" axis 1: needs a direction, X or Y, e.g. axis direction X {}.");
  });
  it("navBothOff", async () => {
    expect(await errorOf("charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] show-chart-tabs false hide-chart-menu true {}")).toBe("charts: `show-chart-tabs false` with `hide-chart-menu true` leaves no way to reach any chart but the first. Keep the tabs or the menu.");
  });
  it("badColor", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind BAR values [1] color \"blu-500\" {} ] {} ]  {} ] {}")).toBe("chart \"c1\" plot 1 color: \"blu-500\" is not a colour. Use a Tailwind token like \"blue-500\" (shades 50–950) or a hex code like \"#3b82f6\".");
  });
  it("quotedTag", async () => {
    expect(await errorOf("charts [ chart [  plots [ plot kind \"BAR\" values [1] {} ] {} ]  {} ] {}")).toBe("kind: expected one of BAR, LINE, PIE, SCATTER, got \"BAR\". Write it bare and uppercase, without quotes: kind BAR.");
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
});

describe("what is allowed", () => {
  it("allows repeated plot names when the legend is hidden", async () => {
    await expect(compile("charts [ chart [ legend show false {} plots [ plot name \"S\" kind BAR values [1] {} plot name \"S\" kind LINE values [2] {} ] {} ]  {} ] {}")).resolves.toBeTruthy();
  });
  it("skips nulls when checking a LOG axis", async () => {
    await expect(compile("charts [ chart [ axes [ axis direction X categories [\"a\" \"b\"] {} axis direction Y scale LOG {} ] {} plots [ plot kind BAR values [1 null] {} ] {} ]  {} ] {}")).resolves.toBeTruthy();
  });
});
