// SPDX-License-Identifier: MIT
/**
 * A sentence whose holes are dropdowns: cutting it, and binding each hole to its options.
 *
 * Pure — no AST, no CPS, no compiler types — the same shape as `hottext.ts` and
 * `textentry.ts`, and for the same reason: the logic is worth testing on its own.
 *
 * The marker model is text-entry's, shared through `cutMarkers`, because a dropdown and a
 * typed blank are the same construct: a named hole that a marker positions. What differs is
 * only what fills it, and that is the whole design here — the answer to a dropdown is an
 * option the candidate SELECTED, so its key is `choice`'s (an identifier, per-option points, a
 * rationale on the option), while its position in the sentence is text-entry's.
 *
 * The two do not mix in one sentence. QTI keeps `textEntryInteraction` and
 * `inlineChoiceInteraction` apart, and a member word that took both `responses` and `options`
 * would let a blank be written half one way and half the other.
 */
import { isAnchored } from "./anchors.js";
import { assertAssessWords } from "./attributes.js";
import { optionLabel } from "./labels.js";
import { cutMarkers, type MarkerWords, type TextSegment } from "./textentry.js";

/** One option in one dropdown, already merged. */
export interface Option {
  id?: string;
  text?: string;
  assess?: { correct?: boolean; points?: number; rationale?: string };
}

/** One dropdown, already merged. */
export interface Dropdown {
  id?: string;
  options?: Option[];
}

/** What one option is worth. A choice mapping value exactly — the same word means the same thing. */
export interface OptionValue {
  correct?: true;
  points: number;
  /**
   * Why this option is wrong (or right), shown only once the candidate picks it.
   *
   * On the option rather than in a flat `feedback` map, because option ids are scoped to their
   * dropdown: "oxygen" can be `A` in one hole and `A` in the next. `choice` can keep feedback
   * flat because its ids are unique across the one interaction; here they are not, and
   * `text-entry` already settled the same question the same way.
   */
  rationale?: string;
}

/** What one dropdown is worth and what it offers. */
export interface Entry {
  /** The response is an option the candidate selected, never text they wrote. */
  baseType: "identifier";
  /** What picking this dropdown's best correct option earns. */
  points: number;
  options: Record<string, OptionValue>;
}

/** A dropdown as the browser sees it: which hole, and what is in the menu. */
export interface DropdownSegment {
  id: string;
  choice: true;
  options: { id: string; text: string; anchored?: true }[];
}

export type Segment = TextSegment | DropdownSegment;

export interface Cut {
  segments: Segment[];
  mapping: Record<string, Entry>;
}

const WORDS: MarkerWords = {
  one: "dropdown",
  list: "dropdowns",
  marker: "{{gas}}",
  sentence: "Plants absorb {{gas}} and release oxygen.",
  unit: "menu",
  fill: "be chosen for it",
};

/**
 * Read one dropdown's options into a key, applying `choice`'s rules unchanged.
 *
 * Everything asserted here — that an `assess` says what it asserts, that `correct` with no
 * `points` is worth 1, that an unassessed option is simply a distractor worth nothing — is what
 * `CHOICE` asserts about an option, and it has to stay that way. An author who can explain a
 * wrong multiple-choice option must be able to explain a wrong dropdown option the same way.
 */
function readOptions(
  d: Dropdown,
  at: string,
): { entry: Entry; menu: { id: string; text: string; anchored?: true }[] } {
  const opts = Array.isArray(d.options) ? d.options : [];
  if (!opts.length) {
    throw new Error(
      `${at}: needs at least one option, e.g. options [ [ text "oxygen" assess [ correct ] ] ] {}.`,
    );
  }

  const seen = new Map<string, number>();
  const options: Record<string, OptionValue> = {};
  const menu: { id: string; text: string; anchored?: true }[] = [];
  const correct: number[] = [];

  opts.forEach((opt, i) => {
    const id = opt.id !== undefined ? String(opt.id) : optionLabel(i);
    if (seen.has(id)) {
      throw new Error(
        `${at}: two options share the id "${id}" (options ${seen.get(id)} and ${i + 1}). ` +
          "Ids must be unique within a dropdown; omit `id` to have them derived.",
      );
    }
    seen.set(id, i + 1);
    const text = opt.text !== undefined ? String(opt.text) : "";
    if (!text.trim()) {
      throw new Error(`${at}: option ${i + 1} needs the \`text\` the candidate reads in the menu.`);
    }
    // Marked here rather than in the renderer: "All of the above" belongs last whatever else
    // is shuffled, and which phrases mean that is a rule, not a rendering detail.
    menu.push({ id, text, ...(isAnchored(text) ? { anchored: true as const } : {}) });

    const assess = opt.assess;
    if (assess === undefined) return; // a plain distractor, worth nothing and unexplained
    assertAssessWords(assess, ["correct", "points", "rationale"], `${at}: option "${id}"`);
    const isCorrect = assess.correct === true;
    const hasPoints = typeof assess.points === "number";
    const hasRationale = typeof assess.rationale === "string";
    if (!isCorrect && !hasPoints && !hasRationale) {
      throw new Error(
        `${at}: option "${id}": assess must say what it asserts — \`correct\`, \`points\`, or ` +
          '`rationale`. `assess [correct]` marks the answer; `assess [points -1]` penalizes a ' +
          'distractor; `assess [rationale "…"]` explains one.',
      );
    }
    if (!isCorrect && !hasPoints && hasRationale) {
      // Rationale alone asserts nothing about scoring, but it still has to reach the candidate,
      // so unlike `choice` — which has a separate feedback map — it needs an entry to sit in.
      options[id] = { points: 0, rationale: assess.rationale as string };
      return;
    }
    const points = hasPoints ? (assess.points as number) : 1;
    options[id] = {
      ...(isCorrect ? { correct: true as const } : {}),
      points,
      ...(hasRationale ? { rationale: assess.rationale as string } : {}),
    };
    if (isCorrect) correct.push(points);
  });

  if (!correct.length) {
    throw new Error(
      `${at}: no option is marked \`correct\`, so the dropdown cannot be scored. ` +
        "Add `assess [correct]` to the right one.",
    );
  }

  // Only one option can be selected, so the dropdown is worth its BEST correct one — not their
  // sum. `choice` sums because several options can be selected; the difference is cardinality,
  // and it is the rule `text-entry` follows over its own alternatives.
  // The menu is built here rather than re-derived from the key, because the key holds only the
  // options carrying an `assess` — a plain distractor has no entry and must still be offered.
  return { entry: { baseType: "identifier", points: Math.max(...correct), options }, menu };
}

/** Cut the text at its markers and bind each dropdown to its menu. */
export function cut(text: string, dropdowns: Dropdown[], where: string): Cut {
  const declared = new Map<string, { entry: Entry; menu: { id: string; text: string }[] }>();

  dropdowns.forEach((d, i) => {
    const at = `${where}: dropdown ${i + 1}`;
    const id = typeof d.id === "string" ? d.id.trim() : "";
    if (!id) {
      throw new Error(
        `${at}: needs an \`id\`, which is what the marker in the text refers to — ` +
          'e.g. [ id "gas" options [ [ text "oxygen" assess [ correct ] ] ] {} ] with {{gas}} ' +
          "in the text.",
      );
    }
    if (declared.has(id)) {
      throw new Error(`${at}: the id "${id}" is already used. Each dropdown needs its own.`);
    }
    declared.set(id, readOptions(d, at));
  });

  const segments = cutMarkers(text, declared, WORDS, where, (id, held) => ({
    id,
    choice: true as const,
    options: held.menu,
  }));

  return {
    segments,
    mapping: Object.fromEntries([...declared].map(([id, held]) => [id, held.entry])),
  };
}

/** Every dropdown's points, which is what the interaction is worth. */
export const totalPoints = (mapping: Record<string, Entry>): number =>
  Object.values(mapping).reduce((n, e) => n + e.points, 0);
