// SPDX-License-Identifier: MIT
// @graffiticode/l0175 — the L0175 compiler core. Inherits @graffiticode/l0000.
export { Checker, Transformer, compiler } from "./compiler.js";
export { lexicon } from "./lexicon.js";
export {
  stripReadingPassage,
  buildSignatureTags,
  buildSignatureFromSource,
  extractQueryFacets,
  buildEmbeddingArtifacts,
} from "./embedding.js";
export type {
  PassageRef,
  DesignFacets,
  SignatureResult,
  EmbeddingArtifacts,
} from "./embedding.js";
export { verifyExample } from "./verify-example.js";
export type { ExampleExpectation, VerifyResult } from "./verify-example.js";
export { TARGETS_DATA, STANDARD_FAMILIES, taskModelNumber } from "./targets.js";
export type { TargetData, StandardFamily } from "./targets.js";

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
