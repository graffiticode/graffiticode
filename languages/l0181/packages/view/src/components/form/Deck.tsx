// SPDX-License-Identifier: MIT
/**
 * The player: one card at a time, flipped and rated.
 *
 * The loop is the reason this language exists. A learner sees a prompt, decides whether they
 * know it, reveals the answer, and says whether they were right. Those answers sort the deck
 * into stacks, so the second pass can be only the cards that did not stick.
 *
 * Two departures from L0159, which shipped this loop first:
 *
 *   - Next and previous WORK. L0159 wrote them and commented them out, leaving rating as the
 *     only way to move, so a learner who wanted to skip a card had to claim they knew it —
 *     which makes the rating, and therefore every stack, dishonest.
 *   - Ratings are state, not mutation. L0159 wrote `card.mark = ...` into the card objects and
 *     then shallow-copied the array to force a render.
 */
import { useMemo, useState } from "react";
import {
  advance,
  counts as stackCounts,
  filterOrder,
  positionIn,
  shuffled,
  STACKS,
} from "../../lib/marks";
import type { Mark, Marks, Stack } from "../../lib/marks";
import { CardText, textSize } from "../../lib/text";
import { StackMenu } from "./StackMenu";

export interface Card {
  id: number;
  front: string;
  back: string;
}

/** What the learner has added to the deck. Round-trips through the compile envelope. */
export interface Study {
  marks?: Marks;
  cardId?: number | null;
  stack?: Stack;
}

const CARD =
  "flex h-64 w-full cursor-pointer select-none items-center justify-center rounded-xl border " +
  "border-zinc-200 bg-white p-6 text-center shadow-sm transition hover:shadow-md " +
  "dark:border-zinc-700 dark:bg-zinc-800";

const BUTTON =
  "appearance-none inline-flex items-center justify-center gap-2 rounded-full border px-4 py-2 " +
  "text-sm cursor-pointer transition disabled:cursor-default disabled:opacity-40";

const NAV =
  "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 " +
  "dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700";

export function Deck({
  cards,
  study,
  onStudy,
}: {
  cards: Card[];
  study: Study;
  onStudy: (next: Study) => void;
}) {
  const [revealed, setRevealed] = useState(false);

  const marks: Marks = study.marks ?? {};
  const stack: Stack = study.stack ?? "all";

  // Shuffled once per deck, from the deck's own content — so a recompile (which every rating
  // causes) cannot reorder the deck under the learner.
  const order = useMemo(
    () =>
      shuffled(
        cards.map((c) => c.id),
        cards.map((c) => c.front).join(" "),
      ),
    [cards],
  );

  const filtered = filterOrder(order, marks, stack);
  const counts = stackCounts(order, marks);
  const cardId = study.cardId ?? filtered[0] ?? null;
  const card = cards.find((c) => c.id === cardId) ?? null;
  const position = positionIn(filtered, cardId);

  const go = (next: Study) => {
    setRevealed(false);
    onStudy({ marks, stack, cardId, ...next });
  };

  const move = (delta: 1 | -1) => go({ cardId: advance(order, filtered, cardId, delta) });

  const rate = (mark: Mark) => {
    const next = { ...marks, [String(cardId)]: mark };
    // Advance against the stack as it stands AFTER the rating: while studying "Not yet rated",
    // this card has just left it.
    const stillHere = filterOrder(order, next, stack);
    go({ marks: next, cardId: advance(order, stillHere, cardId, 1) });
  };

  const pickStack = (next: Stack) => {
    const inNext = filterOrder(order, marks, next);
    go({ stack: next, cardId: inNext.includes(cardId as number) ? cardId : (inNext[0] ?? null) });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <StackMenu stacks={STACKS} value={stack} counts={counts} onChange={pickStack} />
        <p className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
          {position} / {filtered.length}
        </p>
      </div>

      {card === null ? (
        <div className={`${CARD} cursor-default flex-col gap-1`}>
          <p className="text-2xl font-medium text-zinc-500 dark:text-zinc-400">
            Nothing in this stack
          </p>
          <p className="text-sm text-zinc-400 dark:text-zinc-500">Pick another one above.</p>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-label={revealed ? "Show the front" : "Reveal the answer"}
          onClick={() => setRevealed(!revealed)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setRevealed(!revealed);
            }
          }}
          className={CARD}
        >
          {/*
            `h-full w-full` is what makes an image fit. The card's height is definite (`h-64`),
            but this wrapper is a centred flex item, so without it the wrapper's height is its
            content's — indefinite — and the `max-h-full` on the image resolves to `none`
            against it. A tall image then runs straight through the card's border. `min-w-0`
            is the same story sideways: a flex item's automatic minimum size is its content's,
            which for a replaced element is the image's intrinsic width.
          */}
          <div
            className={`flex h-full w-full min-w-0 items-center justify-center ${textSize(
              revealed ? card.back : card.front,
            )} ${
              revealed
                ? "text-zinc-600 dark:text-zinc-300"
                : "font-semibold text-zinc-900 dark:text-zinc-100"
            }`}
          >
            <CardText text={revealed ? card.back : card.front} alt={card.front} />
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          aria-label="Previous card"
          disabled={filtered.length === 0}
          onClick={() => move(-1)}
          className={`${BUTTON} ${NAV}`}
        >
          Back
        </button>

        {card !== null && !revealed ? (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className={`${BUTTON} border-transparent bg-indigo-600 px-6 text-white hover:bg-indigo-500`}
          >
            Reveal
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={card === null}
              onClick={() => rate("practice")}
              className={`${BUTTON} border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200`}
            >
              I need more practice
            </button>
            <button
              type="button"
              disabled={card === null}
              onClick={() => rate("known")}
              className={`${BUTTON} border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200`}
            >
              I got this!
            </button>
          </div>
        )}

        <button
          type="button"
          aria-label="Next card"
          disabled={filtered.length === 0}
          onClick={() => move(1)}
          className={`${BUTTON} ${NAV}`}
        >
          Next
        </button>
      </div>
    </div>
  );
}
