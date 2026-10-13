// SPDX-License-Identifier: MIT
// @graffiticode/l0010 — the L0010 compiler core. Inherits @graffiticode/l0000.
export { Checker, Transformer, compiler } from "./compiler.js";
export { lexicon } from "./lexicon.js";

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
