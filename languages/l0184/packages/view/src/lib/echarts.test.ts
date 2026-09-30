// SPDX-License-Identifier: MIT
// The compiler may emit only what the view registers; accessibility support must be among it.
import { describe, expect, it, vi } from "vitest";

const CHARTS = ["BarChart", "BoxplotChart", "CandlestickChart", "FunnelChart", "GaugeChart", "HeatmapChart", "LineChart", "PieChart", "RadarChart", "ScatterChart"];
const COMPONENTS = [
  "AriaComponent",
  "GridComponent",
  "LegendComponent",
  "RadarComponent",
  "TitleComponent",
  "TooltipComponent",
  "VisualMapContinuousComponent",
];
const used: any[] = [];
const self = (names: string[]) => Object.fromEntries(names.map((n) => [n, n]));
vi.mock("echarts/core", () => ({ use: (mods: any[]) => used.push(...mods) }));
vi.mock("echarts/charts", () => self(CHARTS));
vi.mock("echarts/components", () => self(COMPONENTS));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: "CanvasRenderer", SVGRenderer: "SVGRenderer" }));

describe("echarts registrations", () => {
  it("registers every plot kind's chart, their components, Aria and both renderers", async () => {
    await import("./echarts");
    expect(used.sort()).toEqual([...CHARTS, ...COMPONENTS, "CanvasRenderer", "SVGRenderer"].sort());
  });
});
