// SPDX-License-Identifier: MIT
/**
 * L0184's lexicon = L0000's base vocabulary + L0184's words.
 *
 * Properties, members and containers are generated from the tables in `attributes.ts`, so their
 * arity can never disagree with the handlers generated from the same rows. Tags are uppercase
 * and one entry per spelling.
 *
 * No base word is overridden — `mergeLexicon` is called with no `overrides`, and throws at import
 * if a word here would shadow one of L0000's (`min`, `max`, `log`, `data`, `map`, …). That is why
 * bounds are `min-value`/`max-value` and a log axis is `scale LOG`.
 */
import { lexicon as base, mergeLexicon } from "@graffiticode/l0000";
import { TAGS, chainFields, containerFields, memberFields, typeOf, wordOf } from "./attributes.js";

const fn = (name: string, arity: 1 | 2, type: string, description: string) => ({
  tk: 1,
  name,
  cls: "function",
  arity,
  type,
  description,
});

const tag = (description: string) => ({ tk: 22, name: "TAG", cls: "val", arity: 0, type: "<: tag>", description });

export const lexicon = mergeLexicon(
  base,
  {
    ...Object.fromEntries(
      Object.entries(chainFields).map(([name, meta]) => [wordOf(name), fn(name, 2, typeOf(meta, 2), meta.description)]),
    ),
    ...Object.fromEntries(
      Object.entries(memberFields).map(([name, meta]) => [wordOf(name), fn(name, 1, typeOf(meta, 1), meta.description)]),
    ),
    ...Object.fromEntries(
      Object.entries(containerFields).map(([name, c]) => [c.word, fn(name, 2, "<list record: record>", c.description)]),
    ),
    ...Object.fromEntries(Object.entries(TAGS).map(([t, d]) => [t, tag(d)])),
  },
  { langID: "L0184" },
);
