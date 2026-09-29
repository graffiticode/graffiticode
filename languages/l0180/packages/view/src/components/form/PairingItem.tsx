// SPDX-License-Identifier: MIT
/**
 * Pairing each thing with somewhere it belongs — the renderer for `match` and `classification`.
 *
 * One component for both, because at this level they are the same question: every item gets one
 * choice from a list. What differs is the word (a target, a category) and, eventually, the
 * picture — a classification wants buckets to drag into, and a match wants two columns with
 * lines between them. Neither of those is here yet, and this is the version that works for
 * everybody first: a `<select>` per row, which is operable by mouse, touch, keyboard and screen
 * reader alike. Dragging is worth layering on afterwards, the way `OrderItem` layers it over
 * its buttons — as an addition, never as the only way in.
 *
 * Fully controlled. A selection is discrete, so it is reported and read back off the model.
 */
import { cx, Stem } from "./itemKit";
import { useShuffled } from "./shuffling";
import { scorePairs } from "../../scoring";
import type { Validation } from "../../scoring";

interface Listed {
  id: string;
  text: string;
}

interface Interaction {
  type: string;
  prompt?: string;
  shuffle?: boolean;
  items?: Listed[];
  /** A match's places. */
  targets?: Listed[];
  /** A classification's places. */
  categories?: Listed[];
}

/** `"<item> <place>"` — QTI's directedPair, and the id the key is written in. */
const pairId = (item: string, place: string) => `${item} ${place}`;

export function PairingItem({
  interaction,
  validation,
  response,
  respond,
  showResult = true,
}: {
  interaction: Interaction;
  /** Absent when the item is delivered graded — the pairings stay server-side. */
  validation?: Validation;
  response: unknown;
  respond: (response: string[]) => void;
  showResult?: boolean;
}) {
  const items = interaction.items ?? [];
  const places = interaction.targets ?? interaction.categories ?? [];
  const made: string[] = Array.isArray(response) ? (response as string[]) : [];

  const shuffle = interaction.shuffle === true;
  const shownItems = useShuffled(items, shuffle);
  const shownPlaces = useShuffled(places, shuffle);

  /** The place this item is currently paired with, or "" for an untouched row. */
  const chosen = (itemId: string): string => {
    const hit = made.find((p) => p.startsWith(`${itemId} `));
    return hit ? hit.slice(itemId.length + 1) : "";
  };

  // One pairing per item: choosing again replaces, rather than adding a second pair for the
  // same row. The scorer would count both, and the candidate never asked for two.
  const choose = (itemId: string, placeId: string) => {
    const rest = made.filter((p) => !p.startsWith(`${itemId} `));
    respond(placeId ? [...rest, pairId(itemId, placeId)] : rest);
  };

  const answered = items.filter((i) => chosen(i.id)).length;
  const gradable = !!validation && (validation.points ?? 0) > 0;
  // Marked once every row is answered, like a text-entry's blanks: "Not quite" while half the
  // rows are untouched says the wrong thing.
  const outcomes = gradable && answered > 0 ? scorePairs({ response: made, validation }) : null;
  const score = gradable && items.length > 0 && answered === items.length ? outcomes : null;

  const rationales = Object.entries(outcomes?.options ?? {})
    .filter(([, o]) => o.selected && o.rationale)
    .map(([id, o]) => ({ id, rationale: o.rationale as string }));

  return (
    <div className="flex flex-col gap-3">
      {interaction.prompt && (
        <fieldset className="border-0 p-0 m-0">
          <Stem>{interaction.prompt}</Stem>
        </fieldset>
      )}

      <ul className="flex flex-col gap-2 m-0 p-0 list-none">
        {shownItems.map((item) => {
          const picked = chosen(item.id);
          const outcome = picked ? outcomes?.options?.[pairId(item.id, picked)] : undefined;
          const right = !!outcome && outcome.correct;
          const wrong = !!picked && !!outcomes && !right;
          return (
            <li
              key={item.id}
              className={cx(
                "flex items-center gap-2 rounded border px-3 py-2 text-sm",
                right
                  ? "border-green-400 bg-green-50"
                  : wrong
                    ? "border-red-400 bg-red-50"
                    : "border-zinc-300 bg-white",
              )}
            >
              <span className="flex-1">{item.text}</span>
              <select
                className={cx(
                  "rounded border border-zinc-300 bg-white px-2 py-0.5 text-sm",
                  "focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-blue-500",
                )}
                aria-label={`Match "${item.text}"`}
                value={picked}
                onChange={(e) => choose(item.id, e.target.value)}
              >
                {/* Empty first, so an untouched row is not silently answered by whichever
                    happens to be first. */}
                <option value="">Choose…</option>
                {shownPlaces.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.text}
                  </option>
                ))}
              </select>
              {right && <span aria-hidden="true">✓</span>}
              {wrong && <span aria-hidden="true">✗</span>}
            </li>
          );
        })}
      </ul>

      {rationales.length > 0 && (
        <div className="flex flex-col gap-1">
          {rationales.map(({ id, rationale }) => (
            <p key={id} className="text-xs text-zinc-700 m-0">
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
