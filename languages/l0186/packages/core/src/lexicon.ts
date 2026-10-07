// SPDX-License-Identifier: MIT
/**
 * L0186's lexicon = L0000's base vocabulary + L0186's words.
 *
 * Properties, members and containers are generated from the tables in `attributes.ts`, so their
 * arity can never disagree with the handlers generated from the same rows. Tags are uppercase
 * and one entry per spelling, spelled as FigJam's own enums (`ROUNDED_RECTANGLE`, `ARROW_LINES`).
 *
 * No base word is overridden — `mergeLexicon` is called with no `overrides`, and throws at import
 * if a word here would shadow one of L0000's. The shape kind `OR` is a tag, so L0000's logical
 * `or` keeps working (L0172's shape word `or` shadowed it).
 */
import { lexicon as base, mergeLexicon } from "@graffiticode/l0000";
import { SAVE_TO_FIGJAM, TAGS, chainFields, containerFields, memberFields, typeOf, wordOf } from "./attributes.js";

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
    [SAVE_TO_FIGJAM.word]: fn(SAVE_TO_FIGJAM.name, 1, "<string: record>", SAVE_TO_FIGJAM.description),
    ...Object.fromEntries(Object.entries(TAGS).map(([t, d]) => [t, tag(d)])),
  },
  { langID: "L0186" },
);
