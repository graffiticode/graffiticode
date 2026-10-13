// SPDX-License-Identifier: MIT
/**
 * A multi-part item: an optional stimulus, then each part in order.
 *
 * The response is keyed by part id, matching `validation.parts`, and each part sees only its
 * own slice. Merging happens here rather than in the parts, so a part component stays
 * identical whether it is standing alone or sitting inside an item.
 *
 * Only the ITEM reports a result, never the individual parts. Under conjunctive scoring a
 * per-part banner would be actively misleading — "correct" on Part A while the item earns
 * nothing is not a thing a learner should be told.
 */
import { InteractionView } from "./interactions";
import { isAnswered } from "./answered";
import { HottextPassage, HottextPrompt } from "./HottextItem";
import { ResultBanner } from "./itemKit";
import { scoreItem } from "../../scoring";
import type { ItemValidation } from "../../scoring";

interface Paragraph {
  id: string;
  text: string;
}

interface Stimulus {
  title?: string;
  paragraphs?: Paragraph[];
}

export function ItemView({
  interaction,
  validation,
  response,
  respond,
}: {
  interaction: { type: string; stimulus?: Stimulus; parts?: any[] };
  /** Absent when the item is delivered graded — the key stays server-side, no feedback shows. */
  validation?: ItemValidation;
  response: unknown;
  respond: (response: any) => void;
}) {
  const parts = interaction.parts ?? [];
  const stimulus = interaction.stimulus;
  // A hottext selecting `within "stimulus"` owns the passage: it renders in the stimulus slot,
  // interactive, INSTEAD of the read-only copy. Rendering both would show the passage twice on
  // one screen, which is only tolerable in L0175 because its two copies live in separate tabs.
  const owner = parts.find((p: any) => p.type === "hottext" && p.within === "stimulus");
  const given = response !== null && typeof response === "object" ? (response as any) : {};

  const answerPart = (id: string, partResponse: unknown) =>
    respond({ ...given, [id]: partResponse });

  const gradable = !!validation && (validation.points ?? 0) > 0;
  const answered = parts.every((p: any) => isAnswered(p, given[p.id]));
  const score = gradable && answered ? scoreItem({ response: given, validation }) : null;

  return (
    <div className="flex flex-col gap-4">
      {stimulus && owner && (
        <div className="flex flex-col gap-2">
          {stimulus.title && <h2 className="text-sm font-semibold text-zinc-900">{stimulus.title}</h2>}
          <HottextPassage
            interaction={owner}
            validation={validation?.parts?.[owner.id]}
            response={given[owner.id]}
            respond={(r) => answerPart(owner.id, r)}
          />
        </div>
      )}

      {stimulus && !owner && (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
          {stimulus.title && (
            <h2 className="text-sm font-semibold text-zinc-900 mb-2">{stimulus.title}</h2>
          )}
          <ol className="flex flex-col gap-1 list-none p-0 m-0">
            {(stimulus.paragraphs ?? []).map((p, i) => (
              <li key={p.id} className="flex gap-3 text-sm text-zinc-800">
                {/* Numbered because stems reference lines by number ("Which line best…"). */}
                <span className="text-zinc-400 tabular-nums select-none w-5 text-right">{i + 1}</span>
                <span className="flex-1">{p.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {parts.map((part: any, i: number) => (
        <section key={part.id} className="flex flex-col gap-2">
          {parts.length > 1 && (
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Part {String.fromCharCode(65 + i)}
            </h3>
          )}
          {part === owner ? (
            // Its passage is already up in the stimulus slot; down here it is just the stem.
            <HottextPrompt
              interaction={part}
              validation={validation?.parts?.[part.id]}
              response={given[part.id]}
              respond={(r) => answerPart(part.id, r)}
              showResult={false}
            />
          ) : (
            <InteractionView
              interaction={part}
              validation={validation?.parts?.[part.id]}
              response={given[part.id]}
              respond={(r) => answerPart(part.id, r)}
              showResult={false}
            />
          )}
        </section>
      ))}

      {score && score.pending && (
        <div
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900"
        >
          {`${score.points} / ${score.maxPoints} so far — the written part is marked by your teacher.`}
        </div>
      )}

      {score && !score.pending && (
        <ResultBanner correct={score.correct}>
          {score.correct
            ? `Correct — ${score.points} / ${score.maxPoints} ${score.maxPoints === 1 ? "point" : "points"}.`
            : `Not quite — ${score.points} / ${score.maxPoints} ${score.maxPoints === 1 ? "point" : "points"}.`}
        </ResultBanner>
      )}
    </div>
  );
}
