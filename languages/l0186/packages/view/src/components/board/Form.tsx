// SPDX-License-Identifier: MIT
/**
 * L0186's Form: a compiled board, drawn as FigJam draws it, or the compile errors that stopped it.
 *
 * The preview is the whole view — there is no embedded FigJam frame. A board with two or more
 * pages gets a tab per page (and a page menu when the program asks for one); a one-page board
 * shows neither. Pages are drawn when first selected and kept, hidden, so a page the reader
 * panned or zoomed is still that way when they come back. Selection is kept by page name across
 * recompiles, falling back to the first page when the name is gone.
 */
import "../../index.css";
import { useEffect, useId, useMemo, useState } from "react";
import type { CompileError, FormProps } from "@graffiticode/l0000-view";
import { BoardPreview } from "./BoardPreview";
import { PageChrome, panelId, tabId } from "./PageChrome";

export interface BoardPage {
  name: string;
  background?: string;
  nodes: any[];
}

export interface BoardData {
  type: "board";
  title?: string;
  showPageTabs: boolean;
  showPageMenu: boolean;
  pages: BoardPage[];
  fileKey?: string;
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

/** A DOM-safe id per page, by position; selection itself is by name. */
const pageKey = (i: number) => `p${i}`;

export const Board = ({ data }: { data: BoardData }) => {
  const base = `l0186-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const names = useMemo(() => data.pages.map((p) => p.name), [data.pages]);
  const [active, setActive] = useState(names[0]);
  const [visited, setVisited] = useState<Set<string>>(() => new Set([names[0]]));

  useEffect(() => {
    if (!names.includes(active)) setActive(names[0]);
    setVisited((v) => {
      const next = new Set([...v].filter((n) => names.includes(n)));
      next.add(names.includes(active) ? active : names[0]);
      return next.size === v.size && [...next].every((n) => v.has(n)) ? v : next;
    });
  }, [names, active]);

  const select = (id: string) => {
    const name = names[Number(id.slice(1))];
    setActive(name);
    setVisited((v) => (v.has(name) ? v : new Set([...v, name])));
  };

  const activeIndex = Math.max(0, names.indexOf(active));
  return (
    <div className="l0186-board">
      <div className="flex flex-col gap-2 p-2 text-gray-900">
        {data.title && (
          <header className="px-1">
            <h1 className="text-lg font-semibold">{data.title}</h1>
          </header>
        )}
        {data.pages.map((p, i) => {
          const id = pageKey(i);
          const panelProps = data.showPageTabs
            ? { role: "tabpanel", id: panelId(base, id), "aria-labelledby": tabId(base, id), tabIndex: 0 }
            : { role: "region", id: panelId(base, id), "aria-label": p.name };
          return (
            <section key={`${i}:${p.name}`} {...panelProps} hidden={i !== activeIndex} className="l0186-panel">
              {visited.has(p.name) && <BoardPreview nodes={p.nodes} background={p.background} label={data.pages.length > 1 ? `Page ${p.name}` : data.title} />}
            </section>
          );
        })}
        <PageChrome
          base={base}
          pages={data.pages.map((p, i) => ({ id: pageKey(i), name: p.name }))}
          activeId={pageKey(activeIndex)}
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
  if (errors.length) return <div className="l0186-board p-2">{renderErrors(errors)}</div>;
  if (!data || data.type !== "board" || !Array.isArray(data.pages) || !data.pages.length) return null;
  return <Board data={data} />;
};
