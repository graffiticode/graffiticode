// SPDX-License-Identifier: MIT
// The compiler may emit only what the view registers; accessibility support must be among it.
import { describe, expect, it, vi } from "vitest";

const used: any[] = [];
vi.mock("echarts/core", () => ({ use: (mods: any[]) => used.push(...mods) }));
vi.mock("echarts/charts", () => ({ BarChart: "BarChart", LineChart: "LineChart", PieChart: "PieChart", ScatterChart: "ScatterChart" }));
vi.mock("echarts/components", () => ({
  AriaComponent: "AriaComponent",
  GridComponent: "GridComponent",
  LegendComponent: "LegendComponent",
  TitleComponent: "TitleComponent",
  TooltipComponent: "TooltipComponent",
}));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: "CanvasRenderer", SVGRenderer: "SVGRenderer" }));

describe("echarts registrations", () => {
  it("registers the four plot kinds, their components, Aria and both renderers", async () => {
    await import("./echarts");
    expect(used.sort()).toEqual(
      [
        "AriaComponent",
        "BarChart",
        "CanvasRenderer",
        "GridComponent",
        "LegendComponent",
        "LineChart",
        "PieChart",
        "SVGRenderer",
        "ScatterChart",
        "TitleComponent",
        "TooltipComponent",
      ].sort(),
    );
  });
});
