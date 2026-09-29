// SPDX-License-Identifier: MIT
// @graffiticode/l0179 — the L0179 compiler core. Inherits @graffiticode/l0000.
export { Checker, Transformer, compiler } from "./compiler.js";
export { lexicon } from "./lexicon.js";
export { attributeFields, validAttributes, mergeAttributes, assertKnownAttributes } from "./attributes.js";

// Re-export the base machinery + inheritance contract from the parent language.
export { Compiler, Renderer, Visitor } from "@graffiticode/l0000";
