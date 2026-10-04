// SPDX-License-Identifier: MIT
/**
 * L0184 over L0185: a dataset whose rows come from `data use "0185"`. The upstream's output is
 * passed as the compile's data, exactly as the platform passes it, so it reaches the dataset
 * through L0000's real DATA (an integer-keyed record) and not through a shortcut.
 *
 * UPSTREAM is what L0185 compiles `sort-by ["revenue" DESC] summarize {orders: COUNT revenue:
 * [SUM "amount"]} group-by ["region"] where ["status" EQUALS "paid"] fetch ".../sales.csv" {}`
 * to: a list of flat records, more fields than the chart draws.
 */
import { describe, expect, it } from "vitest";
import { compile, errorOf } from "./harness.js";

const UPSTREAM = [
  { region: "West", orders: 3, revenue: 360.5 },
  { region: "North", orders: 2, revenue: 175.25 },
  { region: "South", orders: 1, revenue: 60 },
];

const program = (columns: string) => `charts [
  datasets [ dataset id "sales" ${columns} rows data use "0185" {} ] {}
  chart [
    axes [ axis direction X categories "region" {} axis direction Y {} ] {}
    plots [ plot kind BAR values "revenue" {} ] {}
  ] title "Revenue by region" {}
] {}`;

describe("rows data use \"0185\"", () => {
  it("draws the upstream's records, ignoring fields the chart does not name", async () => {
    const out = await compile(program('columns ["region" "revenue"]'), UPSTREAM);
    const option = out.charts[0].option;
    expect(option.xAxis[0].data).toEqual(["West", "North", "South"]);
    expect(option.series[0].data).toEqual([360.5, 175.25, 60]);
    expect(out.charts[0].view.empty).toBe(false);
  });

  it("takes the columns from the records when none are named", async () => {
    const out = await compile(program(""), UPSTREAM);
    expect(out.charts[0].option.series[0].data).toEqual([360.5, 175.25, 60]);
  });

  it("is an empty chart, not an error, before an upstream is bound", async () => {
    const out = await compile(program('columns ["region" "revenue"]'), {});
    expect(out.charts[0].view.empty).toBe(true);
  });

  it("asks for columns when there is no upstream and none are named", async () => {
    expect(await errorOf(program(""), {})).toBe(
      'charts datasets dataset "sales": its rows come from an upstream program and there are none yet, so name its columns: columns ["region" "revenue"] rows data use "0185".',
    );
  });

  it("names the upstream's fields when a column is not one of them", async () => {
    expect(await errorOf(program('columns ["region" "total"]').replace('values "revenue"', 'values "total"'), UPSTREAM)).toBe(
      'charts datasets dataset "sales": the data from the upstream program has no field "total"; its fields are "region", "orders", "revenue". Name those in columns.',
    );
  });

  it("still refuses an extra field in rows written in the program", async () => {
    expect(await errorOf('charts [ chart [ datasets [ dataset columns ["a"] rows [{a: 1 b: 2}] {} ] {} plots [ plot kind PIE values "a" {} ] {} ] {} ] {}')).toMatch(
      /rows have the column "b", which is not in columns/,
    );
  });
});
