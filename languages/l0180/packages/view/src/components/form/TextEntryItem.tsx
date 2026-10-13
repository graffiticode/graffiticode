// SPDX-License-Identifier: MIT
/**
 * Fill in the blank: a sentence with inputs sitting in the flow of the text.
 *
 * Keeps local answer state, like `ExtendedTextItem` and unlike everything that takes clicks. A
 * click is discrete, so reporting it and reading the model back costs one recompile; an input
 * reporting every keystroke would recompile the item per character. Each blank drafts locally
 * and commits on blur.
 *
 * The compiler already cut the sentence into `segments`, so nothing here parses a marker — the
 * same arrangement hottext has, and the one technique for mixing text and widgets that exists
 * in this family of languages.
 */
import { useEffect, useRef, useState } from "react";
import { cx, Stem } from "./itemKit";
import { scoreTextEntry } from "../../scoring";
import type { Validation } from "../../scoring";

interface Segment {
  text?: string;
  id?: string;
  blank?: boolean;
  /** The blank takes a number. Comes from `interaction`, so it survives a graded delivery. */
  numeric?: boolean;
}

interface Interaction {
  type: string;
  prompt?: string;
  segments?: Segment[];
}

/** "as a fraction", "as a decimal or in scientific notation" — the forms, in plain English. */
const FORM_NAMES: Record<string, string> = {
  decimal: "as a decimal",
  fraction: "as a fraction",
  scientific: "in scientific notation",
};

function askFor(formats: string[]): string {
  const names = formats.map((f) => FORM_NAMES[f] ?? `as ${f}`);
  const list =
    names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0];
  return `That is the right value. Give it ${list}.`;
}

export function TextEntryItem({
  interaction,
  validation,
  response,
  respond,
  showResult = true,
}: {
  interaction: Interaction;
  /** Absent when the item is delivered graded — the accepted answers stay server-side. */
  validation?: Validation;
  response: unknown;
  respond: (response: Record<string, string>) => void;
  showResult?: boolean;
}) {
  const segments = interaction.segments ?? [];
  const committed: Record<string, string> =
    response !== null && typeof response === "object" ? (response as any) : {};

  // Compared as a serialized value rather than by identity: the model hands down a fresh object
  // every render, so an identity check would reset the draft under whoever is typing.
  const settled = JSON.stringify(committed);
  const seen = useRef(settled);
  const [draft, setDraft] = useState<Record<string, string>>({ ...committed });

  // Keyed on `settled` alone on purpose: `committed` is a fresh object every render, so
  // including it would re-run this constantly and wipe the draft mid-keystroke.
  useEffect(() => {
    if (settled !== seen.current) {
      seen.current = settled;
      setDraft(JSON.parse(settled));
    }
  }, [settled]);

  const commit = (id: string) => {
    const value = draft[id] ?? "";
    if (value === (committed[id] ?? "")) return;
    const next = { ...committed, [id]: value };
    seen.current = JSON.stringify(next);
    respond(next);
  };

  const blanks = segments.filter((s) => s.blank).length;
  const filled = Object.values(committed).filter(
    (v) => typeof v === "string" && v.trim().length > 0,
  ).length;
  const gradable = !!validation && (validation.points ?? 0) > 0;
  // Each blank is marked as soon as it is answered, but the score waits for all of them —
  // "Not quite" while half the sentence is still empty says the wrong thing.
  const outcomes = gradable && filled > 0 ? scoreTextEntry({ response: committed, validation }) : null;
  const score = gradable && blanks > 0 && filled === blanks ? outcomes : null;

  // Only for an answer the author anticipated and the candidate actually typed — the same rule
  // `OptionRow` follows for a distractor. An unanticipated answer gets a ✗ and nothing else.
  //
  // A right value in the wrong form joins them, because it is the same kind of remark: the
  // author asked for a fraction and got a decimal, and "incorrect" alone would be a lie about
  // which part of the work went wrong. The scorer reports the accepted forms; naming them in
  // English is presentation, so it lives here.
  const showFeedbackLines = Object.entries(outcomes?.options ?? {})
    .map(([id, o]) => {
      if (o.wrongFormat) return { id, rationale: askFor(o.wrongFormat) };
      if (o.rationale && !o.correct) return { id, rationale: o.rationale };
      return null;
    })
    .filter((l): l is { id: string; rationale: string } => l !== null);

  let nth = 0;
  return (
    <div className="flex flex-col gap-3">
      {interaction.prompt && (
        <fieldset className="border-0 p-0 m-0">
          <Stem>{interaction.prompt}</Stem>
        </fieldset>
      )}

      <p className="text-sm text-zinc-800 leading-loose m-0">
        {segments.map((seg, i) => {
          if (!seg.blank) return <span key={i}>{seg.text}</span>;
          const id = seg.id as string;
          nth += 1;
          const outcome = outcomes?.options?.[id];
          const marked = !!outcome && (committed[id] ?? "").trim().length > 0;
          const right = marked && outcome.correct;
          const wrong = marked && !outcome.correct;
          return (
            <span key={i} className="whitespace-nowrap">
              <input
                type="text"
                // Uniform, never sized to the answer — a box the width of the answer is a clue
                // about the answer, and this half is what a graded delivery ships.
                className={cx(
                  "w-32 mx-1 rounded border px-2 py-0.5 text-sm align-baseline",
                  "focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-blue-500",
                  right
                    ? "border-green-400 bg-green-50"
                    : wrong
                      ? "border-red-400 bg-red-50"
                      : "border-zinc-300 bg-white",
                )}
                aria-label={`Blank ${nth}`}
                // A numeric keypad on a phone, without asserting the field only accepts digits
                // — `inputMode` hints, `type="number"` would fight fractions like 1/2.
                inputMode={seg.numeric ? "decimal" : undefined}
                value={draft[id] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [id]: e.target.value }))}
                onBlur={() => commit(id)}
              />
              {right && <span aria-hidden="true">✓</span>}
              {wrong && <span aria-hidden="true">✗</span>}
            </span>
          );
        })}
      </p>

      {showFeedbackLines.length > 0 && (
        <div className="flex flex-col gap-1">
          {showFeedbackLines.map(({ id, rationale }) => (
            <p key={id} className="text-xs text-red-800 m-0">
              {rationale}
            </p>
          ))}
        </div>
      )}

      {score && showResult && (
        <div
          role="status"
          className={cx(
            "rounded-md border px-3 py-2 text-sm font-medium",
            score.correct
              ? "border-green-400 bg-green-50 text-green-800"
              : "border-red-300 bg-red-50 text-red-800",
          )}
        >
          {score.correct
            ? `Correct — ${score.points} / ${score.maxPoints} ${score.maxPoints === 1 ? "point" : "points"}.`
            : `Not quite — ${score.points} / ${score.maxPoints} ${score.maxPoints === 1 ? "point" : "points"}.`}
        </div>
      )}
    </div>
  );
}
