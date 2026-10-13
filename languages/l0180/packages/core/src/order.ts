// SPDX-License-Identifier: MIT
/**
 * Sequencing: the elements the candidate puts in the right order.
 *
 * Pure — no AST, no CPS — like `hottext.ts`, `textentry.ts` and `inlinechoice.ts`.
 *
 * **The authored order is the order the candidate SEES, and each element says where it
 * belongs.** That is the whole design, and it is forced. If the author listed the elements
 * correctly and the compiler emitted them as authored, the answer would ship inside
 * `interaction` — and a graded delivery that withholds `validation` would still be handing the
 * browser the key in array order. Shuffling at compile time is no way out either: a
 * deterministic scramble is invertible by anyone who knows the rule, and a random one would
 * reshuffle under the candidate on every recompile, because `PROG` recompiles on each response.
 *
 * So `assess [ position 2 ]` — key material inside `assess`, exactly where `correct` sits on an
 * option, a selection and a recognized answer.
 */
import { assertAssessWords } from "./attributes.js";
import { optionLabel } from "./labels.js";

/** One thing to be placed, already merged. */
export interface Element {
  id?: string;
  text?: string;
  assess?: { correct?: boolean; points?: number; rationale?: string; position?: number };
}

export interface Sequenced {
  /** The elements as presented — authored order, and nothing about where anything belongs. */
  elements: { id: string; text: string }[];
  /** The ids in the right order. QTI's correctResponse for an ordered response variable. */
  correctResponse: string[];
  /**
   * Groups of ids that say the same thing, and so are interchangeable in the answer.
   *
   * "Put the words in order to make a sentence" over *the / cat / sat / on / the / mat* has two
   * elements reading "the". They are different ids, so a candidate who happens to drag the
   * second one into first place builds the identical sentence and, compared id by id, gets
   * nothing for it — a right answer marked wrong in silence, which is the failure this language
   * spends most of its rules avoiding.
   *
   * Present only when a text repeats, so the common key is unchanged and this appears exactly
   * when it means something. Matching is exact after trimming, and case matters: "The" and
   * "the" are NOT interchangeable, because swapping them would capitalize the wrong word.
   */
  interchangeable?: string[][];
}

export function sequence(elements: Element[], where: string): Sequenced {
  if (elements.length < 2) {
    throw new Error(
      `${where}: needs at least two elements — one thing is already in order. ` +
        'e.g. elements [[text "First" assess [position 1]] [text "Second" assess [position 2]]] {}.',
    );
  }

  const seen = new Map<string, number>();
  const presented: { id: string; text: string }[] = [];
  const claimed = new Map<number, number>();

  elements.forEach((el, i) => {
    const at = `${where}: element ${i + 1}`;
    const id = el.id !== undefined ? String(el.id) : optionLabel(i);
    if (seen.has(id)) {
      throw new Error(
        `${at}: two elements share the id "${id}" (elements ${seen.get(id)} and ${i + 1}). ` +
          "Ids must be unique; omit `id` to have them derived.",
      );
    }
    seen.set(id, i + 1);

    const text = el.text !== undefined ? String(el.text) : "";
    if (!text.trim()) {
      throw new Error(`${at}: needs the \`text\` the candidate reads and moves.`);
    }
    presented.push({ id, text });

    assertAssessWords(el.assess, ["position"], at);
    const position = el.assess?.position;
    if (position === undefined) {
      throw new Error(
        `${at}: needs \`assess [position N]\` saying where it belongs in the right sequence, ` +
          `counting from 1. Every element needs one — the order they are written here is the ` +
          "order the candidate sees, not the answer.",
      );
    }
    if (!Number.isInteger(position)) {
      throw new Error(`${at}: position ${position} is not a whole number. Positions count 1, 2, 3…`);
    }
    if (position < 1 || position > elements.length) {
      throw new Error(
        `${at}: position ${position} is outside 1…${elements.length}, and there are ` +
          `${elements.length} elements to place.`,
      );
    }
    const prior = claimed.get(position);
    if (prior !== undefined) {
      throw new Error(
        `${at}: position ${position} is already taken by element ${prior}. ` +
          "Each element holds one place in the sequence.",
      );
    }
    claimed.set(position, i + 1);
  });

  // Positions are unique, whole, and within 1…n over n elements, so they are a permutation and
  // no gap is possible. Nothing to check for one.
  const correctResponse = [...claimed.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, at]) => presented[at - 1].id);

  const byText = new Map<string, string[]>();
  for (const el of presented) {
    const key = el.text.trim();
    byText.set(key, [...(byText.get(key) ?? []), el.id]);
  }
  const interchangeable = [...byText.values()].filter((ids) => ids.length > 1);

  return {
    elements: presented,
    correctResponse,
    ...(interchangeable.length ? { interchangeable } : {}),
  };
}
