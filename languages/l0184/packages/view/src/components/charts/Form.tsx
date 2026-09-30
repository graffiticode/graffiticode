// SPDX-License-Identifier: MIT
/**
 * L0184's Form: a compiled charts collection, or the compile errors that stopped it.
 *
 * Charts are mounted when first selected and kept mounted, hidden, when another tab is chosen,
 * so a chart the reader zoomed or filtered is still that way when they come back. Selection is
 * kept by chart id across recompiles, falling back to the first chart when the id is gone.
 */
import "../../index.css";
import { useEffect, useId, useMemo, useState } from "react";
import type { CompileError, FormProps } from "@graffiticode/l0000-view";
import { ChartChrome, panelId, tabId } from "./ChartChrome";
import { EChart } from "./EChart";

export interface CompiledChart {
  id: string;
  name: string;
  option: Record<string, any>;
  view: { width: number | string; height: number; empty: boolean; description: string; formats?: Record<string, any> };
}

export interface ChartsData {
  type: "charts";
  charts: CompiledChart[];
  view: {
    theme: "light" | "dark";
    renderer: "canvas" | "svg";
    locale: string;
    showTabs: boolean;
    hideMenu: boolean;
    title?: string;
    instructions?: string;
    background?: string;
  };
}

const renderErrors = (errors: CompileError[]) => (
  <div className="flex flex-col gap-2" role="alert">
    {errors.map((error, i) => (
      <div
        key={i}
        className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
      >
        {error.message}
      </div>
    ))}
  </div>
);

export const Charts = ({ data }: { data: ChartsData }) => {
  const base = `l0184-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ids = useMemo(() => data.charts.map((c) => c.id), [data.charts]);
  const [activeId, setActiveId] = useState(ids[0]);
  const [visited, setVisited] = useState<Set<string>>(() => new Set([ids[0]]));

  // Keep the selection by id; fall back to the first chart when it is gone. Forget visits to
  // removed charts, so their instances are disposed.
  useEffect(() => {
    if (!ids.includes(activeId)) setActiveId(ids[0]);
    setVisited((v) => {
      const next = new Set([...v].filter((id) => ids.includes(id)));
      next.add(ids.includes(activeId) ? activeId : ids[0]);
      return next.size === v.size && [...next].every((id) => v.has(id)) ? v : next;
    });
  }, [ids, activeId]);

  const select = (id: string) => {
    setActiveId(id);
    setVisited((v) => (v.has(id) ? v : new Set([...v, id])));
  };

  const { view } = data;
  const dark = view.theme === "dark";
  return (
    <div
      className={`l0184-charts${dark ? " dark bg-gray-950" : " bg-white"}`}
      style={view.background ? { background: view.background } : undefined}
    >
      <div className="flex flex-col gap-2 p-2 text-gray-900 dark:text-gray-100">
        {(view.title || view.instructions) && (
          <header className="flex flex-col gap-1 px-1">
            {view.title && <h1 className="text-lg font-semibold">{view.title}</h1>}
            {view.instructions && <p className="text-sm text-gray-600 dark:text-gray-300">{view.instructions}</p>}
          </header>
        )}
        {data.charts.map((c) => {
          const active = c.id === activeId;
          const panelProps = view.showTabs
            ? { role: "tabpanel", id: panelId(base, c.id), "aria-labelledby": tabId(base, c.id), tabIndex: 0 }
            : { role: "region", id: panelId(base, c.id), "aria-label": c.name };
          return (
            <section key={c.id} {...panelProps} hidden={!active} className="l0184-panel">
              <p className="sr-only">{c.view.description}</p>
              {!visited.has(c.id) ? null : c.view.empty ? (
                <div
                  className="flex items-center justify-center text-sm text-gray-500 dark:text-gray-400"
                  style={{ width: c.view.width, height: c.view.height }}
                >
                  No data
                </div>
              ) : (
                <EChart
                  option={c.option}
                  formats={c.view.formats}
                  width={c.view.width}
                  height={c.view.height}
                  theme={view.theme}
                  renderer={view.renderer}
                  locale={view.locale}
                  active={active}
                />
              )}
            </section>
          );
        })}
        <ChartChrome
          base={base}
          charts={data.charts.map(({ id, name }) => ({ id, name }))}
          activeId={activeId}
          onSelect={select}
          showMenu={!view.hideMenu}
          showTabs={view.showTabs}
        />
      </div>
    </div>
  );
};

export const Form = ({ state }: FormProps) => {
  const errors: CompileError[] = state.errors ?? [];
  const data = state.data as ChartsData | undefined;
  if (errors.length) return <div className="l0184-charts p-2">{renderErrors(errors)}</div>;
  if (!data || data.type !== "charts" || !Array.isArray(data.charts) || !data.charts.length) return null;
  return <Charts data={data} />;
};
