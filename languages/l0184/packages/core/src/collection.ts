// SPDX-License-Identifier: MIT
/**
 * The collection: every program is one `charts [ … ] settings {}`, even with a single chart —
 * one canonical shape, mirroring L0179's `sheets [ sheet … ]`.
 *
 * Navigation follows L0179's sheets: charts keep source order; ids default to c1, c2, …; names
 * default to ids; the first chart is selected; the chart menu shows even for one chart; tabs
 * show once there are two or more; `show-chart-tabs` and `hide-chart-menu` override those, and
 * turning both off with several charts is an error, because no chart but the first could then
 * be reached.
 *
 * The envelope always carries `type`, `charts` and a complete `view`. The shared View merges a
 * compile's top-level keys into its model, so replacing these whole objects on every compile is
 * what keeps a setting removed from the source from lingering on screen.
 */
import { resolveColor, resolveColors } from "./colors.js";
import { buildChart, type ChartParts, type CompiledChart } from "./chart.js";
import { scopeDatasets } from "./data.js";

export interface Envelope {
  type: "charts";
  charts: CompiledChart[];
  view: {
    theme: "light" | "dark";
    renderer: "canvas";
    locale: "EN";
    showTabs: boolean;
    hideMenu: boolean;
    title?: string;
    instructions?: string;
    background?: string;
  };
}

const q = (s: string) => JSON.stringify(s);

export function buildCollection(
  items: { datasets?: { items: any[] }; charts: { parts: ChartParts; settings: any }[] },
  settings: any,
): Envelope {
  const shared = scopeDatasets(items.datasets?.items ?? [], "charts datasets");
  const palette = settings.palette !== undefined ? resolveColors(settings.palette, "charts palette") : undefined;
  const background = settings.background !== undefined ? resolveColor(settings.background, "charts background") : undefined;

  const ids = items.charts.map((c, i) => c.settings.id ?? `c${i + 1}`);
  ids.forEach((id, i) => {
    const j = ids.indexOf(id);
    if (j !== i) {
      throw new Error(`charts: charts ${j + 1} and ${i + 1} both have the id ${q(id)}. Ids pick a chart's tab, so give each chart its own id.`);
    }
  });

  const n = items.charts.length;
  const showTabs = settings.showChartTabs ?? n >= 2;
  const hideMenu = settings.hideChartMenu ?? false;
  if (n > 1 && !showTabs && hideMenu) {
    throw new Error(
      "charts: `show-chart-tabs false` with `hide-chart-menu true` leaves no way to reach any chart but the first. Keep the tabs or the menu.",
    );
  }

  const charts = items.charts.map((c, i) => {
    const id = ids[i];
    const name = c.settings.name ?? id;
    return buildChart(c, id, name, `chart ${q(id)}`, shared, { palette, background });
  });

  return {
    type: "charts",
    charts,
    view: {
      theme: settings.theme === "DARK" ? "dark" : "light",
      renderer: "canvas",
      locale: "EN",
      showTabs,
      hideMenu,
      ...(settings.title !== undefined ? { title: settings.title } : {}),
      ...(settings.instructions !== undefined ? { instructions: settings.instructions } : {}),
      ...(background ? { background } : {}),
    },
  };
}
