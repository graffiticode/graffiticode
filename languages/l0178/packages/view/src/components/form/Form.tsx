// SPDX-License-Identifier: MIT
// L0178's Form renders the compiled JOB, not a result set.
//
// L0178 is an oracle: `compile` returns a normalized Data API job plus steering
// warnings, and the developer-facing recipe comes separately from `get_spec`. Nothing
// here calls Learnosity, so there are no records to show — the useful thing to display
// is the state of the job itself: which operation it targets, what is still missing,
// how far it reads, and which exact Learnosity path every request field resolves to.
//
// Two things get more room than their size suggests.
//
// The PATHS, because kebab names are deliberately ambiguous about nesting
// (`include-items` is `include.items`, `item-pool-id` is `item_pool_id`,
// `include-session-metadata` is `include.sessions.session_metadata`) and the same name
// resolves differently per block. The compiler settles it; this surfaces the answer
// rather than leaving anyone to infer it.
//
// The PAGING CONTRACT, because it is what this dialect exists for and it is not the
// same across endpoints. `meta.next` disappears at exhaustion on itembank/*, but on
// sessions/* it is always present and an empty page is the end signal — so a loop
// written for one family is a bug in the other. Showing the declared policy without
// the end signal would be showing half of it.
import "../../index.css";
import type { ReactNode } from "react";
import type { FormProps, CompileError } from "@graffiticode/l0000-view";

const OPERATION_LABELS: Record<string, string> = {
  "itembank/items": "Read Items from an Item bank",
  "sessions/responses": "Read session responses",
};

// What each end-of-data signal means, in the reader's terms. The wrong one is not a
// style choice: one silently drops records, the other never terminates.
const PAGING_END: Record<string, { label: string; note: string }> = {
  "next-absent": {
    label: "meta.next is absent",
    note: "Loop until meta.next is missing. Never stop on a short page — an over-limit `limit` is silently clamped, so pages can look short while records remain.",
  },
  "empty-page": {
    label: "the page comes back empty",
    note: "Loop until a page has zero records. meta.next is ALWAYS present here — it is a long-poll resumption cursor, not a more-data flag — so waiting for it to disappear never finishes.",
  },
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function formatValue(v: unknown): string {
  if (v === undefined) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "string")) return v.join(", ");
    return JSON.stringify(v); // tag records
  }
  return JSON.stringify(v);
}

function renderErrors(errors: CompileError[]) {
  return (
    <div className="flex flex-col gap-2 p-4 font-mono text-xs">
      {errors.map((error, i) => (
        <div key={i} className="rounded-md border border-red-200 bg-red-50 p-3 text-red-800">
          {error.message}
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="mb-1.5 text-[11px] uppercase tracking-wide text-zinc-500">{title}</h2>
      {children}
    </section>
  );
}

// One request field: its design name, its value, and the Learnosity path it resolves to.
function Row({ name, value, path }: { name: string; value: unknown; path?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 border-b border-zinc-100 py-1 last:border-b-0">
      <span className="w-56 shrink-0 text-zinc-700">{name}</span>
      <span className="min-w-0 grow break-all text-zinc-900">{formatValue(value)}</span>
      {path && <span className="shrink-0 text-[11px] text-zinc-400">{path}</span>}
    </div>
  );
}

export const Form = ({ state }: FormProps) => {
  const errors: CompileError[] = state.errors ?? [];
  if (errors.length > 0) return renderErrors(errors);

  const data = state.data;
  if (!isRecord(data)) {
    return <div className="p-4 font-mono text-xs text-zinc-500">No job yet.</div>;
  }

  const endpoint = typeof data.endpoint === "string" ? data.endpoint : undefined;
  const action = typeof data.action === "string" ? data.action : undefined;
  const warnings: string[] = Array.isArray(data.warnings) ? data.warnings : [];
  const paths: Record<string, string> = isRecord(data.paths)
    ? (data.paths as Record<string, string>)
    : {};
  const complete = data.complete === true;
  const request = isRecord(data.request) ? data.request : {};

  const paged = data.paged === true;
  const isAsync = data.async === true;
  const paging = typeof data.paging === "string" ? data.paging : undefined;
  const pagingEnd = typeof data.paging_end === "string" ? data.paging_end : undefined;
  const endSignal = pagingEnd ? PAGING_END[pagingEnd] : undefined;

  return (
    <div className="p-4 font-mono text-xs text-zinc-900">
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-200 pb-3">
        <div>
          <div className="text-sm text-zinc-900">
            {endpoint ? (OPERATION_LABELS[endpoint] ?? endpoint) : "No operation chosen"}
          </div>
          {endpoint && (
            <div className="text-[11px] text-zinc-400">
              POST {endpoint} · action {action}
            </div>
          )}
        </div>
        <span
          className={
            complete
              ? "rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700"
              : "rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800"
          }
        >
          {complete ? "complete" : "incomplete"}
        </span>
      </header>

      {warnings.length > 0 && (
        <Section title={complete ? `Advisories (${warnings.length})` : `To fix (${warnings.length})`}>
          {!complete && (
            <p className="mb-1.5 text-[11px] text-zinc-500">
              Job holes come first. Fill them and the remaining advice surfaces.
            </p>
          )}
          <ul className="flex flex-col gap-1.5">
            {warnings.map((w, i) => (
              <li key={i} className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900">
                {w}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {paged && (
        <Section title="Paging">
          <Row name="policy" value={paging ?? "not declared"} />
          {endSignal && <Row name="loop ends when" value={endSignal.label} />}
          {endSignal && <p className="mt-1 text-[11px] text-zinc-500">{endSignal.note}</p>}
          {/* Design intent, not a request field — it must never look like something that
              gets sent, and meta.records is the number readers most often misread. */}
          <p className="mt-1 text-[11px] text-zinc-500">
            The policy is design intent and is never sent in the request. Whichever you
            choose, meta.records counts the page you got — not the total that matched.
          </p>
        </Section>
      )}

      {isAsync && (
        <Section title="Asynchronous">
          <p className="text-[11px] text-zinc-500">
            This operation returns a job_reference instead of a result. Poll the jobs
            endpoint with that reference; there is no paging loop.
          </p>
        </Section>
      )}

      {Object.keys(request).length > 0 && (
        <Section title="Request">
          {Object.entries(request).map(([k, v]) => (
            <Row key={k} name={k} value={v} path={paths[k]} />
          ))}
        </Section>
      )}
    </div>
  );
};
