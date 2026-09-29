// SPDX-License-Identifier: MIT
/**
 * A sentence filled from a shared bank.
 *
 * The bank is the whole difference from `InlineChoiceItem`, and it has to be visible as one: a
 * token placed in one gap is **disabled everywhere else**, so the pool empties as the candidate
 * works and answering the last gap is partly elimination. A dropdown cloze offers every hole its
 * own private menu and nothing is ever used up.
 *
 * A `<select>` per gap, for the reason every renderer here starts that way: it works with a
 * keyboard and a screen reader, and it works on a phone. Dragging tokens out of the bank is the
 * picture this eventually wants, layered on top the way `OrderItem` layers it — never instead.
 *
 * Fully controlled; the response is the pairs made, `"<gap> <token>"`.
 */
import { cx, Stem } from "./itemKit";
import { useShuffled } from "./shuffling";
import { scorePairs } from "../../scoring";
import type { Validation } from "../../scoring";

interface Segment {
  text?: string;
  id?: string;
  /** Present on a gap. */
  gap?: boolean;
}

interface Interaction {
  type: string;
  prompt?: string;
  shuffle?: boolean;
  segments?: Segment[];
  tokens?: { id: string; text: string }[];
}

const pairId = (gap: string, token: string) => `${gap} ${token}`;

export function GapMatchItem({
  interaction,
  validation,
  response,
  respond,
  showResult = true,
}: {
  interaction: Interaction;
  /** Absent when the item is delivered graded — which token belongs where stays server-side. */
  validation?: Validation;
  response: unknown;
  respond: (response: string[]) => void;
  showResult?: boolean;
}) {
  const segments = interaction.segments ?? [];
  const tokens = interaction.tokens ?? [];
  const made: string[] = Array.isArray(response) ? (response as string[]) : [];
  const shownTokens = useShuffled(tokens, interaction.shuffle === true);

  const inGap = (gapId: string): string => {
    const hit = made.find((p) => p.startsWith(`${gapId} `));
    return hit ? hit.slice(gapId.length + 1) : "";
  };
  /** Which gap a token is sitting in, if any — what makes the bank a bank. */
  const placedIn = (tokenId: string): string | undefined =>
    made.find((p) => p.endsWith(` ${tokenId}`))?.split(" ")[0];

  const place = (gapId: string, tokenId: string) => {
    // Dropping a token that is already somewhere else moves it, rather than cloning it: a token
    // exists once. Clearing the gap it came from is what keeps the two views agreeing.
    const rest = made.filter((p) => !p.startsWith(`${gapId} `) && !p.endsWith(` ${tokenId}`));
    respond(tokenId ? [...rest, pairId(gapId, tokenId)] : rest);
  };

  const gaps = segments.filter((s) => s.gap);
  const filled = gaps.filter((s) => inGap(s.id as string)).length;
  const gradable = !!validation && (validation.points ?? 0) > 0;
  const outcomes = gradable && filled > 0 ? scorePairs({ response: made, validation }) : null;
  const score = gradable && gaps.length > 0 && filled === gaps.length ? outcomes : null;

  const rationales = Object.entries(outcomes?.options ?? {})
    .filter(([, o]) => o.selected && o.rationale)
    .map(([id, o]) => ({ id, rationale: o.rationale as string }));

  let nth = 0;
  return (
    <div className="flex flex-col gap-3">
      {interaction.prompt && (
        <fieldset className="border-0 p-0 m-0">
          <Stem>{interaction.prompt}</Stem>
        </fieldset>
      )}

      {/* The bank, shown so the shared pool is a thing on the page rather than an inference. */}
      <ul className="flex flex-wrap gap-2 m-0 p-0 list-none" aria-label="Word bank">
        {shownTokens.map((t) => {
          const used = placedIn(t.id) !== undefined;
          return (
            <li
              key={t.id}
              className={cx(
                "rounded border px-2 py-0.5 text-sm",
                used ? "border-zinc-200 bg-zinc-50 text-zinc-400 line-through" : "border-zinc-300 bg-white",
              )}
            >
              {t.text}
            </li>
          );
        })}
      </ul>

      <p className="text-sm text-zinc-800 leading-loose m-0">
        {segments.map((seg, i) => {
          if (!seg.gap) return <span key={i}>{seg.text}</span>;
          const id = seg.id as string;
          nth += 1;
          const picked = inGap(id);
          const outcome = picked ? outcomes?.options?.[pairId(id, picked)] : undefined;
          const right = !!outcome && outcome.correct;
          const wrong = !!picked && !!outcomes && !right;
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
                aria-label={`Gap ${nth}`}
                value={picked}
                onChange={(e) => place(id, e.target.value)}
              >
                <option value="">Choose…</option>
                {shownTokens.map((t) => {
                  const elsewhere = placedIn(t.id);
                  return (
                    <option
                      key={t.id}
                      value={t.id}
                      // Spent in another gap: still listed, so the bank reads whole, but not
                      // choosable from here.
                      disabled={elsewhere !== undefined && elsewhere !== id}
                    >
                      {t.text}
                    </option>
                  );
                })}
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
