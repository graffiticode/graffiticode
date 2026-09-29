// SPDX-License-Identifier: MIT
/**
 * How a response names something the survey holds — an option in `choices`, a question in
 * `item` — shared by both styles so the two notations cannot drift apart.
 *
 * Three notations, because three different callers need three different things:
 *
 * - **Its text.** The only one that works for whoever answers. The survey lives in its data, so it
 *   does not exist in the program until the program compiles — which means whoever writes the
 *   response, a person or the code generator, has never seen the ids or the positions. Without
 *   this the generator guesses, and a guess that lands in range compiles clean and records the
 *   wrong answer. That is not hypothetical: it shipped, and this is the fix.
 * - **Its id.** What a client that already read the compiled survey should use — it is the key
 *   the originating service knows, and it survives the survey being reordered.
 * - **Its position**, 0-based, matching the ids the language derives when the data has none.
 *
 * A number is always a position and a string is never one, so those cannot collide. Between the
 * two string forms, an id wins: it is the canonical key, and an id that also reads as another
 * entry's text is a survey that has bigger problems.
 */

/** Anything a response can name: an option, or a rated item. */
export interface Named {
  id: string;
  text: string;
}

/** Name a bad value the way its author wrote it, so the message points at the mistake. */
export const showValue = (v: any): string => {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "a record";
  return String(v);
};

/** Loosen a text match: trim, fold case, collapse whitespace. */
export const normaliseText = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * How a reference finds its entry.
 *
 * Built once per response, because text matching needs to know when a key is ambiguous rather
 * than discovering it per lookup.
 */
export interface Index<T extends Named> {
  list: T[];
  byId: Map<string, T>;
  /** Normalised text -> the entry, or null when more than one entry normalises to it. */
  byText: Map<string, T | null>;
}

export function indexOf<T extends Named>(list: T[]): Index<T> {
  const byId = new Map(list.map((x) => [x.id, x]));
  const byText = new Map<string, T | null>();
  for (const x of list) {
    const key = normaliseText(x.text);
    byText.set(key, byText.has(key) ? null : x);
  }
  return { list, byId, byText };
}

/**
 * Resolve one reference to the entry it names. `where` prefixes every message; `noun` is what
 * the survey holds ("option", "item"), so the message reads in the survey's own terms.
 */
export function resolveRef<T extends Named>(
  ref: string | number,
  where: string,
  index: Index<T>,
  noun: string,
): T {
  const { list } = index;

  if (typeof ref === "number") {
    if (ref < 0 || ref >= list.length) {
      throw new Error(
        `${where} is the position ${ref}, but this survey has ${list.length} ${noun}s. ` +
          `Positions count from 0, so the last one is ${list.length - 1}.`,
      );
    }
    return list[ref];
  }

  const byId = index.byId.get(ref);
  if (byId) return byId;

  const key = normaliseText(ref);
  if (index.byText.has(key)) {
    const found = index.byText.get(key);
    if (found) return found;
    throw new Error(
      `${where} is ${JSON.stringify(ref)}, which is the text of more than one ${noun} in this ` +
        `survey, so it does not say which. Name the ${noun}'s id instead.`,
    );
  }

  throw new Error(
    `${where} is ${JSON.stringify(ref)}, which is not an ${noun} in this survey. Name an ${noun} ` +
      `by its exact text, by its id (${list.map((x) => x.id).join(", ")}), or by its ` +
      "position counting from 0.",
  );
}
