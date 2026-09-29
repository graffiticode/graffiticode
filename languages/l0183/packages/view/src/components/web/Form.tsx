// SPDX-License-Identifier: MIT
/**
 * L0183's Form: one compiled concept web, or the compile errors that stopped it.
 *
 * It runs in several hosts, and reads the same model in all of them:
 *
 * - The /form embed, inside the shared View from @graffiticode/l0000-view. A placement is a
 *   `response` action; `reduce` folds it into `interaction.cells`, the View recompiles, and the
 *   compiler carries the answers back.
 * - A Learnosity custom question, inside `@graffiticode/learnosity-cqt`. The same `response`
 *   action lands in `responseValue`, and Learnosity can `disable` the question or `reset` it.
 *
 * Checking belongs to the host, not to this Form. Our hosts draw a Check button (the View's
 * `score` binding); Learnosity has its own Check Answer, or none. Either way a check reaches the
 * Form as `showValidationUI`, and that, or the program's `instant-feedback true`, is the only
 * thing that shows right and wrong.
 *
 * Learnosity is recognised by `questionState`, which only cqt puts in the model; it decides only
 * whether the theme toggle shows.
 */
import "../../index.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CompileError, FormProps } from "@graffiticode/l0000-view";
import { scoreResponse } from "../../scoring";
import { RichText } from "../../lib/text";
import { Web, type Interaction } from "./Web";
import { ThemeToggle } from "./ThemeToggle";

function classNames(...classes: any[]) {
  return classes.filter(Boolean).join(" ");
}

function renderErrors(errors: CompileError[]) {
  return (
    <div className="flex flex-col gap-2">
      {errors.map((error, i) => (
        <div
          key={i}
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {error.message}
        </div>
      ))}
    </div>
  );
}

export const Form = ({ state }: FormProps) => {
  const errors: CompileError[] = state.errors ?? [];
  const data = state.data ?? {};
  const interaction: Interaction | undefined =
    data.interaction?.type === "concept-web" ? data.interaction : undefined;
  const inLearnosity = data.questionState !== undefined || data.responseValue !== undefined;

  // The program picks the starting theme; the learner's toggle wins for the session.
  const [theme, setTheme] = useState<string>(data.theme ?? "light");
  useEffect(() => {
    if (data.theme) setTheme(data.theme);
  }, [data.theme]);

  const placed = useMemo(() => {
    const cells = { ...(interaction?.cells || {}), ...(data.responseValue || {}) };
    const out: Record<string, string | undefined> = {};
    for (const id of Object.keys(cells)) {
      const v = cells[id]?.value;
      out[id] = typeof v === "string" && v ? v : undefined;
    }
    return out;
  }, [interaction?.cells, data.responseValue]);

  const onPlace = (changes: Record<string, string | null>) => {
    const cells: Record<string, { value: string | null }> = {};
    for (const id of Object.keys(changes)) cells[id] = { value: changes[id] };
    state.apply({ type: "response", args: { cells } });
  };

  // Learnosity's "reset response": empty every blank, once per reset.
  const lastReset = useRef(false);
  useEffect(() => {
    if (data.reset && !lastReset.current && interaction) {
      const cleared: Record<string, null> = {};
      for (const id of Object.keys(interaction.cells)) cleared[id] = null;
      onPlace(cleared);
    }
    lastReset.current = !!data.reset;
  }, [data.reset]);

  const validation = data.validation;
  const checked = data.showValidationUI === true;
  const instant = data.feedback === "instant";
  const scores = useMemo(() => {
    if (!validation || !(checked || instant)) return undefined;
    const all = scoreResponse(data.responseValue ?? interaction?.cells ?? {}, validation);
    if (checked) return all;
    // Instant feedback judges what the learner has placed. An empty blank is not wrong yet; it
    // only counts against them when they check.
    return Object.fromEntries(Object.entries(all).filter(([id]) => placed[id]));
  }, [validation, checked, instant, data.responseValue, interaction?.cells, placed]);

  const body = () => {
    if (errors.length > 0) return renderErrors(errors);
    if (!interaction) {
      return <pre className="text-xs text-zinc-500">{JSON.stringify(data, null, 2)}</pre>;
    }
    return (
      <Web
        interaction={interaction}
        placed={placed}
        onPlace={onPlace}
        scores={scores}
        disabled={!!data.disabled}
      />
    );
  };

  return (
    <div className={classNames("l0183-web", theme === "dark" && "dark")}>
      <div className="mx-auto flex max-w-5xl flex-col gap-4 rounded-md bg-zinc-50 p-4 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            {data.title && (
              <h1 className="text-2xl font-semibold leading-tight">
                <RichText text={String(data.title)} />
              </h1>
            )}
            {data.instructions && (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                <RichText text={String(data.instructions)} />
              </p>
            )}
          </div>
          {!inLearnosity && <ThemeToggle theme={theme} setTheme={setTheme} />}
        </div>
        {body()}
      </div>
    </div>
  );
};
