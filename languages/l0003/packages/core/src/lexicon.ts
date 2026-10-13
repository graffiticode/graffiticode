// SPDX-License-Identifier: MIT
// L0003's lexicon = L0000's base vocabulary + L0003's additions (child keys win on merge).
import { lexicon as base } from "@graffiticode/l0000";

const additions = {
  hello: { tk: 1, name: "HELLO", cls: "function", length: 1, arity: 1 },
  image: { tk: 1, name: "IMAGE", cls: "function", length: 1, arity: 1 },
  theme: { tk: 1, name: "THEME", cls: "function", length: 2, arity: 2 },
  DARK: { tk: 22, name: "TAG", cls: "val", length: 0, arity: 0 },
  LIGHT: { tk: 22, name: "TAG", cls: "val", length: 0, arity: 0 },
  id: { tk: 1, name: "ID", cls: "function", length: 2, arity: 2 },
};

export const lexicon = { ...base, ...additions };
