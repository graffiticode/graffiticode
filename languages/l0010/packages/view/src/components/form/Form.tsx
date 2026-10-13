// SPDX-License-Identifier: MIT
// L0010's Form: renders the composition plan ({ langs }) as an ordered pipeline,
// or compile errors. Injected into the shared View (from @graffiticode/l0000-view),
// which supplies `state.data`, `state.errors`, and `state.apply`.
import "../../index.css";
import type { FormProps, CompileError } from "@graffiticode/l0000-view";

function classNames(...classes: any[]) {
  return classes.filter(Boolean).join(" ");
}

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

function renderPlan(data: any) {
  const langs = Array.isArray(data?.langs) ? data.langs : null;
  if (!langs) {
    return <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>;
  }
  if (langs.length === 0) {
    return <span className="text-sm">No composition (empty plan).</span>;
  }
  return (
    <ol className="text-sm flex flex-col gap-1">
      {langs.map((id: string, i: number) => (
        <li key={i}>
          {i === 0 ? "head" : "↳ consumes"} <span className="font-bold">L{id}</span>
        </li>
      ))}
    </ol>
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
      {errors.length > 0 ? renderErrors(errors) : renderPlan(state.data)}
    </div>
  );
};
