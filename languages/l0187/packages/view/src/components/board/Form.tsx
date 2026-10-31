// SPDX-License-Identifier: MIT
/**
 * L0187's Form: a compiled, positioned board, painted as FigJam paints it, or the compile errors
 * that stopped it.
 *
 * A board with two or more pages gets a tab per page (and a page menu when the program asks for
 * one). Pages are drawn when first selected and kept, hidden, so a page the reader panned or
 * zoomed is still that way when they come back. Selection is kept by page id across recompiles —
 * names may repeat — falling back to the first page when the id is gone.
 */
import "../../index.css";
import { useEffect, useId, useMemo, useState } from "react";
import type { CompileError, FormProps } from "@graffiticode/l0000-view";
import { BoardPreview } from "./BoardPreview";
import { PageChrome, panelId, tabId } from "./PageChrome";

export interface BoardPage {
  id: string;
  name: string;
  background?: string;
  width: number;
  height: number;
  nodes: any[];
  groups: any[];
}

export interface BoardData {
  type: "board";
  positioned: 1;
  profile: string;
  title?: string;
  showPageTabs: boolean;
  showPageMenu: boolean;
  pages: BoardPage[];
  fileKey?: string;
  report?: unknown;
}

const renderErrors = (errors: CompileError[]) => (
  <div className="flex flex-col gap-2" role="alert">
    {errors.map((error, i) => (
      <div key={i} className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        {error.message}
      </div>
    ))}
  </div>
);

export const Board = ({ data }: { data: BoardData }) => {
  const base = `l0187-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ids = useMemo(() => data.pages.map((p) => p.id), [data.pages]);
  const [active, setActive] = useState(ids[0]);
  const [visited, setVisited] = useState<Set<string>>(() => new Set([ids[0]]));

  useEffect(() => {
    if (!ids.includes(active)) setActive(ids[0]);
    setVisited((v) => {
      const next = new Set([...v].filter((n) => ids.includes(n)));
      next.add(ids.includes(active) ? active : ids[0]);
      return next.size === v.size && [...next].every((n) => v.has(n)) ? v : next;
    });
  }, [ids, active]);

  const select = (id: string) => {
    setActive(id);
    setVisited((v) => (v.has(id) ? v : new Set([...v, id])));
  };

  const activeId = ids.includes(active) ? active : ids[0];
  return (
    <div className="l0187-board">
      <div className="flex flex-col gap-2 p-2 text-gray-900">
        {data.title && (
          <header className="px-1">
            <h1 className="text-lg font-semibold">{data.title}</h1>
          </header>
        )}
        {data.pages.map((p) => {
          const panelProps = data.showPageTabs
            ? { role: "tabpanel", id: panelId(base, p.id), "aria-labelledby": tabId(base, p.id), tabIndex: 0 }
            : { role: "region", id: panelId(base, p.id), "aria-label": p.name };
          return (
            <section key={p.id} {...panelProps} hidden={p.id !== activeId} className="l0187-panel">
              {visited.has(p.id) && <BoardPreview page={p} label={data.pages.length > 1 ? `Page ${p.name}` : data.title} />}
            </section>
          );
        })}
        <PageChrome
          base={base}
          pages={data.pages.map((p) => ({ id: p.id, name: p.name }))}
          activeId={activeId}
          onSelect={select}
          showMenu={data.showPageMenu}
          showTabs={data.showPageTabs}
        />
      </div>
    </div>
  );
};

export const Form = ({ state }: FormProps) => {
  const errors: CompileError[] = state.errors ?? [];
  const data = state.data as BoardData | undefined;
  if (errors.length) return <div className="l0187-board p-2">{renderErrors(errors)}</div>;
  if (!data || data.type !== "board" || !Array.isArray(data.pages) || !data.pages.length) return null;
  return <Board data={data} />;
};
