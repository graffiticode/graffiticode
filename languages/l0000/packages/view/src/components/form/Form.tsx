// SPDX-License-Identifier: MIT
//
// L0000's base Form: renders compile errors when present, otherwise the compiled data
// model as stringified JSON. This is the trivial default rendering; child languages
// supply their own Form and inject it into the shared View instead.
import "../../index.css";
import type { FormProps, CompileError } from "../../view";

function ErrorList({ errors }: { errors: CompileError[] }) {
  return (
    <div className="flex flex-col gap-2 font-mono text-xs">
      {errors.map((error, i) => (
        <div
          key={i}
          className="rounded-md border border-red-200 bg-red-50 p-3 text-red-800"
        >
          {error.message}
          {typeof error.from === "number" && error.from >= 0 && (
            <span className="ml-2 text-red-400">
              [{error.from}
              {typeof error.to === "number" && error.to >= 0 ? `–${error.to}` : ""}]
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export const Form = ({ state }: FormProps) => {
  const errors = state.errors ?? [];
  if (errors.length > 0) {
    return <ErrorList errors={errors} />;
  }
  const source = state.data;
  return (
    <pre className="rounded-md bg-zinc-50 text-zinc-900 text-xs font-mono p-4 overflow-auto">
      {JSON.stringify(source, null, 2)}
    </pre>
  );
};
