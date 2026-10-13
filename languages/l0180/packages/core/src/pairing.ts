// SPDX-License-Identifier: MIT
/**
 * Pairing things with other things: the key behind `match` and `classification`.
 *
 * Pure — no AST, no CPS — like `hottext.ts`, `textentry.ts`, `inlinechoice.ts` and `order.ts`.
 *
 * Both interactions ask the same question of the candidate: which of these does each of those
 * belong with? So both compile to the same key — a mapping over PAIRS of identifiers, written
 * `"<item> <target>"`, which is QTI's `directedPair` and its serialization. What differs is the
 * vocabulary the author writes and, in one checkable way, the shape of the answer:
 *
 * **`match` is one-to-one; `classification` is many-to-one.** Two items pairing with the same
 * target is a mistake in a matching item and the entire point of a classifying one, so it is an
 * error under `match` whose message names `classification` as the fix. That is what makes two
 * words honest rather than decorative — they differ in what they accept, not only in what they
 * draw.
 *
 * The answer lives on the item, in `assess`, exactly as an `order` element's `position` does.
 */
import { optionLabel } from "./labels.js";
import { assertAssessWords } from "./attributes.js";

/** One thing to be placed: what it says, and where it belongs. */
export interface Item {
  id?: string;
  text?: string;
  assess?: { target?: string; category?: string; points?: number; rationale?: string };
}

/** One place a thing can go — a target to match with, or a category to sort into. */
export interface Place {
  id?: string;
  text?: string;
}

/** What one pairing is worth. A choice mapping value, keyed by a pair rather than an option. */
export interface PairValue {
  correct?: true;
  points: number;
  rationale?: string;
}

export interface Paired {
  items: { id: string; text: string }[];
  places: { id: string; text: string }[];
  mapping: Record<string, PairValue>;
  correctResponse: string[];
  /** The sum of what each item's own pairing is worth. */
  points: number;
}

/**
 * What to call things, so an error reads in the vocabulary the author is writing.
 *
 * The same technique `cutMarkers` uses for a blank and a dropdown: one implementation, two
 * readerships, and nobody sorting animals into categories is told about targets.
 */
export interface PairWords {
  /** The interaction: "match", "classification". */
  container: string;
  /** The `assess` word naming where an item belongs: "target", "category". */
  key: string;
  /** The member list of places: "targets", "categories". */
  list: string;
  /** The member list of things being placed: "match-items", "classification-items". */
  itemList: string;
  /** One place, singular: "target", "category". */
  place: string;
  /** True when a place may hold only one item — matching, not classifying. */
  oneToOne: boolean;
}

/**
 * Read the places things can go: a match's targets, a classification's categories, a
 * gap-match's tokens.
 *
 * A place MUST be named by its author. Unlike an option, nothing derives usefully here: the id
 * is what something else refers to — an item's `assess`, or a gap's — so an id nobody wrote is
 * an id nobody can name.
 *
 * Shared with `gapmatch.ts`, whose bank is the same list under a different word. Its gaps are
 * not, which is why only this half is extracted: a gap has no text, being a hole in a sentence
 * rather than a thing on the page.
 */
export function readPlaces(
  places: Place[],
  words: PairWords,
): { known: Map<string, string>; resolved: { id: string; text: string }[] } {
  if (!places.length) {
    throw new Error(
      `${words.container}: needs at least one ${words.place}, e.g. ` +
        `${words.list} [[id "a" text "A"]] {}.`,
    );
  }
  if (places.length < 2) {
    throw new Error(
      `${words.container}: needs at least two ${words.list}, or there is nothing to decide ` +
        `between — every item would go in the only ${words.place} there is.`,
    );
  }

  const known = new Map<string, string>();
  const resolved = places.map((p, i) => {
    const at = `${words.container}: ${words.place} ${i + 1}`;
    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!id) {
      throw new Error(
        `${at}: needs an \`id\`, which is what an item's \`assess [${words.key} "…"]\` refers ` +
          `to — e.g. [ id "paris" text "Paris" ].`,
      );
    }
    if (known.has(id)) {
      throw new Error(`${at}: the id "${id}" is already used. Each ${words.place} needs its own.`);
    }
    const text = typeof p.text === "string" ? p.text : "";
    if (!text.trim()) {
      throw new Error(`${at}: needs the \`text\` the candidate reads.`);
    }
    known.set(id, text);
    return { id, text };
  });
  return { known, resolved };
}

/** The `assess` words an item of this kind may carry. */
const assessWords = (words: PairWords): string[] => [words.key, "points", "rationale"];

export function pair(items: Item[], places: Place[], words: PairWords): Paired {
  if (!items.length) {
    throw new Error(
      `${words.container}: needs at least one item, e.g. ` +
        `${words.itemList} [[text "France" assess [${words.key} "a"]]] {}.`,
    );
  }

  const { known, resolved } = readPlaces(places, words);

  const seenIds = new Map<string, number>();
  const taken = new Map<string, number>();
  const mapping: Record<string, PairValue> = {};
  const correctResponse: string[] = [];
  const resolvedItems: { id: string; text: string }[] = [];
  let points = 0;

  items.forEach((item, i) => {
    const at = `${words.container}: item ${i + 1}`;
    // Items are never referred to by anything the author writes, so their ids derive the way an
    // option's does. Only the places need naming.
    const id = item.id !== undefined ? String(item.id) : optionLabel(i);
    if (seenIds.has(id)) {
      throw new Error(
        `${at}: two items share the id "${id}" (items ${seenIds.get(id)} and ${i + 1}). ` +
          "Ids must be unique; omit `id` to have them derived.",
      );
    }
    seenIds.set(id, i + 1);

    const text = item.text !== undefined ? String(item.text) : "";
    if (!text.trim()) {
      throw new Error(`${at}: needs the \`text\` the candidate reads.`);
    }
    resolvedItems.push({ id, text });

    assertAssessWords(item.assess, assessWords(words), at);
    const belongs = item.assess?.[words.key as "target" | "category"];
    if (belongs === undefined) {
      throw new Error(
        `${at}: needs \`assess [${words.key} "…"]\` saying where it belongs, naming one of the ` +
          `${words.list}: ${[...known.keys()].join(", ")}.`,
      );
    }
    if (!known.has(belongs)) {
      throw new Error(
        `${at}: no ${words.place} has the id "${belongs}". ` +
          `\`${words.list}\` declares: ${[...known.keys()].join(", ")}.`,
      );
    }
    // Matching is one-to-one and classifying is not, which is the whole difference between the
    // two words. Naming the other one is the fix, so the message says it.
    const already = taken.get(belongs);
    if (words.oneToOne && already !== undefined) {
      throw new Error(
        `${at}: item ${already} already matches "${belongs}", and a match pairs each ${words.place} ` +
          "with one item. If they are meant to be shared, this is a `classification`.",
      );
    }
    taken.set(belongs, i + 1);

    const value = typeof item.assess?.points === "number" ? item.assess.points : 1;
    const rationale = item.assess?.rationale;
    const pairId = `${id} ${belongs}`;
    mapping[pairId] = {
      correct: true,
      points: value,
      ...(typeof rationale === "string" ? { rationale } : {}),
    };
    correctResponse.push(pairId);
    points += value;
  });

  return { items: resolvedItems, places: resolved, mapping, correctResponse, points };
}
