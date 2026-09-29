// SPDX-License-Identifier: MIT
// @graffiticode/l0176 — the L0176 compiler core. Inherits @graffiticode/l0000.
export { Checker, Transformer, compiler } from "./compiler.js";
export { lexicon, deprecatedWords } from "./lexicon.js";
export { lowerLegacySave } from "./save-lowering.js";

// Re-export the base machinery + inheritance contract from the parent language.
export { Compiler, Renderer, Visitor } from "@graffiticode/l0000";
export type {
  ASTNode,
  NodePool,
  CompileError,
  Resume,
  CompileOptions,
  LexiconEntry,
  Lexicon,
  CompilerConfig,
} from "@graffiticode/l0000";
