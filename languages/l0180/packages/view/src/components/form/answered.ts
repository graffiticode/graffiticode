// SPDX-License-Identifier: MIT
/**
 * Whether an interaction has been answered.
 *
 * Extracted from `ItemView`, which needs it per part, because `ActivityView` needs the same
 * question one level up and a second copy would drift: a new interaction type whose response is
 * a partly-filled list would be complete for one caller and incomplete for the other, and a
 * result would show or not show depending on which level asked.
 *
 * The rule is not "the key is present". Several interactions answer with a container that
 * exists from the first click — a map of typed blanks, a list of pairings — so a half-finished
 * response is a SHORT one rather than an absent one, and each of those has to be counted
 * against the holes the interaction actually has. Nothing here reads `validation`: whether a
 * candidate has responded is a fact about the response, not about the key, and a graded
 * delivery that withholds the key still has to know when the item is done.
 */

/** True when the response fills every hole the interaction presents. */
export function isAnswered(interaction: any, response: unknown): boolean {
  if (!interaction) return false;

  // An item is answered when every one of its parts is.
  if (interaction.type === "item") {
    const parts = interaction.parts ?? [];
    const given = response !== null && typeof response === "object" ? (response as any) : {};
    return parts.length > 0 && parts.every((p: any) => isAnswered(p, given[p.id]));
  }

  const r = response;
  if (Array.isArray(r) && r.length > 0 && interaction.type !== "match" &&
      interaction.type !== "classification" && interaction.type !== "gap-match") {
    return true;
  }
  // A written response that is only whitespace has not been answered.
  if (typeof r === "string") return r.trim().length > 0;

  // A text-entry answers with a map of blank id to typed text. The response alone cannot say
  // whether it is complete — an untouched blank is simply absent — so count against the blanks
  // the part actually has.
  if (interaction.type === "text-entry") {
    const blanks = (interaction.segments ?? []).filter((s: any) => s.blank).length;
    const filled = Object.values((r ?? {}) as any).filter(
      (v) => typeof v === "string" && v.trim().length > 0,
    ).length;
    return blanks > 0 && filled === blanks;
  }
  // A pairing answers with one pair per item, so a half-finished one is a short array rather
  // than an absent key — count against the items the part actually has.
  if (interaction.type === "match" || interaction.type === "classification") {
    const rows = (interaction.items ?? []).length;
    return rows > 0 && Array.isArray(r) && r.length === rows;
  }
  // The same, counted against the gaps in the sentence.
  if (interaction.type === "gap-match") {
    const holes = (interaction.segments ?? []).filter((s: any) => s.gap).length;
    return holes > 0 && Array.isArray(r) && r.length === holes;
  }
  // An inline-choice answers the same way, with a list of one per dropdown rather than typed
  // text. Same reason it needs counting: an untouched menu is simply absent.
  if (interaction.type === "inline-choice") {
    const menus = (interaction.segments ?? []).filter((s: any) => s.choice).length;
    const picked = Object.values((r ?? {}) as any).filter((v) =>
      Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.length > 0,
    ).length;
    return menus > 0 && picked === menus;
  }
  if (Array.isArray(r)) return r.length > 0;
  return r !== undefined && r !== null;
}
