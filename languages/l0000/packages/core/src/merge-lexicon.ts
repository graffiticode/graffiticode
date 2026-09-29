// Lexicon inheritance for child languages.
//
// A child dialect builds its vocabulary by merging its own words over L0000's:
// the merge is child-over-parent, so a child word that reuses a base name SILENTLY
// REPLACES the base function — it simply disappears from that dialect. That is
// sometimes intended (L0174 is a forms language where `min`/`max` are field-range
// attributes, not math builtins) and sometimes a bug that surfaces far from its
// cause: L0177 modelling Learnosity's `config.item_list.filter` under the bare name
// `filter` would have deleted the list `filter`, and the only symptom would have
// been a confusing arity error in unrelated programs.
//
// The distinction between the two is intent, and intent has to be written down. So:
// merge through this helper, and declare every deliberate override. An undeclared
// collision throws at import — loudly, at the point of the mistake — while a
// declared one passes and documents itself at the call site.
//
//   export const lexicon = mergeLexicon(base, additions);
//
//   export const lexicon = mergeLexicon(base, additions, {
//     overrides: ["min", "max"],  // forms dialect: field-range attrs, not math
//   });
//
// Prefer renaming to overriding. A name that mirrors more of the source vocabulary
// it maps to (`filter-restricted`, `toolbar-add`) keeps the base word available and
// still reads back to its origin; an override spends a base word permanently.
import type { Lexicon } from "./types.js";

export interface MergeLexiconOptions {
  /**
   * Base words this dialect deliberately replaces. Listing a word here is a claim
   * that the base meaning is wrong for this domain, not merely inconvenient.
   */
  overrides?: readonly string[];
  /** Language id used in the error message, e.g. "L0177". Optional. */
  langID?: string;
}

/**
 * Merge a child language's words over a base lexicon, refusing undeclared shadowing.
 *
 * @throws if `additions` reuses a base word that is not listed in `overrides`, or if
 * `overrides` names a word that is not actually being overridden (a stale entry —
 * it would otherwise sit there implying a collision that no longer exists).
 */
export function mergeLexicon(
  base: Lexicon,
  additions: Lexicon,
  { overrides = [], langID }: MergeLexiconOptions = {},
): Lexicon {
  const who = langID ? `${langID} ` : "";
  const declared = new Set(overrides);
  const colliding = Object.keys(additions).filter((k) => k in base);

  const undeclared = colliding.filter((k) => !declared.has(k));
  if (undeclared.length > 0) {
    throw new Error(
      `${who}lexicon: ${undeclared.map((k) => `"${k}"`).join(", ")} would shadow ` +
        `@graffiticode/l0000 without being declared. Rename to avoid the collision ` +
        `(preferred — mirror more of the source path, e.g. "filter" -> "filter-restricted"), ` +
        `or pass { overrides: [${undeclared.map((k) => `"${k}"`).join(", ")}] } to claim ` +
        `the word deliberately.`,
    );
  }

  const stale = overrides.filter((k) => !(k in additions && k in base));
  if (stale.length > 0) {
    throw new Error(
      `${who}lexicon: declared override${stale.length > 1 ? "s" : ""} ` +
        `${stale.map((k) => `"${k}"`).join(", ")} ${stale.length > 1 ? "do" : "does"} not ` +
        `shadow anything — remove ${stale.length > 1 ? "them" : "it"} from overrides.`,
    );
  }

  return { ...base, ...additions };
}
