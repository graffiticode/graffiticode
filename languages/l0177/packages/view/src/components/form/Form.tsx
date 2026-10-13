// SPDX-License-Identifier: MIT
// L0177's Form renders the compiled DESIGN, not an assessment.
//
// L0177 is an oracle: `compile` returns a normalized Author API integration design plus
// steering warnings, and the developer-facing recipe comes separately from `get_spec`.
// So there is nothing here to mount a Learnosity SDK into — the useful thing to show is
// the state of the design itself: which authoring view it targets, what is still
// missing, and which exact Learnosity config path every option resolves to.
//
// That last part is the point. Kebab names are deliberately ambiguous about nesting
// (`title-show` is `title.show`, `enable-selection` is `enable_selection`), and the same
// name means different paths in different views, so the compiler resolves them and this
// surfaces the answer rather than leaving anyone to infer it.
import "../../index.css";
import type { ReactNode } from "react";
import type { FormProps, CompileError } from "@graffiticode/l0000-view";

const MODE_LABELS: Record<string, string> = {
  item_edit: "Item editor",
  item_list: "Item browser",
  activity_edit: "Activity editor",
  activity_list: "Activity browser",
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
    return JSON.stringify(v); // tag records, item banks
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

// One option: its design name, its value, and the Learnosity path it resolves to.
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
    return <div className="p-4 font-mono text-xs text-zinc-500">No design yet.</div>;
  }

  const mode = typeof data.mode === "string" ? data.mode : undefined;
  const warnings: string[] = Array.isArray(data.warnings) ? data.warnings : [];
  const paths: Record<string, string> = isRecord(data.paths)
    ? (data.paths as Record<string, string>)
    : {};
  const complete = data.complete === true;
  const user = isRecord(data.user) ? data.user : {};

  // config holds member records ({ item: {...} }) alongside view-level scalars.
  const config = isRecord(data.config) ? data.config : {};
  const members = Object.entries(config).filter(([, v]) => isRecord(v));
  const viewLevel = Object.entries(config).filter(([, v]) => !isRecord(v));

  const sections = (["container", "widget_templates", "global"] as const)
    .map((k) => [k, data[k]] as const)
    .filter(([, v]) => isRecord(v) && Object.keys(v).length > 0);

  const request: Array<[string, unknown]> = [
    ["domain", data.domain],
    ["user.id", user.id],
    ["user.email", user.email],
    ["user.firstname", user.firstname],
    ["user.lastname", user.lastname],
    ["reference", data.reference],
    ["organisation_id", data.organisation_id],
  ].filter(([, v]) => v !== undefined) as Array<[string, unknown]>;

  const widgets = Array.isArray(data.allow_widgets) ? data.allow_widgets : undefined;

  return (
    <div className="p-4 font-mono text-xs text-zinc-900">
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-200 pb-3">
        <div>
          <div className="text-sm text-zinc-900">
            {mode ? (MODE_LABELS[mode] ?? mode) : "No authoring view chosen"}
          </div>
          {mode && <div className="text-[11px] text-zinc-400">mode: {mode}</div>}
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
              Design holes come first. Fill them and the remaining advice surfaces.
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

      {request.length > 0 && (
        <Section title="Request">
          {request.map(([k, v]) => (
            <Row key={k} name={k} value={v} />
          ))}
        </Section>
      )}

      {widgets && (
        <Section title="Allowed question types">
          <div className="break-all text-zinc-900">{widgets.join(", ") || "—"}</div>
          {/* The dialect's central caveat: this restriction has no confirmed config
              binding, so the UI must not imply the editor will enforce it. */}
          <p className="mt-1 text-[11px] text-zinc-500">
            Design intent. The Learnosity config binding for restricting question types is
            unconfirmed — verify it in the running editor before relying on it.
          </p>
        </Section>
      )}

      {(members.length > 0 || viewLevel.length > 0) && (
        <Section title="Configuration">
          {viewLevel.map(([k, v]) => (
            <Row key={k} name={k} value={v} path={paths[`config.${k}`]} />
          ))}
          {members.map(([member, fields]) => (
            <div key={member} className="mt-3 first:mt-0">
              <div className="mb-0.5 text-zinc-500">{member}</div>
              <div className="pl-3">
                {Object.entries(fields as Record<string, unknown>).map(([k, v]) => (
                  <Row key={k} name={k} value={v} path={paths[`config.${member}.${k}`]} />
                ))}
              </div>
            </div>
          ))}
        </Section>
      )}

      {sections.map(([name, fields]) => (
        <Section key={name} title={name.replace(/_/g, " ")}>
          {Object.entries(fields as Record<string, unknown>).map(([k, v]) => (
            <Row key={k} name={k} value={v} path={paths[`${name === "widget_templates" ? "widget-templates" : name}.${k}`]} />
          ))}
        </Section>
      ))}
    </div>
  );
};
