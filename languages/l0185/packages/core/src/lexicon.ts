// SPDX-License-Identifier: MIT
/**
 * L0185's lexicon = L0000's base vocabulary + L0185's words, generated from `stepFields` so a
 * word's arity can never disagree with its handler. Every word is arity 2.
 *
 * No base word is overridden — `mergeLexicon` throws at import if a word here would shadow one
 * of L0000's (`take`, `drop`, `filter`, `map`, `get`, `min`, `max`, …). That is why the steps are
 * `limit`, `skip`, `omit` and `where`.
 */
import { lexicon as base, mergeLexicon } from "@graffiticode/l0000";
import { TAGS, stepFields, typeOf, wordOf } from "./attributes.js";

const fn = (name: string, type: string, description: string) => ({ tk: 1, name, cls: "function", arity: 2, type, description });
const tag = (description: string) => ({ tk: 22, name: "TAG", cls: "val", arity: 0, type: "<: tag>", description });

export const lexicon = mergeLexicon(
  base,
  {
    ...Object.fromEntries(Object.entries(stepFields).map(([name, meta]) => [wordOf(name), fn(name, typeOf(meta), meta.description)])),
    ...Object.fromEntries(Object.entries(TAGS).map(([t, d]) => [t, tag(d)])),
  },
  { langID: "L0185" },
);
