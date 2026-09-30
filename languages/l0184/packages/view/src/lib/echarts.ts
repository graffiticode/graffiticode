// SPDX-License-Identifier: MIT
/**
 * ECharts, tree-shaken to what L0184 releases. Registering a chart or component here is the
 * second half of adding a plot kind — the compiler may emit only what is registered.
 */
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { AriaComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  AriaComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
  SVGRenderer,
]);

export { echarts };
