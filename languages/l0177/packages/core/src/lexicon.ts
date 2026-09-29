// SPDX-License-Identifier: MIT
// L0177 lexicon — derived from vocab.ts (single source of truth). Function keywords
// are lowercase-kebab; enum TAG values are UPPERCASE-kebab (so they never collide).
//   - author-embed + members (item/widget/settings/filter-restricted/toolbar) : arity 1
//   - views + sections + every property                                       : arity 2
//   - widget-type enum values                                                  : TAG tokens
import { lexicon as base, mergeLexicon } from "@graffiticode/l0000";
import { ARITY1, VIEWS, SECTIONS, PROPERTIES, WIDGET_TAGS, GROUP_TAGS, TOK } from "./vocab.js";

const F = (name: string, arity: number) => ({ tk: 1, name, cls: "function", length: arity, arity });
const TAG = () => ({ tk: 22, name: "TAG", cls: "val", length: 0, arity: 0 });

// Members and properties share ONE namespace, and a keyword carries one arity for the
// whole dialect — the parser has no context to disambiguate, and `TOK` maps both onto
// the same Transformer method. So a word cannot be a member here and a property there,
// however well the registry scopes their FIELDS by view. Modelling activity_edit hit
// exactly this: `reference`, `status`, `save` and `settings` each already existed as a
// property or a member elsewhere, the two loops below silently overwrote each other,
// and top-level `reference "r"` began parsing as an arity-1 member.
//
// Same remedy as a base-lexicon collision: mirror more of the Learnosity path
// (`save` -> `activity-edit-save`). This assertion is what makes the clash loud.
const overlap = ARITY1.filter((k) => PROPERTIES.includes(k));
if (overlap.length > 0) {
  throw new Error(
    `L0177 vocabulary: ${overlap.map((k) => `"${k}"`).join(", ")} used as both a member ` +
      "(arity 1) and a property (arity 2). A keyword has one arity across the dialect — " +
      "mirror more of the Learnosity path on one of them (see vocab.ts).",
  );
}

const additions: Record<string, any> = {};
for (const k of ARITY1) additions[k] = F(TOK(k), 1);
for (const k of [...Object.keys(VIEWS), ...Object.keys(SECTIONS), ...PROPERTIES]) {
  additions[k] = F(TOK(k), 2);
}
for (const t of [...Object.keys(WIDGET_TAGS), ...Object.keys(GROUP_TAGS)]) additions[t] = TAG();

// The merge is child-over-parent, so an L0177 keyword that reuses a base name would
// SHADOW it silently — the base function simply disappears from the dialect. That is
// how `filter` (L0000's `<lambda list: list>`) would have vanished had
// `config.item_list.filter` been modeled under its bare Learnosity name.
//
// L0177 overrides nothing: where a Learnosity leaf name would collide, the keyword
// mirrors more of its path instead — `filter.restricted` -> `filter-restricted`,
// `toolbar.add` -> `toolbar-add`. Passing no `overrides` is the assertion that this
// stays true as coverage grows; mergeLexicon throws on the next silent collision.
export const lexicon = mergeLexicon(base, additions, { langID: "L0177" });
