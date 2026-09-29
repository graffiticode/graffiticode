// SPDX-License-Identifier: MIT
import { showValue } from "./resolve.js";

/**
 * The vocabulary as data.
 *
 * Adding a word is a row in this file: the lexicon entry, the Checker method and the
 * Transformer method are all generated from it, arity included, so a word can never be
 * declared with one arity and handled with another. Never hand-write an attribute handler.
 *
 * The style is attribute lists, per `console/docs/language-authoring-style.md`: an attribute
 * word takes exactly one argument and evaluates to a single-key record, and a `[...]` list of
 * them merges into one object. Each word is the kebab-case spelling of the field it emits —
 * the 1:1 mapping is the feature, so do not invent friendlier names.
 *
 * There is ONE table. Every word in L0182 is arity 1, and nothing chains. The language had a
 * second table of arity-2 words that configured an activity from outside its brackets, and it
 * carried a trap the compiler could not see: a config word written as the last word inside an
 * item satisfied its own arity by swallowing the closing bracket, and died with "Too few
 * arguments" from the parser rather than with anything a generator could act on. There is no
 * activity now, so there is nothing to configure from outside, and the trap is gone with it.
 */

/** How a value is turned into the field it emits. */
export interface AttributeMeta {
  /** The key this word emits. Kebab-case word -> camelCase field where they differ. */
  field: string;
  /** Type asserted before the value is used. Checked in the Transformer, never the Checker — see below. */
  expects?: "string" | "number" | "refs" | "ref" | "answer" | "records";
  /** One line, shown in the generated spec. */
  description: string;
}

/**
 * One row per word. The key is the AST tag (the Transformer method name); the source spelling
 * is the key lowercased with underscores as dashes, so MIN_CHOICES is `min-choices`.
 */
export const attributeFields: Record<string, AttributeMeta> = {
  ID: {
    field: "id",
    expects: "string",
    description:
      'The survey being taken, e.g. id "civic-priorities". The options, the wording and the bounds all come from the survey itself — the program names it and nothing more. An id naming one version outright (id "civic-priorities-7") takes that version rather than drawing one.',
  },
  SESSION_ID: {
    field: "sessionId",
    expects: "string",
    description:
      'One taking of a survey. Write it exactly as `session-id get-val-public "itemId"` — it is what keeps a response with the version of the survey it answers.',
  },
  CHOICES: {
    field: "choices",
    expects: "refs",
    description:
      'The options chosen, in priority order — the order IS the ranking, first is most important. Name each one by its exact text: choices ["clean air and water" "affordable housing"]. An id in quotes works too, and a bare whole number is a position counting from 0 — but reach for those only when you can see the set, because a wrong position records the wrong option and still compiles.',
  },
  WRITE_IN: {
    field: "writeIn",
    expects: "string",
    description:
      "One new option, contributed by whoever answered. It must not repeat an option already in the set — that is what makes it new.",
  },
  RATINGS: {
    field: "ratings",
    expects: "records",
    description:
      'The answers to a rating survey, one [item … rating …] list per item: ratings [[item "The course met its goals" rating "Agree"] [item "How likely are you to recommend us?" rating 9]].',
  },
  ITEM: {
    field: "item",
    expects: "ref",
    description:
      "Which item a rating answers. Name it by its exact text; an id in quotes, or a whole-number position counting from 0, work too once you can see the survey.",
  },
  RATING: {
    field: "rating",
    expects: "answer",
    description:
      'The answer on the item\'s scale: a point\'s label ("Agree", "Very satisfied"), or the scale\'s own value as a number (9 on a 0–10 scale is 9 — never a position). An item with its own end words takes those too, and a scale with an opt-out takes its words ("Not applicable").',
  },
  COMMENT: {
    field: "comment",
    expects: "string",
    description:
      "Free text alongside a rating survey's answers, where the survey asks for a comment.",
  },
};

/** The signature string the generated spec renders, derived so it cannot drift from the row. */
export const typeOf = (meta: AttributeMeta): string =>
  meta.expects === "refs" || meta.expects === "records"
    ? "<list: record>"
    : meta.expects === "ref" || meta.expects === "answer" || !meta.expects
      ? "<any: record>"
      : `<${meta.expects}: record>`;

/**
 * Which words each container accepts, in source spelling.
 *
 * This is the highest-value check in the file, and the reason it is maintained by hand: an
 * attribute list merges whatever it is handed, so a word written one level too high lands in
 * a record nothing reads, compiles clean, and silently does not do what it says.
 */
export const validAttributes: Record<string, string[]> = {
  survey: ["id", "session-id", "response"],
  response: ["choices", "write-in", "ratings", "comment"],
  ratings: ["item", "rating"],
};

/**
 * The containers a program is built from, as opposed to `ratings`, which is a member list —
 * one attribute list per entry — rather than something a program is.
 */
export const itemTypes = ["survey", "response"];

export const wordOf = (name: string): string => name.toLowerCase().replace(/_/g, "-");

/** Containers that legitimately own each word, for the "belongs inside" hint. */
const wordOwners: Record<string, string[]> = Object.entries(validAttributes).reduce(
  (acc: Record<string, string[]>, [container, words]) => {
    for (const w of words) (acc[w] = acc[w] || []).push(container);
    return acc;
  },
  {},
);

/**
 * Unwrap L0000's internal Record representation to plain JS.
 *
 * A `{...}` literal reaching a Transformer is `{_type: "record", _entries: Map}` with keys
 * encoded `tag:`/`str:`/`num:`. L0000 does not export a reader for it, so every child
 * language carries this. Dot-access without it silently misses.
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

/**
 * Assert a value's type. Returns an error string, or null.
 *
 * This runs in the TRANSFORMER, not the Checker, and that is not a style preference:
 * `Checker.LIST` visits only `elts[0]`, so a rule written as a Checker method fires on the
 * first element of a list and nowhere else. In a style built on lists that means almost
 * never. L0166 shipped a Checker rule rejecting negative points that did nothing for exactly
 * this reason.
 */
export function checkValue(name: string, meta: AttributeMeta, raw: any): string | null {
  const word = wordOf(name);
  if (meta.expects === "refs") {
    // A reference to an option: its id as a string, or its position as a number. The two can never
    // collide — even for a set whose ids look like numbers — because the notation says which is
    // meant. Resolving them needs the options in hand, so that happens in `survey.ts`; here we only
    // reject an entry that is neither form.
    if (!Array.isArray(raw) || !raw.length) {
      return (
        `${word}: expected a list of options — each named by its text, its id, or its position, ` +
        `e.g. ${word} ["clean air and water" "affordable housing"].`
      );
    }
    const bad = raw.findIndex(
      (v) =>
        !((typeof v === "string" && v.trim()) || (typeof v === "number" && Number.isInteger(v))),
    );
    if (bad >= 0) {
      return (
        `${word}: entry ${bad + 1} is ${showValue(raw[bad])}; every entry must be an option's id ` +
        'in "quotes", or its position as a whole number.'
      );
    }
    return null;
  }
  if (meta.expects === "records") {
    // A member list: each entry is its own [item … rating …] attribute list, merged and checked
    // by `rating.ts`. Here only the shape — a list of lists — so a flat list fails with the
    // bracket it is missing rather than as a mystery further in.
    const example = `${word} [[item "…" rating "Agree"] [item "…" rating 4]]`;
    if (!Array.isArray(raw) || !raw.length) {
      return `${word}: expected a list with one [item … rating …] list per answer, e.g. ${example}.`;
    }
    const bad = raw.findIndex((v) => !Array.isArray(v));
    if (bad >= 0) {
      return (
        `${word}: entry ${bad + 1} is ${showValue(raw[bad])}; each answer is its own list in ` +
        `brackets, e.g. ${example}.`
      );
    }
    return null;
  }
  if (meta.expects === "ref") {
    // One entry named the way `choices` names an option: text or id in quotes, or a position.
    if (
      (typeof raw === "string" && raw.trim()) ||
      (typeof raw === "number" && Number.isInteger(raw))
    ) {
      return null;
    }
    return `${word}: expected an item's text in "quotes" (or its id, or its position as a whole number), got ${showValue(raw)}.`;
  }
  if (meta.expects === "answer") {
    if (
      (typeof raw === "string" && raw.trim()) ||
      (typeof raw === "number" && Number.isFinite(raw))
    ) {
      return null;
    }
    return `${word}: expected a label in "quotes" or a number on the scale, got ${showValue(raw)}.`;
  }
  if (!meta.expects) return null;
  const actual = typeof raw;
  if (meta.expects === "number" && (actual !== "number" || !Number.isFinite(raw))) {
    return `${word}: expected a number, got ${showValue(raw)}.`;
  }
  if (meta.expects === "string" && actual !== "string") {
    return `${word}: expected a string in "quotes", got ${showValue(raw)}.`;
  }
  return null;
}

/**
 * Fold an attribute list into one object. A malformed entry is a compile error, never a
 * silent drop — a dropped attribute is indistinguishable from one that did nothing.
 */
export function mergeAttributes(attrs: any, where: string): Record<string, any> {
  if (!Array.isArray(attrs)) {
    throw new Error(
      `${where}: expected an attribute list in [brackets], e.g. [id "team-retro" session-id get-val-public "itemId"].`,
    );
  }
  const out: Record<string, any> = {};
  for (const a of attrs) {
    if (a === null || typeof a !== "object" || Array.isArray(a)) {
      throw new Error(
        `${where}: every entry must be an attribute applied to a value, e.g. [id "team-retro"]. ` +
          `Got ${showValue(a)}.`,
      );
    }
    for (const k of Object.keys(a)) {
      if (Object.prototype.hasOwnProperty.call(out, k)) {
        throw new Error(
          `${where}: \`${fieldWord(k)}\` is given twice. Each attribute may appear once.`,
        );
      }
      out[k] = a[k];
    }
  }
  return out;
}

/** Map an emitted field back to its source spelling (minChoices -> min-choices). */
const fieldToWord: Record<string, string> = Object.entries(attributeFields).reduce(
  (acc: Record<string, string>, [name, meta]) => {
    acc[meta.field] = wordOf(name);
    return acc;
  },
  // Container words are not rows in the table, but they must still be nameable when a
  // container rejects one of them.
  { survey: "survey", response: "response" },
);
const fieldWord = (field: string): string => fieldToWord[field] || field;

/**
 * Reject a word the container does not accept, naming the legal set and — the half that
 * actually fixes the program — where the misplaced word belongs.
 *
 * The generator is an LLM that reads this message and tries again, so the wording is a
 * product surface, not a diagnostic. L0176's equivalent took a deterministic failure to a
 * reliable pass, permanently and for every model.
 */
export function assertKnownAttributes(container: string, attrs: Record<string, any>): void {
  const allowed = validAttributes[container];
  if (!allowed) return;
  const unknown = Object.keys(attrs)
    .map(fieldWord)
    .filter((w) => !allowed.includes(w));
  if (!unknown.length) return;
  const hints = unknown
    .map((w) => {
      const owners = (wordOwners[w] || []).filter((o) => o !== container);
      return owners.length ? ` \`${w}\` belongs inside \`${owners[0]}\`.` : "";
    })
    .join("");
  throw new Error(
    `${container}: ${unknown.map((u) => `\`${u}\``).join(", ")} ` +
      `${unknown.length === 1 ? "is not an attribute" : "are not attributes"} of ${container}. ` +
      `It takes: ${allowed.join(", ")}.${hints}`,
  );
}
