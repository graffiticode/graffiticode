// SPDX-License-Identifier: MIT
/**
 * A written response, scored by a person against a rubric.
 *
 * This is the one renderer that keeps answer state of its own, and it has to. Every other
 * interaction here is fully controlled — a click is discrete, so reporting it immediately and
 * reading the model back costs one recompile. A textarea reporting every keystroke would
 * recompile the item per character. So the draft is local and commits on blur, and the model
 * stays the source of truth for what was actually answered.
 *
 * Nothing here scores. `validation.responseProcessing` is `"human"`, the rubric is shown so the
 * candidate knows what is being asked of them, and the result says pending rather than zero.
 */
import { useEffect, useRef, useState } from "react";
import { cx, Stem } from "./itemKit";
import type { Validation } from "../../scoring";

interface Interaction {
  type: string;
  prompt?: string;
}

export function ExtendedTextItem({
  interaction,
  validation,
  response,
  respond,
  showResult = true,
}: {
  interaction: Interaction;
  /** Absent when the item is delivered graded — the rubric stays server-side. */
  validation?: Validation;
  response: unknown;
  respond: (response: string) => void;
  showResult?: boolean;
}) {
  const committed = typeof response === "string" ? response : "";
  const [draft, setDraft] = useState(committed);
  const seen = useRef(committed);

  // A fresh compile can bring a different response down — a reload, or a host restoring an
  // attempt. Adopt it, but only when it actually changed, so it never clobbers live typing.
  useEffect(() => {
    if (committed !== seen.current) {
      seen.current = committed;
      setDraft(committed);
    }
  }, [committed]);

  const commit = () => {
    if (draft === seen.current) return;
    seen.current = draft;
    respond(draft);
  };

  const rubric = validation?.rubric ?? [];
  const answered = committed.trim().length > 0;
  const showRubric = rubric.length > 0 && answered;

  return (
    <div className="flex flex-col gap-3">
      {interaction.prompt && (
        <fieldset className="border-0 p-0 m-0">
          <Stem>{interaction.prompt}</Stem>
        </fieldset>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        rows={6}
        className={cx(
          "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900",
          "focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-blue-500",
        )}
        placeholder="Write your response here."
      />

      {showResult && answered && (
        <div
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900"
        >
          {`Answer saved — ${validation?.points ?? 0} ${
            (validation?.points ?? 0) === 1 ? "point" : "points"
          } available, marked by your teacher.`}
        </div>
      )}

      {showRubric && (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 m-0">
            How this is marked
          </h3>
          <ol className="flex flex-col gap-1 list-none p-0 m-0">
            {rubric.map((band) => (
              <li key={band.points} className="flex gap-3 text-sm text-zinc-800">
                <span className="text-zinc-500 tabular-nums select-none w-8 text-right font-semibold">
                  {band.points}
                </span>
                <span className="flex-1">{band.descriptor}</span>
              </li>
            ))}
          </ol>
          {validation?.exemplar && (
            <p className="text-sm text-zinc-600 m-0 pt-1 border-t border-zinc-200">
              <span className="font-semibold text-zinc-700">A full-marks response: </span>
              {validation.exemplar}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
