// SPDX-License-Identifier: MIT
// L0010's lexicon = L0000's base vocabulary + L0010's additions (child keys win on merge).
import { lexicon as base } from "@graffiticode/l0000";

// L0010 dialect vocabulary. `plan` takes a list of language-id strings and
// evaluates to { langs: [...] } — the ordered composition sequence.
const additions = {
  plan: { tk: 1, name: "PLAN", cls: "function", length: 1, arity: 1 },
};

export const lexicon = { ...base, ...additions };
