// SPDX-License-Identifier: MIT
export { Checker, Transformer, compiler } from "./compiler.js";
export { lexicon } from "./lexicon.js";
export {
  attributeFields,
  configFields,
  validAttributes,
  validSettings,
  wordOf,
  toPlainObject,
  SHAPES,
  COLORS,
  SIZES,
  EDGE_STYLES,
  TRAY_PLACEMENTS,
} from "./attributes.js";
export type { AttributeMeta } from "./attributes.js";
export { buildWeb, HUB_ID } from "./web.js";
export type { CellKey, Compiled, Tray, TrayItem, WebEdge, WebNode } from "./web.js";
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
