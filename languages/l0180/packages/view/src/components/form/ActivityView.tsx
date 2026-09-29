// SPDX-License-Identifier: MIT
/**
 * An activity: several items delivered together, each scored on its own.
 *
 * The response is keyed by item id — the item's position, as a string — and each item sees only
 * its own slice, exactly as `ItemView` does for parts one level down. Merging happens here, so
 * an item component is identical standing alone, inside an activity, or nested in another item.
 *
 * `navigation` decides the layout, and it is the only setting this renderer can honour.
 * `nonlinear` (the default) lays every item out on one screen, which is what L0180 has always
 * done. `linear` shows one at a time with no way back, which is the whole content of QTI's word
 * — so the language does not claim something the renderer cannot keep.
 *
 * `submission` is carried in the compiled output for a delivery host to act on and changes
 * nothing here: there is no server in this loop, so every answer is already "submitted" the
 * moment it is given. Naming it in the output rather than acting on it is deliberate — a
 * renderer that pretended to hold answers back would be inventing a delivery model.
 */
import { useState } from "react";
import { InteractionView } from "./interactions";
import { ItemView } from "./ItemView";
import { ResultBanner } from "./itemKit";
import { isAnswered } from "./answered";
import { scoreActivity } from "../../scoring";

interface ActivityItem {
  id: number;
  interaction: any;
  validation?: any;
}

export function ActivityView({
  activity,
  response,
  respond,
}: {
  activity: { navigation?: string; submission?: string; items?: ActivityItem[] };
  response: unknown;
  respond: (response: any) => void;
}) {
  const items = activity.items ?? [];
  const linear = activity.navigation === "linear";
  const given = response !== null && typeof response === "object" ? (response as any) : {};

  /**
   * The cursor is LOCAL state, unlike L0182's, and the difference is not an oversight.
   *
   * There it has to survive a page reload, because a participation lives on a server and a
   * participant may come back to it; here nothing is persisted mid-activity — `simultaneous`
   * submission is the default precisely because there is nowhere to submit to — so the cursor
   * has no reason to enter the model. Keeping it out means answering an item cannot move it,
   * which a model-held cursor would have had to guard against explicitly.
   *
   * It is safe across recompiles for the ordinary React reason: the component stays mounted,
   * so the state survives. This is NOT the shuffling hazard, which is about a value the
   * COMPILER would recompute; nothing recomputes this.
   */
  const [cursor, setCursor] = useState(0);
  const at = Math.min(cursor, Math.max(0, items.length - 1));
  const shown = linear ? items.slice(at, at + 1) : items;

  const answerItem = (id: number, r: unknown) => respond({ ...given, [String(id)]: r });

  // The total is withheld until every item is answered. A running total over a half-finished
  // activity reads as a verdict on the whole thing, and would count an unanswered item as zero.
  const finished = items.length > 0 && items.every((i) => isAnswered(i.interaction, given[String(i.id)]));
  const score = finished ? scoreActivity({ activity, response: given }) : null;

  return (
    <div className="flex flex-col gap-6">
      {linear && (
        <p className="text-xs font-medium text-zinc-500">
          {`Question ${at + 1} of ${items.length}`}
        </p>
      )}

      {shown.map((item) => (
        <section key={item.id} className="flex flex-col gap-2">
          {!linear && items.length > 1 && (
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {`Question ${item.id + 1}`}
            </h2>
          )}
          {item.interaction?.type === "item" ? (
            <ItemView
              interaction={item.interaction}
              validation={item.validation}
              response={given[String(item.id)]}
              respond={(r) => answerItem(item.id, r)}
            />
          ) : (
            <InteractionView
              interaction={item.interaction}
              validation={item.validation}
              response={given[String(item.id)]}
              respond={(r) => answerItem(item.id, r)}
            />
          )}
        </section>
      ))}

      {/*
        Forward only. Under `linear` there is deliberately no Back control — QTI's word means
        the candidate cannot return to an item they have left, so offering the button and then
        refusing it would be worse than not offering it. The last item has no Next either:
        a control that cannot advance is the confusing kind of dead button.
      */}
      {linear && at < items.length - 1 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setCursor(at + 1)}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
          >
            Next
          </button>
        </div>
      )}

      {score && score.pending && (
        <div
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900"
        >
          {`${score.points} / ${score.maxPoints} so far — a written answer is marked by your teacher.`}
        </div>
      )}

      {score && !score.pending && score.maxPoints > 0 && (
        <ResultBanner correct={score.correct}>
          {`${score.points} / ${score.maxPoints} ${score.maxPoints === 1 ? "point" : "points"}.`}
        </ResultBanner>
      )}
    </div>
  );
}
