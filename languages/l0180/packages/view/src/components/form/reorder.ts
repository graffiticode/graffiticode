// SPDX-License-Identifier: MIT
/**
 * Moving one item to another place in a list.
 *
 * Its own module, and pure, because it is the part of dragging that can be wrong in ways a
 * screenshot will not show: dropping an item below its old position shifts every index between
 * them, and an off-by-one there silently mis-scores an ordering item. The component keeps only
 * the pointer bookkeeping, which needs a browser to mean anything.
 *
 * MOVE semantics, not swap. The buttons happen to be adjacent moves, where the two are the
 * same thing, but a drag across three places is not a swap with whatever happens to be there.
 */

/** `ids` with the entry at `from` lifted out and re-inserted at `to`. Out-of-range is a no-op. */
export function reorder(ids: string[], from: number, to: number): string[] {
  if (from === to) return ids;
  if (from < 0 || from >= ids.length) return ids;
  if (to < 0 || to >= ids.length) return ids;
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
