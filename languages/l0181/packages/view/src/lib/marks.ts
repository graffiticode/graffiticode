// SPDX-License-Identifier: MIT
/**
 * The study model: which cards are in which stack, and what comes next.
 *
 * Pure, and separate from the components, because this is where L0159's bugs lived — a
 * `nextIndex` that never wrapped, a `prevIndex` that was written and then commented out, and
 * a filter recomputed inline in three places from three slightly different expressions.
 */

/** How a learner rated a card. Absent means unrated. */
export type Mark = "practice" | "known";

/** Ratings by card id. Keys are stringified ids, as they arrive from JSON. */
export type Marks = Record<string, Mark>;

/** Which slice of the deck the learner is working through. */
export type Stack = "all" | "unmarked" | "practice" | "known";

export interface StackDef {
  id: Stack;
  label: string;
  /** The dot beside the stack's name. Written out rather than composed, because Tailwind
   *  only sees class names that appear literally in the source. */
  dot: string;
}

export const STACKS: StackDef[] = [
  { id: "all", label: "All cards", dot: "bg-zinc-300 dark:bg-zinc-600" },
  { id: "unmarked", label: "Not yet rated", dot: "bg-zinc-400 dark:bg-zinc-500" },
  { id: "practice", label: "Need more practice", dot: "bg-rose-400" },
  { id: "known", label: "Got these", dot: "bg-emerald-400" },
];

/** Does a card with this rating belong to this stack? */
export function inStack(stack: Stack, mark: Mark | undefined): boolean {
  if (stack === "all") return true;
  if (stack === "unmarked") return mark === undefined;
  return mark === stack;
}

/** How many cards each stack holds, for the stack picker. */
export function counts(order: number[], marks: Marks): Record<Stack, number> {
  const out = { all: 0, unmarked: 0, practice: 0, known: 0 } as Record<Stack, number>;
  for (const id of order) {
    const mark = marks[String(id)];
    for (const { id: stack } of STACKS) {
      if (inStack(stack, mark)) out[stack]++;
    }
  }
  return out;
}

/** The cards in a stack, in study order. */
export function filterOrder(order: number[], marks: Marks, stack: Stack): number[] {
  return order.filter((id) => inStack(stack, marks[String(id)]));
}

/**
 * The card `delta` steps from `cardId`, staying inside `filtered` and wrapping at the ends.
 *
 * It searches `order` rather than `filtered` so it works when `cardId` has just LEFT the
 * stack — which is what happens on every rating while studying "Not yet rated": the card the
 * learner is looking at stops belonging to the stack the moment they rate it, and the next
 * card is still the one after it in the deck.
 */
export function advance(
  order: number[],
  filtered: number[],
  cardId: number | null,
  delta: 1 | -1 = 1,
): number | null {
  if (filtered.length === 0) return null;
  if (cardId === null) return filtered[0];
  const set = new Set(filtered);
  const n = order.length;
  const at = order.indexOf(cardId);
  if (at === -1) return filtered[0];
  for (let k = 1; k <= n; k++) {
    const id = order[(((at + delta * k) % n) + n) % n];
    if (set.has(id)) return id;
  }
  return null;
}

/** Where the learner is in the current stack, 1-based. 0 when the card has left the stack. */
export function positionIn(filtered: number[], cardId: number | null): number {
  if (cardId === null) return 0;
  return filtered.indexOf(cardId) + 1;
}

/**
 * A deterministic shuffle.
 *
 * Deterministic so that a reload — which every recompile round-trip can cause — does not
 * reorder the deck under the learner mid-pass. L0159 shuffled twice on load with `Math.random`
 * and lost the learner's place each time. The seed is the deck's own content, so two different
 * decks shuffle differently and the same deck always shuffles the same way.
 */
export function shuffled(ids: number[], seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rand = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 1000000) / 1000000;
  };
  const out = ids.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
