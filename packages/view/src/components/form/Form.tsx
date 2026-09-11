// SPDX-License-Identifier: MIT
// L0014's Form: renders a rule set's corpus results — each case's source, expected and actual
// translation, and whether it passed — or the compile errors. Injected into the shared View
// (from @graffiticode/l0000-view), which supplies `state.data` ({ options, tests }) and
// `state.errors`. Read-only: it reports on a compile and never calls `state.apply`.
//
// Translations are shown as TEXT, never typeset. An author is checking exact strings — a
// dropped backslash or a changed space is the defect — and rendered math would hide both.
import "../../index.css";
import type { FormProps, CompileError } from "@graffiticode/l0000-view";
import { summarize, type CaseResult, type CaseStatus } from "../../results";

function classNames(...classes: any[]) {
  return classes.filter(Boolean).join(" ");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const count = (rec: unknown) => (rec && typeof rec === "object" ? Object.keys(rec).length : 0);

const STATUS: Record<CaseStatus, { label: string; badge: string; row: string }> = {
  pass: { label: "pass", badge: "bg-green-100 text-green-800", row: "" },
  fail: { label: "fail", badge: "bg-red-100 text-red-800", row: "bg-red-50" },
  captured: { label: "captured", badge: "bg-zinc-100 text-zinc-600", row: "" },
};

function renderErrors(errors: CompileError[]) {
  return (
    <div className="flex flex-col gap-2">
      {errors.map((error, i) => (
        <div
          key={i}
          className="rounded-md p-3 border text-sm bg-red-50 border-red-200 text-red-800"
        >
          {error.message}
        </div>
      ))}
    </div>
  );
}

// An empty translation is what a rule set that throws produces, so it must be visible.
function Text({ value, className }: { value: string; className?: string }) {
  if (value === "") {
    return <span className="italic text-zinc-400">(empty)</span>;
  }
  return <code className={classNames("whitespace-pre-wrap break-all", className)}>{value}</code>;
}

function renderCase(c: CaseResult, i: number) {
  const s = STATUS[c.status];
  return (
    <tr key={i} className={classNames("border-t border-zinc-200 align-top", s.row)}>
      <td className="py-2 pr-3">
        <span className={classNames("rounded px-1.5 py-0.5 text-xs font-sans", s.badge)}>
          {s.label}
        </span>
      </td>
      <td className="py-2 pr-3">
        <Text value={c.source} />
      </td>
      <td className="py-2 pr-3">
        {c.status === "captured" ? <span className="text-zinc-400">—</span> : <Text value={c.expected} />}
      </td>
      <td className="py-2">
        <Text value={c.actual} className={c.status === "fail" ? "text-red-800" : undefined} />
      </td>
    </tr>
  );
}

function renderResults(data: any) {
  const options = data?.options;
  const summary = summarize(data?.tests);
  const tally = `${summary.pass} passed · ${summary.fail} failed · ${summary.captured} captured`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 font-sans">
        {options && (
          <span className="text-sm text-zinc-600">
            {[
              plural(count(options.words), "word"),
              plural(count(options.types), "type"),
              plural(count(options.rules), "rule"),
            ].join(" · ")}
          </span>
        )}
        {summary.cases.length > 0 && <span className="text-sm font-semibold">{tally}</span>}
      </div>

      {summary.cases.length === 0 ? (
        <p className="m-0 text-sm font-sans text-zinc-600">
          No tests. Add <code>{'tests [["source", "expected"]]'}</code> to score this rule set.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm text-left">
            <thead>
              <tr className="font-sans text-xs uppercase tracking-wide text-zinc-500">
                <th className="pb-2 pr-3 font-medium">Status</th>
                <th className="pb-2 pr-3 font-medium">Source</th>
                <th className="pb-2 pr-3 font-medium">Expected</th>
                <th className="pb-2 font-medium">Actual</th>
              </tr>
            </thead>
            <tbody>{summary.cases.map(renderCase)}</tbody>
          </table>
        </div>
      )}

      {options && (
        <details className="text-xs">
          <summary className="cursor-pointer font-sans text-zinc-600">Compiled rule set</summary>
          <pre className="mt-2 overflow-x-auto">{JSON.stringify(options, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

export const Form = ({ state }: FormProps) => {
  const errors: CompileError[] = state.errors ?? [];
  return (
    <div
      className={classNames(
        "bg-white text-zinc-900",
        "rounded-md font-mono flex flex-col gap-4 p-4",
      )}
    >
      {errors.length > 0 ? renderErrors(errors) : renderResults(state.data)}
    </div>
  );
};
