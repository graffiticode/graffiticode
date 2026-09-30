// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { compile } from "./harness.js";
import { lexicon } from "./index.js";

const one = (plots: string, rest = "", settings = "") =>
  `charts [ chart [ ${rest} plots [ ${plots} ] {} ] ${settings} {} ] {}`;
const series = async (src: string) => (await compile(src)).charts[0].option.series;

describe("lexicon", () => {
  it("adds L0184's words without overriding any L0000 word", async () => {
    const { lexicon: base } = await import("@graffiticode/l0000");
    for (const w of ["data", "use", "map", "filter", "min", "max", "log", "range", "get"]) {
      expect(lexicon[w]).toEqual((base as any)[w]);
    }
    expect(lexicon["min-value"].arity).toBe(2);
    expect(lexicon.charts.arity).toBe(2);
    expect(lexicon.plot.arity).toBe(1);
    expect(lexicon.BAR).toMatchObject({ name: "TAG", arity: 0 });
  });
});

describe("the envelope", () => {
  it("is always charts, a list of charts, and a complete view", async () => {
    const out = await compile(one("plot kind BAR values [1 2 3] {}"));
    expect(Object.keys(out).sort()).toEqual(["charts", "type", "view"]);
    expect(out.type).toBe("charts");
    expect(out.view).toEqual({ theme: "light", renderer: "canvas", locale: "EN", showTabs: false, hideMenu: false });
    expect(out.charts).toHaveLength(1);
    expect(out.charts[0]).toMatchObject({ id: "c1", name: "c1", view: { width: "100%", height: 384, empty: false } });
  });

  it("never spreads upstream data into the output", async () => {
    const out = await compile(one("plot kind BAR values [1 2] {}"), { stale: 1, type: "chart" });
    expect(out.stale).toBeUndefined();
    expect(out.type).toBe("charts");
  });

  it("carries collection settings into the view", async () => {
    const out = await compile(
      `charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] title "Q1" instructions "Read it." theme DARK background "slate-900" {}`,
    );
    expect(out.view).toMatchObject({ title: "Q1", instructions: "Read it.", theme: "dark", background: "#0f172a" });
    expect(out.charts[0].option.backgroundColor).toBe("#0f172a");
  });

  it("resolves the palette into option.color", async () => {
    const out = await compile(
      `charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] palette ["blue-500" "#10B981"] {}`,
    );
    expect(out.charts[0].option.color).toEqual(["#3b82f6", "#10b981"]);
  });
});

describe("bar and line", () => {
  it("draws values over a default category axis", async () => {
    const out = await compile(one("plot kind BAR values [3 5 2] {}"));
    const o = out.charts[0].option;
    expect(o.xAxis).toEqual([{ id: "x1", type: "category", gridIndex: 0, position: "bottom", data: ["1", "2", "3"] }]);
    expect(o.yAxis[0]).toMatchObject({ id: "y1", type: "value" });
    expect(o.series[0]).toMatchObject({ type: "bar", data: [3, 5, 2], xAxisIndex: 0, yAxisIndex: 0 });
    expect(o.tooltip).toEqual({ show: true, trigger: "axis" });
  });

  it("keeps null as a gap, never zero", async () => {
    const s = await series(one("plot kind LINE values [1 null 3] {}"));
    expect(s[0].data).toEqual([1, null, 3]);
    expect(s[0].connectNulls).toBe(false);
  });

  it("stacks, smooths, fills and steps", async () => {
    const s = await series(
      one(
        'plot kind BAR name "A" values [1 2] stack "t" bar-width "40%" {} plot kind LINE name "B" values [3 4] stack "t" area true step MIDDLE symbol DIAMOND symbol-size 8 {}',
      ),
    );
    expect(s[0]).toMatchObject({ stack: "t", barWidth: "40%" });
    expect(s[1]).toMatchObject({ stack: "t", areaStyle: {}, step: "middle", symbol: "diamond", symbolSize: 8 });
  });

  it("makes a horizontal bar chart when categories are on the Y axis", async () => {
    const o = (
      await compile(
        one(
          "plot kind BAR values [5 9] {}",
          'axes [ axis direction X {} axis direction Y categories ["a" "b"] {} ] {}',
        ),
      )
    ).charts[0].option;
    expect(o.xAxis[0].type).toBe("value");
    expect(o.yAxis[0]).toMatchObject({ type: "category", data: ["a", "b"] });
  });

  it("draws an x/y LINE on a TIME axis", async () => {
    const out = await compile(
      one(
        'plot kind LINE x ["2026-01-01" "2026-02-01"] y [3 4] {}',
        "axes [ axis direction X scale TIME {} axis direction Y {} ] {}",
      ),
    );
    const o = out.charts[0].option;
    expect(o.xAxis[0].type).toBe("time");
    expect(o.series[0].data).toEqual([["2026-01-01", 3], ["2026-02-01", 4]]);
    expect(o.tooltip.trigger).toBe("item");
  });

  it("binds a plot to a secondary axis by id and places it on the right", async () => {
    const o = (
      await compile(
        one(
          'plot name "Revenue" kind BAR y-axis "usd" values [120 132] {} plot name "Margin" kind LINE y-axis "pct" values [32 35] {}',
          'axes [ axis direction X categories ["Q1" "Q2"] {} axis id "usd" direction Y {} axis id "pct" direction Y min-value 0 max-value 100 {} ] {}',
        ),
      )
    ).charts[0].option;
    expect(o.yAxis.map((a: any) => [a.id, a.position])).toEqual([["usd", "left"], ["pct", "right"]]);
    expect(o.yAxis[1]).toMatchObject({ min: 0, max: 100 });
    expect(o.series[1].yAxisIndex).toBe(1);
    expect(o.series[0].yAxisIndex).toBe(0);
  });

  it("colours a plot, and each bar", async () => {
    const s = await series(
      one('plot kind BAR values [1 2] colors ["red-500" "#000000"] {} plot kind LINE values [3 4] color "amber-500" {}'),
    );
    expect(s[0].data).toEqual([
      { value: 1, itemStyle: { color: "#ef4444" } },
      { value: 2, itemStyle: { color: "#000000" } },
    ]);
    expect(s[1].color).toBe("#f59e0b");
  });

  it("labels bars through a nested label description", async () => {
    const s = await series(one('plot kind BAR values [1 2] label position INSIDE formatter "{c}%" {} {}'));
    expect(s[0].label).toEqual({ show: true, position: "inside", formatter: "{c}%" });
  });
});

describe("pie", () => {
  it("draws a donut with a legend and item tooltip", async () => {
    const o = (
      await compile(one('plot kind PIE names ["A" "B"] values [60 40] inner-radius "50%" rose AREA start-angle 0 {}'))
    ).charts[0].option;
    expect(o.series[0]).toMatchObject({
      type: "pie",
      data: [{ name: "A", value: 60 }, { name: "B", value: 40 }],
      radius: ["50%", "70%"],
      roseType: "area",
      startAngle: 0,
    });
    expect(o.legend).toMatchObject({ show: true, bottom: 8 });
    expect(o.tooltip.trigger).toBe("item");
    expect(o.xAxis).toBeUndefined();
  });
});

describe("scatter", () => {
  it("pairs x and y, and labels named points with their names", async () => {
    const s = await series(one('plot kind SCATTER x [1 2] y [3 4] names ["a" "b"] {}'));
    expect(s[0].data).toEqual([{ name: "a", value: [1, 3] }, { name: "b", value: [2, 4] }]);
    expect(s[0].label).toEqual({ show: true, position: "top", formatter: "{b}" });
  });
});

describe("datasets", () => {
  const sales =
    'datasets [ dataset id "sales" columns ["month" "revenue" "cost"] rows [["Jan" 120 80] ["Feb" 132 90]] {} ] {}';

  it("resolves column names into inline data, and names plots after their columns", async () => {
    const out = await compile(
      `charts [ ${sales} chart [ axes [ axis direction X categories "month" {} axis direction Y {} ] {} plots [ plot kind BAR values "revenue" {} plot kind LINE values "cost" {} ] {} ] {} ] {}`,
    );
    const o = out.charts[0].option;
    expect(o.xAxis[0].data).toEqual(["Jan", "Feb"]);
    expect(o.series.map((s: any) => [s.name, s.data])).toEqual([["revenue", [120, 132]], ["cost", [80, 90]]]);
    expect(JSON.stringify(out)).not.toContain('"dataset"');
    expect(JSON.stringify(out)).not.toContain('"encode"');
  });

  it("accepts rows written as records", async () => {
    const out = await compile(
      `charts [ datasets [ dataset rows [{m: "a" v: 1} {m: "b" v: 2}] {} ] {} chart [ axes [ axis direction X categories "m" {} axis direction Y {} ] {} plots [ plot kind BAR values "v" {} ] {} ] {} ] {}`,
    );
    expect(out.charts[0].option.series[0].data).toEqual([1, 2]);
  });

  it("lets a chart-local dataset shadow a shared one with the same id", async () => {
    const out = await compile(
      `charts [ datasets [ dataset id "d" columns ["v"] rows [[1] [2]] {} ] {}
        chart [ datasets [ dataset id "d" columns ["v"] rows [[7] [8]] {} ] {} plots [ plot kind BAR values "v" {} ] {} ] {}
        chart [ plots [ plot kind BAR values "v" {} ] {} ] {} ] {}`,
    );
    expect(out.charts[0].option.series[0].data).toEqual([7, 8]);
    expect(out.charts[1].option.series[0].data).toEqual([1, 2]);
  });

  it("lets charts reuse the same local ids", async () => {
    const out = await compile(
      `charts [ chart [ plots [ plot id "p" kind BAR values [1] {} ] {} ] {} chart [ plots [ plot id "p" kind BAR values [2] {} ] {} ] {} ] {}`,
    );
    expect(out.charts.map((c: any) => c.option.series[0].id)).toEqual(["p", "p"]);
  });
});

describe("several charts", () => {
  it("keeps source order, defaults ids and names, and shows tabs", async () => {
    const out = await compile(
      `charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] title "One" {} chart [ plots [ plot kind BAR values [2] {} ] {} ] id "two" name "Second" {} ] {}`,
    );
    expect(out.charts.map((c: any) => [c.id, c.name])).toEqual([["c1", "c1"], ["two", "Second"]]);
    expect(out.charts[0].option.title.text).toBe("One");
    expect(out.charts[1].option.title).toBeUndefined();
    expect(out.view).toMatchObject({ showTabs: true, hideMenu: false });
  });

  it("follows show-chart-tabs and hide-chart-menu", async () => {
    const out = await compile(
      `charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] show-chart-tabs true hide-chart-menu true {}`,
    );
    expect(out.view).toMatchObject({ showTabs: true, hideMenu: true });
  });
});

describe("empty data", () => {
  it("is empty only when every plot has nothing to draw", async () => {
    const empty = await compile(one("plot kind BAR values [null null] {}"));
    expect(empty.charts[0].view.empty).toBe(true);
    const partly = await compile(one("plot kind BAR values [null null] {} plot kind LINE values [null 2] {}"));
    expect(partly.charts[0].view.empty).toBe(false);
  });

  it("treats a dataset with no rows as empty, not as an error", async () => {
    const out = await compile(
      `charts [ datasets [ dataset columns ["v"] rows [] {} ] {} chart [ plots [ plot kind BAR values "v" {} ] {} ] {} ] {}`,
    );
    expect(out.charts[0].view.empty).toBe(true);
  });
});

describe("accessibility", () => {
  it("enables aria with the author's description, or a generated summary", async () => {
    const given = await compile(one("plot kind BAR values [1] {}", "", 'description "Sales by quarter."'));
    expect(given.charts[0].option.aria).toEqual({ enabled: true, label: { enabled: true, description: "Sales by quarter." } });
    const made = await compile(one('plot kind BAR name "Sales" values [1] {}', "", 'title "Q1"'));
    expect(made.charts[0].view.description).toBe('Q1: bar plot "Sales".');
  });
});

describe("L0000 still works inside a program", () => {
  it("allows let bindings, set-var and expressions", async () => {
    const out = await compile(`let k = 7.. set-var "n" 3 ${one('plot kind BAR values [1 k get-var "n"] {}')}`);
    expect(out.charts[0].option.series[0].data).toEqual([1, 7, 3]);
  });
});
