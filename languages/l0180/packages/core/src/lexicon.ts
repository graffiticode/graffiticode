// SPDX-License-Identifier: MIT
/**
 * L0180's lexicon = L0000's base vocabulary + L0180's words.
 *
 * The attribute words are generated from `attributeFields` so their arity can never disagree
 * with the handlers generated from the same table. Only containers are declared by hand.
 */
import { lexicon as base, mergeLexicon } from "@graffiticode/l0000";
import { attributeFields, configFields, configTypeOf, typeOf, wordOf } from "./attributes.js";

const fn = (name: string, arity: 0 | 1 | 2, type: string, description: string) => ({
  tk: 1,
  name,
  cls: "function",
  arity,
  type,
  description,
});

const attributeWords = Object.fromEntries(
  Object.entries(attributeFields).map(([name, meta]) => [
    wordOf(name),
    fn(name, meta.flag ? 0 : 1, typeOf(meta), meta.description),
  ]),
);

/**
 * Containers, hand-written because each has a second argument role the table cannot express.
 *
 * `choice` is arity 1: it takes an attribute list and nothing else.
 *
 * `options` is arity 2 — a member list. Its elements are homogeneous children (option
 * attribute lists) rather than named properties, so it does not merge them; the second
 * argument is the container's own configuration record. Uniform even when empty, per the
 * style guide: `options [...] {}` reads as "these children, no configuration", and a word
 * that sometimes takes the slot is a rule the generator has to remember rather than apply.
 */
/**
 * Activity-level words: arity 2, chaining.
 *
 * Each takes its value and the rest of the chain, so the tail of
 * `items [...] navigation "linear" {}` builds the configuration record the member list takes as
 * its second argument. This is the whole arity-2 attribute set — keep it small, and name it in
 * instructions.md, per style guide §3.
 */
const configWords = Object.fromEntries(
  Object.entries(configFields).map(([name, meta]) => [
    wordOf(name),
    fn(name, 2, configTypeOf(meta), meta.description),
  ]),
);

const containers = {
  items: fn(
    "ITEMS",
    2,
    "<list record: record>",
    "An activity: the items a candidate works through, in order, then the activity's configuration.",
  ),
  item: fn(
    "ITEM",
    1,
    "<list: record>",
    "An item: an optional stimulus and one or more interactions scored together.",
  ),
  parts: fn(
    "PARTS",
    2,
    "<list record: record>",
    "The interactions an item is made of, in the order they are presented.",
  ),
  choice: fn(
    "CHOICE",
    1,
    "<list: record>",
    "A choice interaction: a stem and a list of options to select from.",
  ),
  options: fn(
    "OPTIONS",
    2,
    "<list record: record>",
    "The options a choice interaction offers, each an attribute list.",
  ),
  hottext: fn(
    "HOTTEXT",
    1,
    "<list: record>",
    "A hottext interaction: a passage with clickable sentences or words.",
  ),
  selections: fn(
    "SELECTIONS",
    2,
    "<list record: record>",
    "The places a hottext interaction can select, each named by a quote.",
  ),
  "text-entry": fn(
    "TEXT_ENTRY",
    1,
    "<list: record>",
    "A text-entry interaction: a sentence with blanks the candidate types into.",
  ),
  blanks: fn(
    "BLANKS",
    2,
    "<list record: record>",
    "The blanks in a text-entry's sentence, each named by the marker that positions it.",
  ),
  responses: fn(
    "RESPONSES",
    2,
    "<list record: record>",
    "The answers a blank recognizes, each with what it is worth.",
  ),
  "inline-choice": fn(
    "INLINE_CHOICE",
    1,
    "<list: record>",
    "An inline-choice interaction: a sentence with dropdowns the candidate picks from.",
  ),
  dropdowns: fn(
    "DROPDOWNS",
    2,
    "<list record: record>",
    "The dropdowns in an inline-choice's sentence, each named by the marker that positions it.",
  ),
  order: fn(
    "ORDER",
    1,
    "<list: record>",
    "An order interaction: elements the candidate puts into the right sequence.",
  ),
  elements: fn(
    "ELEMENTS",
    2,
    "<list record: record>",
    "The things an order interaction sequences, in the order they are presented.",
  ),
  match: fn(
    "MATCH",
    1,
    "<list: record>",
    "A match interaction: each item is paired with one of the targets.",
  ),
  targets: fn(
    "TARGETS",
    2,
    "<list record: record>",
    "The things a match's items are paired with, each named by an id.",
  ),
  "match-items": fn(
    "MATCH_ITEMS",
    2,
    "<list record: record>",
    "The things a match pairs off, each saying which target it belongs with.",
  ),
  classification: fn(
    "CLASSIFICATION",
    1,
    "<list: record>",
    "A classification interaction: each item is sorted into one of the categories.",
  ),
  categories: fn(
    "CATEGORIES",
    2,
    "<list record: record>",
    "The categories a classification sorts into, each named by an id.",
  ),
  "classification-items": fn(
    "CLASSIFICATION_ITEMS",
    2,
    "<list record: record>",
    "The things a classification sorts, each saying which category it belongs in.",
  ),
  "gap-match": fn(
    "GAP_MATCH",
    1,
    "<list: record>",
    "A gap-match interaction: a sentence whose gaps are filled from a shared bank of tokens.",
  ),
  tokens: fn(
    "TOKENS",
    2,
    "<list record: record>",
    "The bank a gap-match's gaps are filled from, each token named by an id.",
  ),
  gaps: fn(
    "GAPS",
    2,
    "<list record: record>",
    "The gaps in a gap-match's sentence, each named by the marker that positions it.",
  ),
  "extended-text": fn(
    "EXTENDED_TEXT",
    1,
    "<list: record>",
    "An extended-text interaction: a written response, scored by a person against a rubric.",
  ),
  rubric: fn(
    "RUBRIC",
    2,
    "<list record: record>",
    "The bands a written response is scored against, each an attribute list.",
  ),
};

export const lexicon = mergeLexicon(
  base,
  { ...attributeWords, ...configWords, ...containers },
  { langID: "L0180" },
);
