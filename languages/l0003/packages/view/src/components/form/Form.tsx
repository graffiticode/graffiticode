// SPDX-License-Identifier: MIT
// L0003's Form: renders the language's UI primitives (hello / image / theme / print) and
// a theme toggle, or compile errors. Injected into the shared View (from
// @graffiticode/l0000-view), which supplies `state.data`, `state.errors`, and `state.apply`.
import "../../index.css";
import { useState, useEffect } from "react";
import type { FormProps, CompileError } from "@graffiticode/l0000-view";
import { ThemeToggle } from "./ThemeToggle";

function classNames(...classes: any[]) {
  return classes.filter(Boolean).join(" ");
}

function renderErrors(errors: CompileError[], theme: string | undefined) {
  return (
    <div className="flex flex-col gap-2">
      {errors.map((error, i) => (
        <div
          key={i}
          className={classNames(
            "rounded-md p-3 border text-sm",
            theme === "dark"
              ? "bg-red-900/50 border-red-700 text-red-200"
              : "bg-red-50 border-red-200 text-red-800",
          )}
        >
          {error.message}
        </div>
      ))}
    </div>
  );
}

function renderJSON(data: any) {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const { schema, theme, ...rest } = data;
    return <pre className="text-xs">{JSON.stringify(rest, null, 2)}</pre>;
  }
  return <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>;
}

function renderData(data: any) {
  // A themed scalar/list body is wrapped under `value`; named records are merged inline.
  const source = data?.value ?? data;
  if (source?.print !== undefined) {
    if (typeof source.print === "string") {
      return <span className="text-sm">{source.print}</span>;
    }
    return renderJSON(source.print);
  } else if (typeof source?.hello === "string") {
    return <span className="text-sm">{`hello, ${source.hello}!`}</span>;
  } else if (typeof source?.image === "string") {
    return <img src={source.image} />;
  }
  return renderJSON(source);
}

export const Form = ({ state }: FormProps) => {
  const errors: CompileError[] = state.errors ?? [];
  const source = state.data;
  const initialTheme =
    typeof source === "object" && source !== null && !Array.isArray(source)
      ? source.theme
      : undefined;
  const [theme, setTheme] = useState(initialTheme ?? state.data?.theme);

  useEffect(() => {
    state.apply({ type: "update", args: { theme } });
  }, [theme]);

  return (
    <div
      className={classNames(
        (theme === "dark" && "bg-zinc-900 text-white") || "bg-white text-zinc-900",
        "rounded-md font-mono flex flex-col gap-4 p-4",
      )}
    >
      {theme !== undefined && <ThemeToggle theme={theme} setTheme={setTheme} />}
      {errors.length > 0 ? renderErrors(errors, theme) : renderData(state.data)}
    </div>
  );
};
