// SPDX-License-Identifier: MIT
/**
 * L0181's lexicon = L0000's base vocabulary + L0181's words.
 *
 * Every L0181 word is arity 2 and takes `(value, record)`, contributing one field to the
 * record it is handed. That is what lets the whole program be one chain: `cards` takes the
 * deck and then the chain of everything else, which terminates in a record literal.
 *
 * `mergeLexicon` throws at import if one of these shadows a base word without being declared
 * an override. None of them do — L0000's 45 words are arithmetic, list and record primitives,
 * and `cards`/`title`/`instructions`/`theme` are all new.
 */
import { lexicon as base, mergeLexicon } from "@graffiticode/l0000";

const fn = (name: string, arity: 1 | 2, type: string, description: string) => ({
  tk: 1,
  name,
  cls: "function",
  arity,
  type,
  description,
});

/** A tag value, written bare: `theme DARK`. */
const tag = (description: string) => ({
  tk: 22,
  name: "TAG",
  cls: "val",
  arity: 0,
  type: "<: tag>",
  description,
});

const additions = {
  cards: fn(
    "CARDS",
    2,
    "<list record: record>",
    'The deck: a list of two-element ["front" "back"] pairs, then the deck\'s configuration.',
  ),
  title: fn("TITLE", 2, "<string record: record>", "The deck's title."),
  instructions: fn("INSTRUCTIONS", 2, "<string record: record>", "Guidance shown above the deck."),
  theme: fn("THEME", 2, "<tag record: record>", "The UI theme — DARK or LIGHT."),
  DARK: tag("The dark theme."),
  LIGHT: tag("The light theme."),
};

export const lexicon = mergeLexicon(base, additions, { langID: "L0181" });
