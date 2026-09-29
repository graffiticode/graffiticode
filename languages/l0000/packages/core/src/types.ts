// The L0000 inheritance contract: the TypeScript surface every Graffiticode language
// shares. Child-language cores extend the `Checker`/`Transformer` classes (see compiler.ts)
// and their handlers operate on these shapes.

/** A node id within a NodePool, or an inline node object. */
export type Nid = number | string;

/** A single AST node. Word-handlers are dispatched by `tag` (e.g. "HELLO", "THEME"). */
export interface ASTNode {
  tag: string;
  elts: any[];
  coord?: { from: number; to: number };
}

/**
 * The AST as a flat pool of nodes keyed by id, with `root` pointing at the entry node.
 * This is the `code` argument passed to a Compiler/Visitor.
 */
export type NodePool = { root: Nid } & Record<string | number, any>;

/** A normalized compile error. `from`/`to` are source offsets (-1 when unknown). */
export interface CompileError {
  message: string;
  from: number;
  to: number;
}

/** Continuation-passing callback used throughout the compiler. */
export type Resume<T = any> = (err: CompileError[] | null | undefined | any, val?: T) => void;

/** Options threaded through check/transform/render (carries `data`, `config`, etc.). */
export interface CompileOptions {
  data?: any;
  config?: any;
  result?: any;
  SYNC?: boolean;
  [key: string]: any;
}

/** A lexicon entry: maps a surface word to its handler tag (`name`) and signature. */
export interface LexiconEntry {
  tk: number;
  name: string;
  cls: string;
  arity: number;
  type: string;
  description?: string;
  [key: string]: any;
}

/** A language's vocabulary: surface word -> entry. Merged child-over-parent on inherit. */
export type Lexicon = Record<string, LexiconEntry>;

/** Construction config for a Compiler — supply a language's Checker/Transformer subclasses. */
export interface CompilerConfig {
  langID: string;
  version?: string;
  Checker?: new (code: NodePool) => any;
  Transformer?: new (code: NodePool) => any;
  Renderer?: new (data: any) => any;
  protectedFunctions?: import("./protected-functions.js").ProtectedFunctions;
  implicitProtectedFunctions?: import("./protected-functions.js").ProtectedFunctionSpec[];
  policy?: import("./protected-functions.js").PolicyClient;
}
