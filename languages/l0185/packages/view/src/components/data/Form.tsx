// SPDX-License-Identifier: MIT
/**
 * L0185's Form: shows the data a program produced, and nothing else. A list of flat records is a
 * table; anything else — nested records, a single record, a scalar — is a collapsible JSON tree.
 * Compile errors render as alerts. The view never adds to the data: no title, no formatting the
 * program did not ask for.
 */
import React, { useMemo, useState } from "react";
import type { CompileError, FormProps } from "@graffiticode/l0000-view";
import "../../index.css";

const PAGE = 200;

const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
const isFlatRecord = (v: unknown) =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every(isScalar);

/** A list of flat records is a table; everything else is a tree. */
export const isTable = (data: unknown): data is Record<string, unknown>[] =>
  Array.isArray(data) && data.length > 0 && data.every(isFlatRecord);

export const columnsOf = (rows: Record<string, unknown>[]): string[] => {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
};

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: Record<string, unknown>[]): string => {
  const cols = columnsOf(rows);
  return [cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
};

const copy = (text: string) => {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable: nothing to do */
  }
};

const button =
  "rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800";

export const DataTable = ({ rows }: { rows: Record<string, unknown>[] }) => {
  const [shown, setShown] = useState(PAGE);
  const cols = useMemo(() => columnsOf(rows), [rows]);
  const numeric = useMemo(
    () => new Set(cols.filter((c) => rows.every((r) => r[c] === null || r[c] === undefined || typeof r[c] === "number"))),
    [cols, rows],
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-[32rem] overflow-auto rounded border border-gray-200 dark:border-gray-700">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800">
            <tr>
              {cols.map((c) => (
                <th key={c} scope="col" className={`whitespace-nowrap border-b border-gray-200 px-3 py-1.5 font-medium text-gray-700 dark:border-gray-700 dark:text-gray-200 ${numeric.has(c) ? "text-right" : "text-left"}`}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((r, i) => (
              <tr key={i} className="odd:bg-white even:bg-gray-50 dark:odd:bg-gray-900 dark:even:bg-gray-950">
                {cols.map((c) => (
                  <td key={c} className={`whitespace-nowrap px-3 py-1 text-gray-900 dark:text-gray-100 ${numeric.has(c) ? "text-right tabular-nums" : ""}`}>
                    {r[c] === null || r[c] === undefined ? <span className="text-gray-400">—</span> : String(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span>
          {rows.length} {rows.length === 1 ? "record" : "records"} · {cols.length} {cols.length === 1 ? "field" : "fields"}
        </span>
        {shown < rows.length && (
          <button type="button" className={button} onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, rows.length - shown)} more
          </button>
        )}
        <button type="button" className={button} onClick={() => copy(toCsv(rows))}>
          Copy CSV
        </button>
        <button type="button" className={button} onClick={() => copy(JSON.stringify(rows, null, 2))}>
          Copy JSON
        </button>
      </div>
    </div>
  );
};

const Leaf = ({ v }: { v: unknown }) => (
  <span className={typeof v === "string" ? "text-emerald-700 dark:text-emerald-400" : typeof v === "number" ? "text-blue-700 dark:text-blue-400" : "text-gray-500"}>
    {JSON.stringify(v)}
  </span>
);

const Node = ({ name, v, depth }: { name?: string; v: unknown; depth: number }) => {
  const [open, setOpen] = useState(depth < 2);
  const label = name !== undefined ? <span className="text-gray-700 dark:text-gray-300">{name}: </span> : null;
  if (isScalar(v)) {
    return (
      <div className="pl-4">
        {label}
        <Leaf v={v} />
      </div>
    );
  }
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as object);
  const summary = Array.isArray(v) ? `[${v.length}]` : `{${entries.length}}`;
  return (
    <div className="pl-4">
      <button type="button" aria-expanded={open} className="text-left hover:underline" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {label}
        <span className="text-gray-500">{summary}</span>
      </button>
      {open && entries.map(([k, x]) => <Node key={k} name={k} v={x} depth={depth + 1} />)}
    </div>
  );
};

export const JsonTree = ({ data }: { data: unknown }) => (
  <div className="flex flex-col gap-2">
    <div className="max-h-[32rem] overflow-auto rounded border border-gray-200 p-2 font-mono text-xs dark:border-gray-700">
      <Node v={data} depth={0} />
    </div>
    <div className="flex gap-2 text-xs">
      <button type="button" className={button} onClick={() => copy(JSON.stringify(data, null, 2))}>
        Copy JSON
      </button>
    </div>
  </div>
);

const renderErrors = (errors: CompileError[]) => (
  <div className="flex flex-col gap-2" role="alert">
    {errors.map((error, i) => (
      <div key={i} className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
        {String((error as any)?.message ?? error)}
      </div>
    ))}
  </div>
);

/** The data a program produced: a table, a tree, or the errors that stopped it. */
export const Data = ({ data }: { data: unknown }) => {
  if (data === undefined) return null;
  if (Array.isArray(data) && data.length === 0) return <p className="text-sm text-gray-500">No records.</p>;
  return isTable(data) ? <DataTable rows={data} /> : <JsonTree data={data} />;
};

export const Form = ({ state }: FormProps) => {
  const { data, errors } = state;
  return <div className="l0185-data p-2 text-gray-900 dark:text-gray-100">{errors && errors.length ? renderErrors(errors) : <Data data={data} />}</div>;
};
