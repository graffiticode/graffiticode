// SPDX-License-Identifier: MIT
export { Checker, Transformer, compiler } from "./compiler.js";
export { lexicon } from "./lexicon.js";
export {
  chainFields,
  memberFields,
  containerFields,
  validAttributes,
  validSettings,
  plotKindAttributes,
  labelPositions,
  containerParts,
  TAGS,
  wordOf,
  toPlainObject,
} from "./attributes.js";
export type { AttributeMeta } from "./attributes.js";
export { buildCollection } from "./collection.js";
export type { Envelope } from "./collection.js";
export type { CompiledChart } from "./chart.js";
export { normalizeRows, fromIndexed } from "./data.js";
export type { Dataset } from "./data.js";
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
