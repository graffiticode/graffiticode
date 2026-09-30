// SPDX-License-Identifier: MIT
/**
 * ECharts, tree-shaken to what L0184 releases. Registering a chart or component here is the
 * second half of adding a plot kind — the compiler may emit only what is registered.
 */
import * as echarts from "echarts/core";
import {
  BarChart,
  BoxplotChart,
  CandlestickChart,
  FunnelChart,
  GaugeChart,
  HeatmapChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
} from "echarts/charts";
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  RadarComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapContinuousComponent,
} from "echarts/components";
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";

let registered = false;

/**
 * ECharts with L0184's charts, components and renderers registered. Registration is an explicit
 * call on the path that creates a chart, not a module side effect: the package declares only its
 * CSS as side-effectful, so a bundler drops a top-level `echarts.use(…)`, and every chart then
 * fails with no renderer ("… is not a constructor").
 */
export function getECharts(): typeof echarts {
  if (registered) return echarts;
  registered = true;
  echarts.use([
    BarChart,
    BoxplotChart,
    CandlestickChart,
    FunnelChart,
    GaugeChart,
    HeatmapChart,
    LineChart,
    PieChart,
    RadarChart,
    ScatterChart,
    AriaComponent,
    GridComponent,
    LegendComponent,
    RadarComponent,
    TitleComponent,
    TooltipComponent,
    VisualMapContinuousComponent,
    CanvasRenderer,
    SVGRenderer,
  ]);
  return echarts;
}

export type ECharts = typeof echarts;
