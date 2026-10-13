// SPDX-License-Identifier: MIT
/**
 * Shared presentational pieces for the interaction renderers.
 *
 * Selection is a real `<input type="radio">`/`<input type="checkbox">` inside a `<label>`,
 * inside a `<fieldset>` with a `<legend>`. That is not decoration: it is what gives keyboard
 * navigation, focus handling, and screen-reader group semantics without writing any of them.
 * A div with an onClick would have to reimplement all three, and assessment is exactly the
 * context where failing to is not acceptable.
 */
import type { ReactNode } from "react";

export function cx(...c: unknown[]): string {
  return c.filter(Boolean).join(" ");
}

export function Stem({ children }: { children: ReactNode }) {
  return <legend className="text-sm font-semibold text-zinc-900 mb-2 p-0">{children}</legend>;
}

/**
 * A selectable option.
 *
 * `feedback` marks ONLY the row the learner picked — green if it was right, red if it was
 * wrong. The correct option is never highlighted until they find it, so answering once does
 * not hand over the answer. Borrowed from L0175, which had the same problem to solve.
 */
export function OptionRow({
  name,
  id,
  multiple,
  selected,
  onSelect,
  feedback,
  correct,
  rationale,
  children,
}: {
  name: string;
  id: string;
  multiple: boolean;
  selected: boolean;
  onSelect: () => void;
  /** Show the outcome of this row. False while the item is unanswered or ungraded. */
  feedback?: boolean;
  correct?: boolean;
  /**
   * Why this option is wrong, shown only once the candidate has chosen it.
   *
   * Distractor rationale, as L0175 authors it: it explains a mistake the learner just made.
   * Tied to the wrong-and-selected state for the same reason `feedback` is — a rationale on an
   * untouched row would say which options had been considered worth explaining.
   */
  rationale?: string;
  children: ReactNode;
}) {
  const marked = !!feedback && selected;
  const right = marked && correct;
  const wrong = marked && !correct;
  return (
    <label
      className={cx(
        "flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer transition",
        "focus-within:ring-2 focus-within:ring-offset-1 focus-within:ring-blue-500",
        right
          ? "border-green-400 bg-green-50"
          : wrong
            ? "border-red-400 bg-red-50"
            : selected
              ? "border-blue-400 bg-blue-50"
              : "border-zinc-200 hover:border-zinc-300 bg-white",
      )}
    >
      <input
        type={multiple ? "checkbox" : "radio"}
        name={name}
        value={id}
        checked={selected}
        onChange={onSelect}
        className="mt-0.5"
      />
      <span className="flex-1 text-zinc-900">{children}</span>
      {right && <span aria-hidden="true">✓</span>}
      {wrong && <span aria-hidden="true">✗</span>}
      {wrong && rationale && (
        <p className="w-full basis-full m-0 pl-6 text-xs text-red-800">{rationale}</p>
      )}
    </label>
  );
}

/** The score, once the item is answered and its key is present. */
export function ResultBanner({ correct, children }: { correct: boolean; children: ReactNode }) {
  return (
    <div
      role="status"
      className={cx(
        "rounded-md border px-3 py-2 text-sm font-medium",
        correct
          ? "border-green-400 bg-green-50 text-green-800"
          : "border-red-300 bg-red-50 text-red-800",
      )}
    >
      {children}
    </div>
  );
}

export function ErrorList({ errors }: { errors: { message: string }[] }) {
  return (
    <div className="flex flex-col gap-2">
      {errors.map((e, i) => (
        <div
          key={i}
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 whitespace-pre-wrap"
        >
          {e.message}
        </div>
      ))}
    </div>
  );
}
