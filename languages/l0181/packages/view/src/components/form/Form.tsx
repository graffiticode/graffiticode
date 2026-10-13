// SPDX-License-Identifier: MIT
/**
 * L0181's Form: renders one compiled deck, or the compile errors that stopped it.
 *
 * Injected into the shared View from @graffiticode/l0000-view, which supplies `state.data`,
 * `state.errors` and `state.apply`, and owns the URL params, the parent-window messaging and
 * the recompile loop. This file renders and reports; it fetches nothing.
 *
 * A rating is reported as a `response` action because that is one of the two action types the
 * shared View recompiles on — so study state needs no transport of its own, and it comes back
 * down attached to the deck, which is what makes it survive a reload.
 */
import "../../index.css";
import { useEffect, useState } from "react";
import type { FormProps, CompileError } from "@graffiticode/l0000-view";
import { Deck } from "./Deck";
import type { Card, Study } from "./Deck";
import { CardText } from "../../lib/text";
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
  const cards: Card[] = Array.isArray(data.cards) ? data.cards : [];

  // The program picks the starting theme; the learner's toggle wins from then on. Reported as
  // `update` so it persists like any other edit to the deck's configuration.
  const [theme, setTheme] = useState<string>(data.theme ?? "light");
  useEffect(() => {
    if (data.theme !== theme) state.apply({ type: "update", args: { theme } });
  }, [theme]);

  const onStudy = (response: Study) => state.apply({ type: "response", args: { response } });

  const body = () => {
    if (errors.length > 0) return renderErrors(errors);
    if (cards.length === 0) {
      // Nothing compiled yet, or a program that produced something other than a deck.
      return <pre className="text-xs text-zinc-500">{JSON.stringify(data, null, 2)}</pre>;
    }
    return <Deck cards={cards} study={data.response ?? {}} onStudy={onStudy} />;
  };

  return (
    <div className={classNames("l0181-deck", theme === "dark" && "dark")}>
      {/* Capped and centred: a flashcard stretched across a 1400px desktop reads badly, and
          the deck is just as often embedded in a narrow column. */}
      <div className="mx-auto flex max-w-2xl flex-col gap-4 rounded-md bg-zinc-50 p-4 font-sans text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            {data.title && (
              <h1 className="text-2xl font-semibold leading-tight">
                <CardText text={String(data.title)} />
              </h1>
            )}
            {data.instructions && (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                <CardText text={String(data.instructions)} />
              </p>
            )}
          </div>
          <ThemeToggle theme={theme} setTheme={setTheme} />
        </div>
        {body()}
      </div>
    </div>
  );
};
