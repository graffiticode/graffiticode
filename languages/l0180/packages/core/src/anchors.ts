// SPDX-License-Identifier: MIT
/**
 * Which lists must not be randomized, and which options must stay put inside one.
 *
 * Randomizing option order is the default because a fixed one is a scoring artifact: position
 * bias is real, and a key that sits in the same slot across an activity is learnable. But
 * randomizing is wrong wherever position carries information, and an author who does not notice
 * ships a worse item than they wrote. These are the two cases where it does.
 *
 * Both rules are advisory in one direction only: they decide what happens when the author said
 * nothing. An explicit `shuffle` always wins, in either direction.
 *
 * Pure — no AST, no CPS, no DOM — like `hottext.ts` and `matching.ts`.
 */
import { parseNumber } from "./matching.js";

/** Case, punctuation and spacing stop mattering, so "All of the above." matches. */
const norm = (s: string): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * The closed set of phrases that only make sense at the end of a list.
 *
 * A closed set rather than a pattern, because the failure it prevents is a plausible phrase
 * being pinned by accident. "None of these apply" is a real answer to a real question and must
 * shuffle like any other; "all of the following" belongs in a stem, not an option. Both are
 * near-misses that a looser rule would catch.
 *
 * English-only, which is the limit the generator already has — a `create_item` description must
 * be written in English even when the item's content is not.
 */
const ANCHORS = new Set([
  "all of the above",
  "none of the above",
  "both of the above",
  "all of these",
  "none of these",
  "both of these",
  "all of the answers above",
  "none of the answers above",
]);

/** True when this option reads as one that belongs last whatever else is shuffled. */
export const isAnchored = (text: string): boolean => ANCHORS.has(norm(text));

const TRUE_FALSE = [
  ["true", "false"],
  ["yes", "no"],
];

/**
 * True when the LIST itself is ordered, so its order is information rather than an accident.
 *
 * Two cases, both conventions of item writing rather than inventions here:
 *
 * - **Numbers in sorted order.** "Which is prime: 2, 4, 5, 9, 11" reads as a set the candidate
 *   scans; scrambled to "9, 2, 11, 4, 5" it reads as a trick. Ascending or descending — either
 *   is a deliberate order, and only an unsorted list is evidence that nobody chose one.
 * - **True/false, and yes/no.** A two-option item whose options are these is conventionally
 *   written in that order, and reversed it looks like a mistake rather than a randomization.
 *
 * Evaluate it over the options that are NOT anchored: a numeric list ending in "None of the
 * above" is still a numeric list, and the anchor is handled separately.
 */
export function keepsOrder(texts: string[]): boolean {
  if (texts.length < 2) return true;

  const lower = texts.map((t) => norm(t));
  if (TRUE_FALSE.some((pair) => lower.length === 2 && lower[0] === pair[0] && lower[1] === pair[1])) {
    return true;
  }

  const numbers = texts.map((t) => parseNumber(t));
  if (numbers.some((n) => n === null)) return false;
  const ascending = numbers.every((n, i) => i === 0 || n!.value.gt(numbers[i - 1]!.value));
  const descending = numbers.every((n, i) => i === 0 || n!.value.lt(numbers[i - 1]!.value));
  return ascending || descending;
}
