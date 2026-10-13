// SPDX-License-Identifier: MIT
/**
 * The one shuffle in the package.
 *
 * Randomized presentation is the default across `choice`, `inline-choice` and `order`, and the
 * two properties that make it safe are easy to lose if it is written three times:
 *
 * - **It happens at render, once per mount.** Not at compile time: `PROG` recompiles on every
 *   response, so a compile-time order would reshuffle under the candidate as they answer, and a
 *   deterministic one would be invertible by anyone who knows the rule.
 * - **It survives a re-render.** Memoized on the joined ids, because the model hands down a
 *   fresh array every render and keying on the array itself would reshuffle continuously —
 *   moving the list under the cursor mid-answer, which is worse than not shuffling at all.
 *
 * `shuffle` is a plain function taking an RNG so it can be tested with a seeded one; the hook is
 * the thin React wrapper over it.
 */
import { useMemo } from "react";

/** Anything with an id and a text, which is every list a candidate picks from. */
export interface Listed {
  id: string;
  text?: string;
  /** Set by the compiler on an option that belongs last however the rest is shuffled. */
  anchored?: boolean;
}

/**
 * Fisher-Yates over the unanchored entries, with the anchored ones kept in order at the tail.
 *
 * "All of the above" in position 2 is a broken item, so the compiler marks those and they are
 * partitioned out here rather than shuffled and hoped over.
 */
export function shuffled<T extends Listed>(items: T[], rng: () => number = Math.random): T[] {
  const loose = items.filter((i) => !i.anchored);
  const anchored = items.filter((i) => i.anchored);
  for (let i = loose.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [loose[i], loose[j]] = [loose[j], loose[i]];
  }
  return [...loose, ...anchored];
}

/**
 * The presented order for one list.
 *
 * Deliberately not stable across mounts: re-ordering on revisit is the point. `avoid` is for
 * `order`, whose shuffle must not hand the candidate the answer — it reshuffles while the
 * result equals that sequence, and gives up after a few tries so a two-element list cannot spin
 * (with two elements only one of the two orders is wrong, and it will be found immediately).
 */
export function useShuffled<T extends Listed>(
  items: T[],
  shuffle: boolean,
  avoid?: string[] | null,
  /** How an id is compared against `avoid` — identity, unless some ids stand for each other. */
  canonical: (id: string) => string = (id) => id,
): T[] {
  const key = items.map((i) => i.id).join(" ");
  const forbidden = avoid && avoid.length ? avoid.join(" ") : "";
  return useMemo(() => {
    if (!shuffle) return items;
    const asForbidden = (list: T[]) => list.map((i) => canonical(i.id)).join(" ");
    let out = shuffled(items);
    for (let n = 0; n < 8 && forbidden && asForbidden(out) === forbidden; n++) {
      out = shuffled(items);
    }
    return out;
    // Keyed on the joined ids rather than the arrays themselves: a new identity every render
    // would reshuffle continuously.
  }, [key, shuffle, forbidden]);
}
