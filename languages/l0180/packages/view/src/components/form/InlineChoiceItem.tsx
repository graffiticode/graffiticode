// SPDX-License-Identifier: MIT
/**
 * A dropdown cloze: a sentence with menus sitting in the flow of the text.
 *
 * Half `TextEntryItem` and half `ChoiceItem`, exactly as the compiled shape is. The sentence
 * arrives already cut into `segments`, so nothing here parses a marker — the arrangement
 * hottext and text-entry both use.
 *
 * Unlike `TextEntryItem` it holds NO local state, and that is the point of the difference: a
 * selection is discrete, like a click, so it can be reported the moment it is made and read
 * back off the model. Only typing needs a draft, because a keystroke is not an answer.
 */
import { useMemo } from "react";
import { cx, Stem } from "./itemKit";
import { shuffled } from "./shuffling";
import { scoreInlineChoice } from "../../scoring";
import type { Validation } from "../../scoring";

interface Segment {
  text?: string;
  id?: string;
  /** Present on a dropdown. */
  choice?: boolean;
  options?: { id: string; text: string; anchored?: boolean }[];
}

interface Interaction {
  type: string;
  prompt?: string;
  /** One flag for the sentence; each menu still shuffles independently. */
  shuffle?: boolean;
  segments?: Segment[];
}

export function InlineChoiceItem({
  interaction,
  validation,
  response,
  respond,
  showResult = true,
}: {
  interaction: Interaction;
  /** Absent when the item is delivered graded — the key stays server-side and no feedback shows. */
  validation?: Validation;
  response: unknown;
  respond: (response: Record<string, string[]>) => void;
  showResult?: boolean;
}) {
  const segments = interaction.segments ?? [];

  // Every menu's order computed in ONE memo, keyed on the joined ids of all of them. A
  // `useMemo` inside the `segments.map` below would be a hook in a loop, and a fresh shuffle
  // on each render would move the options under the cursor between opening a menu and picking
  // from it.
  const menus = useMemo(() => {
    const out: Record<string, { id: string; text: string; anchored?: boolean }[]> = {};
    for (const seg of segments) {
      if (!seg.choice || !seg.id) continue;
      const options = seg.options ?? [];
      out[seg.id] = interaction.shuffle === true ? shuffled(options) : options;
    }
    return out;
    // Keyed on a string built from the ids rather than on `segments` itself: the model hands
    // down a fresh array every render, and keying on it would reshuffle continuously.
  }, [
    segments.map((s) => `${s.id ?? ""}:${(s.options ?? []).map((o) => o.id).join(",")}`).join(" "),
    interaction.shuffle,
  ]);

  const given: Record<string, string[]> =
    response !== null && typeof response === "object" ? (response as any) : {};

  // A list of one, so the response reads the way every other selection does. The scorer takes
  // either, but one shape across the language is worth more than the shorter spelling here.
  const choose = (id: string, optionId: string) =>
    respond({ ...given, ...(optionId ? { [id]: [optionId] } : { [id]: [] }) });

  const chosen = (id: string): string => {
    const r = given[id];
    return Array.isArray(r) ? (r[0] ?? "") : typeof r === "string" ? r : "";
  };

  const dropdowns = segments.filter((s) => s.choice).length;
  const answered = segments.filter((s) => s.choice && chosen(s.id as string)).length;
  const gradable = !!validation && (validation.points ?? 0) > 0;
  // Each dropdown is marked as soon as it is answered, but the score waits for all of them —
  // "Not quite" while half the sentence is untouched says the wrong thing. TextEntryItem draws
  // the same line for the same reason.
  const outcomes = gradable && answered > 0 ? scoreInlineChoice({ response: given, validation }) : null;
  const score = gradable && dropdowns > 0 && answered === dropdowns ? outcomes : null;

  // Only under an option the candidate actually selected, which is the rule every renderer here
  // follows: an untouched menu is never explained.
  const rationales = Object.entries(outcomes?.options ?? {})
    .filter(([, o]) => o.rationale && !o.correct)
    .map(([id, o]) => ({ id, rationale: o.rationale as string }));

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
          if (!seg.choice) return <span key={i}>{seg.text}</span>;
          const id = seg.id as string;
          nth += 1;
          const picked = chosen(id);
          const outcome = outcomes?.options?.[id];
          const marked = !!outcome && !!picked;
          const right = marked && outcome.correct;
          const wrong = marked && !outcome.correct;
          return (
            <span key={i} className="whitespace-nowrap">
              <select
                className={cx(
                  "mx-1 rounded border px-2 py-0.5 text-sm align-baseline",
                  "focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-blue-500",
                  right
                    ? "border-green-400 bg-green-50"
                    : wrong
                      ? "border-red-400 bg-red-50"
                      : "border-zinc-300 bg-white",
                )}
                aria-label={`Dropdown ${nth}`}
                value={picked}
                onChange={(e) => choose(id, e.target.value)}
              >
                {/* An empty first entry, so an untouched menu is not silently answered by
                    whichever option happens to be first. */}
                <option value="">Choose…</option>
                {(menus[id] ?? seg.options ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.text}
                  </option>
                ))}
              </select>
              {right && <span aria-hidden="true">✓</span>}
              {wrong && <span aria-hidden="true">✗</span>}
            </span>
          );
        })}
      </p>

      {rationales.length > 0 && (
        <div className="flex flex-col gap-1">
          {rationales.map(({ id, rationale }) => (
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
