// SPDX-License-Identifier: MIT
// L0174's Form: renders a compiled form definition (title / theme / fields / submit), does
// client-side validation, and on submit emits the collected values. Injected into the shared
// View (from @graffiticode/l0000-view), which supplies `state.data` and `state.errors`.
//
// Submission delivery (compose an L0000 data tail under the form head, terminal webhook POST)
// is handled by the platform — see the forms hook spec. Here, a valid submit surfaces the
// thank-you / redirect and posts the values to the embedding parent window.
import "../../index.css";
import { useState, type FormEvent } from "react";
import type { FormProps, CompileError } from "@graffiticode/l0000-view";
import { ThemeToggle } from "./ThemeToggle";
import { Field } from "./Field";
import { validateAll, type FieldDef } from "./validate";

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

// The origin of the embedding parent, if this form is hosted in an iframe.
function parentOrigin(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("origin") ?? undefined;
}

export const Form = ({ state }: FormProps) => {
  const { apply } = state;
  const errors: CompileError[] = state.errors ?? [];
  const data = state.data ?? {};
  const fields: FieldDef[] = Array.isArray(data.fields) ? data.fields : [];
  const submit = data.submit ?? {};

  const [theme, setTheme] = useState<string | undefined>(data.theme);
  // Seed once from any previously-submitted values carried in the compiled data. Answers
  // are namespaced under `data.values` (kept separate from the form-definition keys); the
  // View only mounts Form once `state.data` is renderable, so this lazy initializer sees them.
  const [values, setValues] = useState<Record<string, any>>(() => {
    const v = data.values;
    return v && typeof v === "object" && !Array.isArray(v) ? { ...v } : {};
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const onChange = (name: string, value: any) => {
    setValues((v) => ({ ...v, [name]: value }));
    setFieldErrors((e) => {
      if (!e[name]) return e;
      const next = { ...e };
      delete next[name];
      return next;
    });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const errs = validateAll(fields, values);
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    // Capture answers into the shared View state (submit-time only, never per keystroke).
    // Namespaced under `values` so they stay separate from the form-definition keys and
    // round-trip through compile back into `data.values`.
    apply({ type: "update", args: { values } });

    // Emit the submission to the embedding parent (delivery to the bound webhook is handled
    // downstream by the platform — out of scope for the renderer). Namespaced to match the
    // load/prefill contract: the data tail carries answers under `values`.
    const origin = parentOrigin();
    if (origin) {
      window.parent.postMessage(
        { type: "submit", title: data.title, data: { values } },
        origin,
      );
    }

    if (submit.redirect) {
      window.location.href = submit.redirect;
      return;
    }
    setSubmitted(true);
  };

  const dark = theme === "dark";
  const container = classNames(
    dark ? "bg-zinc-900 text-white" : "bg-white text-zinc-900",
    "rounded-md font-mono flex flex-col gap-4 p-4",
  );

  if (errors.length > 0) {
    return (
      <div className={container}>
        {theme !== undefined && <ThemeToggle theme={theme} setTheme={setTheme} />}
        {renderErrors(errors, theme)}
      </div>
    );
  }

  if (submitted) {
    return (
      <div className={container}>
        <div className="text-sm">{submit.thankyou || "Thanks — your response was submitted."}</div>
      </div>
    );
  }

  return (
    <form className={container} onSubmit={onSubmit} noValidate>
      <div className="flex items-center justify-between gap-2">
        {data.title && <h2 className="text-lg font-semibold">{data.title}</h2>}
        {theme !== undefined && <ThemeToggle theme={theme} setTheme={setTheme} />}
      </div>
      {fields.map((field) => (
        <Field
          key={field.name}
          field={field}
          value={values[field.name]}
          error={fieldErrors[field.name]}
          theme={theme}
          onChange={onChange}
        />
      ))}
      <button
        type="submit"
        className={classNames(
          "appearance-none self-start inline-flex items-center rounded-md px-4 py-2 text-sm font-medium cursor-pointer transition border",
          dark
            ? "bg-white text-zinc-900 border-transparent hover:bg-zinc-200"
            : "bg-zinc-900 text-white border-transparent hover:bg-zinc-700",
        )}
      >
        {submit.label || "Submit"}
      </button>
    </form>
  );
};
