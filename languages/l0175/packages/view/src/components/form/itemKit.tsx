// SPDX-License-Identifier: MIT
// Shared presentational helpers for the assessment-item renderers (EBSR / Hot Text / Short
// Text). Items are styled font-sans for readability inside the Form's mono container.
import type { Mode } from "./ModeToggle";

export type { Mode };

// Rationale (mode id "review") is the mode that reveals every correct answer inside the item
// body, along with the distractor analysis. (The Answers view doesn't render an item body at all —
// ItemView swaps in the answer key itself.) Preview reveals only the student's own pick, once
// they answer (the `feedback` flag).
export const revealsAnswers = (mode: Mode) => mode === "review";

export function cx(...c: any[]) {
  return c.filter(Boolean).join(" ");
}

// distractorAnalysis indexed by "A:B" (part:key) for review-mode annotations.
export function analysisIndex(item: any): Record<string, any> {
  const m: Record<string, any> = {};
  for (const d of item.distractorAnalysis ?? []) m[`${d.part}:${d.key}`] = d;
  return m;
}

export function Pill({ children }: { children: any }) {
  return (
    <span className="inline-block rounded bg-zinc-100 text-zinc-700 text-[11px] font-medium px-1.5 py-0.5 uppercase tracking-wide">
      {children}
    </span>
  );
}

export function StemLine({ children }: { children: any }) {
  return <p className="text-sm font-semibold text-zinc-900">{children}</p>;
}

// Immediate-feedback / score banner shown in Preview once an auto-scored part is answered.
export function ResultBanner({ correct, children }: { correct: boolean; children: any }) {
  return (
    <div
      className={cx(
        "rounded-md border px-3 py-2 text-sm font-medium",
        correct ? "border-green-400 bg-green-50 text-green-800" : "border-red-300 bg-red-50 text-red-800",
      )}
    >
      {children}
    </div>
  );
}

// A selectable option row (radio for single-select). Rationale marks EVERY correct option and
// annotates the wrong ones. Preview marks only the option the student picked — green if it was
// right, red if it was wrong — so answering never gives the answer away; the correct option stays
// unmarked until they find it.
export function OptionRow({
  name,
  optKey,
  selected,
  onSelect,
  mode,
  correct,
  children,
  analysis,
  feedback,
}: {
  name: string;
  optKey: string;
  selected: boolean;
  onSelect: () => void;
  mode: Mode;
  correct?: boolean;
  children: any;
  analysis?: any;
  feedback?: boolean;
}) {
  const analysed = mode === "review";
  const answered = !!feedback && selected; // this row is the student's pick, in Preview
  const showCorrect = correct && (revealsAnswers(mode) || answered);
  const showWrong = answered && !correct;
  const showAnalysis = analysis && (analysed || showWrong);
  return (
    <div>
      <label
        className={cx(
          "flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer transition text-sm",
          showCorrect
            ? "border-green-400 bg-green-50"
            : showWrong
              ? "border-red-400 bg-red-50"
              : selected
                ? "border-zinc-400 bg-zinc-50"
                : "border-zinc-200 hover:bg-zinc-50",
        )}
      >
        <input
          type="radio"
          name={name}
          checked={selected}
          onChange={onSelect}
          className="appearance-none mt-0.5 h-4 w-4 shrink-0 rounded-full border border-zinc-300 checked:border-zinc-800 checked:border-4 cursor-pointer"
        />
        <span className="font-medium text-zinc-500 w-4">{optKey}</span>
        <span className="flex-1 text-zinc-900">{children}</span>
        {showCorrect && <span className="text-green-600 font-semibold">✓</span>}
        {showWrong && <span className="text-red-600 font-semibold">✗</span>}
      </label>
      {showAnalysis &&
        (analysed ? (
          <p className="ml-9 mt-1 text-xs text-amber-700">
            <span className="font-semibold">{analysis.errorType || analysis.status}</span>
            {typeof analysis.plausibility === "number" ? ` · p=${analysis.plausibility}` : ""}
            {analysis.tiesTo && Array.isArray(analysis.tiesTo) ? "" : analysis.tiesTo ? ` → ${analysis.tiesTo}` : ""}
            {analysis.rationale ? ` — ${analysis.rationale}` : ""}
          </p>
        ) : (
          analysis.rationale && <p className="ml-9 mt-1 text-xs text-red-700">{analysis.rationale}</p>
        ))}
    </div>
  );
}
