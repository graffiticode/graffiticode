# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                                    # all tests
NODE_OPTIONS=--experimental-vm-modules npx jest src/unparse.spec.js   # one file
NODE_OPTIONS=--experimental-vm-modules npx jest -t "pipeline"          # one test by name
npm run lint          # eslint src/
npm run lint:fix
```

`NODE_OPTIONS=--experimental-vm-modules` is required — the package is ESM (`"type": "module"`) and Jest needs it. No emulators or other services are needed; the suite is pure in-process.

## Release

`packages/parser` is **not** an npm workspace of the monorepo — the root `package.json` depends on the *published* `@graffiticode/parser`. Local edits do not affect `packages/api` or the language servers until published and reinstalled. The convention in git history is a code commit followed by a separate `Release @graffiticode/parser <version>` commit that only bumps `version` in `package.json`.

Consumers are the external **language servers** (L0002, L0166, …), not the API — `packages/api` never imports the parser. Each language server passes its own dialect lexicon.

## Public surface

`src/index.js` exports `parser` and `unparse`.

```js
await parser.parse(lang, src, lexicon, callbacks)  // → AST pool JSON; throws if lexicon is falsy
unparse(ast, dialectLexicon, options)              // → source string
await parser.reformat(lang, src, lexicon, options) // parse ∘ unparse
```

`buildParser({ main })` exists so tests can inject a fake `main.parse`; `parser` is the instance built over the real one.

**The lexicon is required and is the language.** `parse.js` hard-codes only the syntax keywords (`let`, `if/then/else`, `case/of/end`, `tag`, plus a handful of builtins). Every other word — its `name` (AST tag), `arity`, `length`, and optional `type` — comes from the lexicon. `@graffiticode/basis` supplies the shared base lexicon; a dialect lexicon is merged over it (dialect wins). An identifier found in neither the lexicon nor an enclosing `let`/lambda scope is rejected with `Undefined reference '<name>'` (`name()` in `parse.js`), so "my valid program doesn't parse" is usually a lexicon problem, not a grammar one.

## AST representation: the node pool

This is the single most important thing to understand before touching `ast.js`, `folder.js`, or `unparse.js`.

Nodes are **interned**: `Ast.intern()` hashes `tag#count#elts#coord` and reuses the id of any structurally identical node, so `elts` hold **numeric node ids**, not nested objects. Ids index `state.nodePool`. `Ast.poolToJSON()` returns the wire format — a flat map of `{ [id]: node }` reachable from the root, plus `root: <id>` (the highest id, since the root is interned last).

```js
{ "1": {...}, "2": { tag: "ADD", elts: [1, 1] }, root: 2 }
```

Consequences that bite:
- Two identical subtrees are the *same* id. Never mutate a pool node in place.
- `NUM`/`STR` nodes serialize to bare values in `poolToJSON` (`nodeToJSON`), but `IDENT`/`BOOL`/`TAG` keep `{tag, elts}`. `unparse.js` re-hydrates a tree with its own `reconstructNode`, which mirrors that switch — the two must stay in sync.
- Construction is **stack-based**: `Ast.*` constructors pop their operands off `state.nodeStack` and push the result. Order matters, and it is reversed — see `Ast.error`, which pushes `to`, `from`, `str` and pops them back into `[str, from, to]`.

## Parsing model

`src/parse.js` (~1600 lines) is a hand-written **continuation-passing state machine**, adapted from a CodeMirror mode — hence the `CodeMirror` and `window.gcexports` shims at the top, which are stubs when not in a browser.

`parser.js` seeds `state` (continuation `cc`, node stack, arg/param/expr counters and their stacks, env, node pool, errors, coords) and loops `parse(stream, state)` until `state.cc === null`. Each call runs one continuation, which returns the next; the loop ends when a continuation returns `null`, at which point `poolToJSON` is returned.

- `scanner()` produces tokens; `Env` (`env.js`) is a stack of lexicon scopes for `let` bindings and lambda params, with a hard recursion guard at depth 380.
- Counter stacks (`argcStack`, `paramcStack`, `exprcStack`) track arity while descending into nested applications; keeping their push/pop balanced is where most parser bugs live.
- A program ends at `..`. Text after the terminator is an error (`"Text after end of program."`), deliberately — see the comment at that site before relaxing it.

### Errors

`assertErr(ctx, cond, msg, coord)` pushes `{message, coord}` onto `state.errors`, adds an `ERROR` node to the AST, and throws. `parse()`'s catch-all labels any *other* stray exception `"Syntax Error"` — so a failure that is not the user's fault (a callback hitting an unreachable credential store, say) must report itself through `assertErr` or it gets misattributed to the source code.

## Folding and callbacks

`folder.js` runs during parse (from `parse.js` on `exprs` and from `Ast.foldApply`), not as a separate pass. `Folder` is a static class with a private `#table` mapping tags to visitors; it constant-folds arithmetic and applies lambdas.

`Folder.#visit` also implements the **callback hook**: if `state.callbacks[node.tag]` exists and the node has one `STR` element, the callback resolves that name and the node is replaced by the result. `GET_VAL_PRIVATE` is the deliberate exception — it is rebuilt as a 2-element node keeping name and ciphertext, because folding it to a string would leak undecrypted ciphertext into the program.

## Unparsing

`unparse.js` is a pretty-printer, not just a debug dump — `reformat` is a user-facing feature, and the specs (`unparse.spec.js`, `unparse-l0166.spec.js`) are round-trip tests: parse a source string, unparse it, compare. Notable behaviors:

- `options`: `compact` (single-line vs. indented), `indentSize`, `hints` (a `tag → string | {before, after}` map emitted as `/* … */` block comments, used for spec generation; empty hints must leave output byte-identical).
- **Pipeline formatting**: a call whose lexicon entry has `arity >= 2` and whose declared `type` mentions `rest` is treated as a pipeline step and laid out one step per line (`isPipelineStep`/`formatPipelineNode`). This is driven entirely by lexicon `type` strings parsed by `parseType`.
- Comments are C-style block comments only.

## Repo hygiene

`src/*.js~`, `src/*.ts~`, and `dist/` are stale, untracked leftovers — not build output and not imported by anything. Ignore them; `git ls-files packages/parser` lists what is real.

Style: eslint `standard` base with double quotes, semicolons, ES modules only, and required `.js` import extensions (root `.eslintrc.cjs`).
