// SPDX-License-Identifier: MIT
/**
 * Turning the authored deck into cards, and saying so when it cannot be turned.
 *
 * Kept out of the compiler because this is where every L0181 error message comes from, and
 * because it is pure: given the value the Transformer already resolved, it either returns the
 * cards or returns the sentence explaining what is wrong with them.
 */

/** One card as the renderer receives it. `front` is the prompt; `back` is the answer. */
export interface Card {
  id: number;
  front: string;
  back: string;
}

/**
 * Inside the Transformer a record is still L0000's internal `Record` — `{_type, _entries:
 * Map}` with keys encoded `tag:`/`str:`/`num:` — and only the Renderer flattens it. Anything
 * spread into an emitted value has to come through here first.
 */
export function toPlainObject(val: any): any {
  if (
    val !== null &&
    typeof val === "object" &&
    val._type === "record" &&
    val._entries instanceof Map
  ) {
    const obj: any = {};
    for (const [k, v] of val._entries) {
      obj[(k as string).replace(/^(tag|str|num):/, "")] = toPlainObject(v);
    }
    return obj;
  }
  if (Array.isArray(val)) return val.map(toPlainObject);
  return val;
}

/** Name a bad value the way its author wrote it, so the message points at the mistake. */
function show(val: any): string {
  if (typeof val === "string") return JSON.stringify(val);
  if (Array.isArray(val)) return `a list of ${val.length}`;
  if (val === null || val === undefined) return "nothing";
  if (typeof val === "object") return "a record";
  return String(val);
}

const FORM = 'cards [["hola" "hello"] ["adiós" "goodbye"]] {}';

/**
 * Validate and number the deck.
 *
 * L0159 did none of this: a malformed deck compiled clean and threw in the browser, so the
 * author saw a blank card instead of a sentence naming the pair that was wrong.
 */
export function cardsFromPairs(val: any): { cards?: Card[]; error?: string } {
  const pairs = toPlainObject(val);
  if (!Array.isArray(pairs)) {
    return { error: `cards: expected a list of pairs, e.g. ${FORM}. Got ${show(pairs)}.` };
  }
  if (pairs.length === 0) {
    return { error: `cards: the deck is empty. Give it at least one pair, e.g. ${FORM}.` };
  }
  const cards: Card[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const where = `cards: pair ${i + 1}`;
    if (!Array.isArray(pair)) {
      return { error: `${where} is ${show(pair)}, not a ["front" "back"] pair.` };
    }
    if (pair.length !== 2) {
      return {
        error: `${where} has ${pair.length} element${pair.length === 1 ? "" : "s"}; a card needs exactly two — a front and a back.`,
      };
    }
    const [front, back] = pair;
    if (typeof front !== "string" || typeof back !== "string") {
      const bad = typeof front !== "string" ? `front is ${show(front)}` : `back is ${show(back)}`;
      return { error: `${where}: both sides must be strings, but its ${bad}.` };
    }
    cards.push({ id: i, front, back });
  }
  return { cards };
}

/** A one-field attribute word's value check. */
export function asString(word: string, val: any, example: string): string | { error: string } {
  const raw = toPlainObject(val);
  if (typeof raw !== "string") {
    return { error: `${word}: expected a string, e.g. ${example}. Got ${show(raw)}.` };
  }
  return raw;
}
