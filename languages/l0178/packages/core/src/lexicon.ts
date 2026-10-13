// SPDX-License-Identifier: MIT
// L0178's lexicon = L0000's base vocabulary + entries derived from vocab.ts.
// Function keywords are lowercase-kebab; enum TAG values are UPPERCASE-kebab (so the
// two can never collide).
//   - data-job                          : arity 1
//   - blocks + every property           : arity 2
//   - paging policy values              : TAG tokens
import { lexicon as base, mergeLexicon } from "@graffiticode/l0000";
import { ARITY1, BLOCKS, PROPERTIES, PAGING_TAGS, TOK } from "./vocab.js";

const F = (name: string, arity: number) => ({ tk: 1, name, cls: "function", length: arity, arity });
const TAG = () => ({ tk: 22, name: "TAG", cls: "val", length: 0, arity: 0 });

// Blocks and properties share ONE namespace, and a keyword carries one arity for the
// whole dialect — the parser has no context to disambiguate, and `TOK` maps both onto
// the same Transformer method. So a word cannot be a block here and a property there,
// however well the registry scopes their FIELDS by block. This assertion is what makes
// that clash loud instead of letting the two loops below overwrite each other.
const overlap = Object.keys(BLOCKS).filter((k) => PROPERTIES.includes(k));
if (overlap.length > 0) {
  throw new Error(
    `L0178 vocabulary: ${overlap.map((k) => `"${k}"`).join(", ")} used as both a block ` +
      "(arity 2, takes a [list]) and a property (arity 2, takes a value). Mirror more of " +
      "the endpoint path on one of them (see vocab.ts).",
  );
}

const additions: Record<string, any> = {};
for (const k of ARITY1) additions[k] = F(TOK(k), 1);
for (const k of [...Object.keys(BLOCKS), ...PROPERTIES]) additions[k] = F(TOK(k), 2);
for (const t of Object.keys(PAGING_TAGS)) additions[t] = TAG();

// The merge is child-over-parent, so an L0178 keyword that reuses a base name would
// SHADOW it silently — the base function simply disappears from the dialect, and the
// symptom surfaces as an arity error in an unrelated program.
//
// This dialect is unusually exposed to that: the Data API's own leaf names are exactly
// the words a base language wants. `data`, `get` and `set` are all taken by L0000
// already. Naming the blocks for the (endpoint, action) PAIR — `items-get`, not a bare
// `get` — is what keeps them clear, and is the same remedy L0177 used when a bare
// `filter` would have deleted L0000's list `filter`.
//
// L0178 overrides nothing. Passing no `overrides` is the assertion that this stays
// true as coverage grows; mergeLexicon throws on the next silent collision. When one
// comes, mirror more of the API path rather than inventing a term.
export const lexicon = mergeLexicon(base, additions, { langID: "L0178" });
