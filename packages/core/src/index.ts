// @graffiticode/l0000 — the root Graffiticode language and the inheritance contract.
//
// A child language's core extends these classes:
//   import { Checker, Transformer, Compiler } from "@graffiticode/l0000";
//   class MyChecker extends Checker { HELLO(node, options, resume) { ... } }
// and merges its lexicon over `lexicon` with `mergeLexicon`, which refuses to let a
// child word shadow a base one unless the override is declared.

export { Visitor, Checker, Transformer, Renderer, Compiler } from "./compiler.js";
export { ExecContext, execContextOf } from "./exec-context.js";
export type { ExecIdentity, ProtectedCall, Invoker } from "./exec-context.js";
export { findProtectedNodes, parseSnapshot } from "./protected-functions.js";
export { createProtectionClient, ProtectedCallError, POLICY_AUDIENCE, BROKER_AUDIENCE } from "./protected-client.js";
export type { ProtectionClientOptions } from "./protected-client.js";
export { canonicalJSON, argsDigest } from "./canonical.js";
export type {
  ProtectedFunctionKind,
  ProtectedFunctionSpec,
  ProtectedFunctions,
  PolicySnapshot,
  PolicyClient,
} from "./protected-functions.js";
export { lexicon } from "./lexicon.js";
export { mergeLexicon } from "./merge-lexicon.js";
export type { MergeLexiconOptions } from "./merge-lexicon.js";
export {
  validateAgainstSchema,
  getLanguageSchema,
  setSchemaFetcher,
  clearSchemaCache,
} from "./schema-validator.js";
export { assert, message, messages, reserveCodeRange } from "./share.js";

export type {
  Nid,
  ASTNode,
  NodePool,
  CompileError,
  Resume,
  CompileOptions,
  LexiconEntry,
  Lexicon,
  CompilerConfig,
} from "./types.js";
