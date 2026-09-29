<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Graffiticode Usage Guide

Graffiticode is an open-ended platform of domain-specific tools, each implemented as a small functional dialect that compiles to a runnable artifact (an HTML page, a Learnosity question, a spreadsheet, a chart, …). Every dialect is built on the same base library — referred to as **basis** — which supplies the shared syntax, evaluation model, and built-in functions. This guide is for two audiences: humans authoring Graffiticode programs directly, and AI agents (such as the Graffiticode MCP tools) that translate natural-language requests into a dialect.

If you arrived here looking for "how do I make X" — you almost certainly want a specific dialect's usage guide, not this one. Start with `list_languages` in the MCP tool, then read the matching `usage-guide.md` for the dialect that fits your task. This guide explains what every dialect inherits.

## Overview

L0000 is the root Graffiticode language — the base every dialect inherits from. It defines the shared syntax (`let` bindings, lambdas, records, tags, lists, comments), an immutable evaluation model, and the base library: arithmetic, string and list operations, records and tags, pattern matching, comparisons, `map`/`filter`/`reduce`, and `data`/`use` for referencing an upstream task's output. A child language extends L0000's compiler (its `Checker`/`Transformer`) and merges its own vocabulary on top, so everything documented here is available in every dialect. On its own, L0000 evaluates a closed functional program and renders the result as JSON.

## How Graffiticode is organized

- **Dialects** (L0002, L0158, L0166, …) are the products you interact with. Each one has its own vocabulary, its own renderer, and its own usage guide. A dialect is the "domain" of Graffiticode: spreadsheets, Learnosity items, charts, FigJam content, and so on.
- **basis** is the substrate every dialect imports. It contributes:
  - The grammar (how `let`, `case`, lambdas, records, tags, comments are written).
  - The evaluation model (lazy where it can be, immutable always).
  - The base library: arithmetic, strings, lists, records, tags, lambdas, pattern matching, comparison, `map` / `filter` / `reduce`, `data`, `use`, and so on.
  - The compiler and the visitor framework dialects extend.
- **The MCP tool** routes a natural-language request to the right dialect, asks that dialect's code-generation backend to produce a program, posts it for compilation, and returns the result. End users don't usually write Graffiticode by hand — they describe what they want, and the dialect's agent does the rest.

## Program structure

Every Graffiticode program in every dialect has the same shape:

```
let name1 = value1..
let name2 = value2..
expression..
```

- Zero or more `let` declarations bind names to values. Each `let` is terminated with `..`.
- One or more top-level expressions follow, forming an expression block. They are evaluated in order and the last one produces the program's result. Consecutive expressions are written with no separator between them; only the last carries the `..`.
- Block comments are `/* ... */`. There is no line-comment syntax.

The terminator `..` is mandatory. Bare expressions without `..` will not parse.
It ends the program as a whole, so it belongs only at the very end (and after
each `let`) — text after it is discarded silently rather than flagged.

## Core syntax

| Concept | Form | Example |
| :--- | :--- | :--- |
| Numbers | literal | `42`, `3.14`, `-1` |
| Strings | double-quoted | `"hello"` |
| Booleans | keywords | `true`, `false` |
| Lists | space-separated, square brackets | `[1 2 3]` (not `[1, 2, 3]`) |
| Records | comma-separated, curly braces | `{x: 1, y: 2}` |
| Tags | `tag` keyword | `tag red`, `tag DARK` |
| Lambdas | angle-bracket notation | `<x: add x 1>`, `<x y: add x y>` |
| Let bindings | `let name = value..` | `let double = <x: mul 2 x>..` |
| Function application | prefix, space-separated | `add 1 2`, `map (double) [1 2 3]` |
| Templates | backticks, `${…}` converted with `str` | `` `${name} is ${age}` `` |

Function application is **prefix** (function before arguments) and **fixed-arity** — every built-in declares how many arguments it takes, so `add 1 mul 2 3` parses unambiguously as `add(1, mul(2, 3))`. Parentheses defer application: `map (double) [1 2 3]` passes `double` as a value rather than applying it. Built-ins work the same way — `apply (add) [1 2]`, `reduce (max) 0 xs` — while an unparenthesized `apply add [1 2]` fails with "Too few arguments for ADD".

Records support shorthand syntax for fields whose value comes from a variable of the same name. `let x = 1.. let y = 2.. {x y z: 3}..` is equivalent to `{x: 1, y: 2, z: 3}`.

## Pattern matching

`case … of` matches a value against patterns and returns the first match's right-hand side:

```
case age of
  18: "adult"
  _: "other"
end..
```

Patterns can be literals, tags, variables, lists `[x y]`, records `{name age}` / `{age: years}`, or the wildcard `_`, nested to any depth. A list pattern matches only a list of exactly that length; a record pattern matches any record with the named fields. A pattern's variables are bound in its clause only. Use `case` instead of nested `if` for any non-trivial branching.

`let` destructures with the same list and record patterns: `let [a b] = pair..`, `let {name} = person..`. Lambda parameters can be patterns too: `<[x y]: add x y>`, `map (<{name}: name>) people..`. These patterns only bind variables and `_`; a missing part is undefined, so use `case` when the shape varies.

## Base library — built-in functions

The base library is universal across dialects. Every dialect adds its own vocabulary on top, but these functions are always available.

| Function | Signature | Description |
| :--- | :--- | :--- |
| `add`, `sub`, `mul`, `div`, `mod`, `pow` | `<number number: number>` | Arithmetic. |
| `eq`, `ne`, `lt`, `gt`, `le`, `ge` | `<number number: bool>` | Numeric comparison. |
| `equiv` | `<any any: bool>` | Semantic equality across any type, including tags. |
| `and`, `or`, `not` | `<bool …: bool>` | Logical operators. |
| `concat` | `<string\|list string\|list: string\|list>` | Joins two strings or two lists. |
| `hd`, `tl`, `last`, `length`, `nth`, `cons`, `append`, `take`, `drop` | list ops | The usual list toolkit. |
| `map`, `filter`, `reduce` | functional list ops | Map a lambda over a list, keep matches, fold left. |
| `range` | `<number number number: list>` | Generate a list from a start, end, step. |
| `get`, `set` | record ops | Read or update a record field. |
| `get-var`, `set-var` | `<string …: any>` | Read or write a named binding visible through the rest of the program. |
| `get-val-public`, `get-val-private` | `<string: string>` | Read system-supplied values (e.g. `itemId`); the private variant is decrypted at compile time. |
| `json` | `<string: any>` | Parse a string as JSON. |
| `str` | `<any: string>` | Display text of any value; lists and records in Graffiticode syntax. |
| `log` | `<any: any>` | Print a value and return it (identity-with-side-effect). |
| `apply` | `<function list: any>` | Apply a function to a list of arguments. |
| `data` | `<record: record>` | Returns the upstream task's compiled output if a chained upstream is wired, or the argument otherwise. See "Composition" below. |
| `use` | `<string: record>` | Inside `data`, declares the upstream language whose output is expected (e.g. `data use "0166"`). The host fetches that language's schema and validates the chained value against it. |

Always prefer a base-library function over hand-rolling logic. If a behavior you need isn't covered above, it likely belongs in a dialect — not in the base library.

## Composition: `data use "<lang>"`

A program in one dialect can read the compiled output of another dialect as its upstream input. The base library provides two forms of `data`:

- `data {x: 1, y: 2}` — declares a default record. If an upstream task is chained to this program at compile time, its output replaces the default; otherwise the default is used.
- `data use "0166"` — declares that the upstream is expected to be a program in dialect L0166. The host (the Graffiticode console or MCP runtime) fetches L0166's `schema.json` at compile time and validates the chained upstream against it. If validation fails, the head program's compile fails with a clear error. If no upstream is chained, `data use "<lang>"` falls back to `{}`.

`data` and `use` are both arity-1, so the two forms are mutually exclusive. Choose `data use "<lang>"` when you want the host to discover the upstream automatically and validate its shape; choose `data {…}` when you want a default value baked in and the chain wired manually.

## Top-level result shape

A dialect's compiled output is consumed in two places: by the host renderer for that dialect, and — when chained — by another dialect via `data use "<lang>"`. To make composition predictable, every dialect should return a **record** at the top level, never a bare list, number, or string.

When a dialect's natural result is a list, wrap it in a record under a domain-named key that describes what the list contains: `{ items: [...] }` for a generic collection, `{ rows: [...] }` for tabular data, `{ questions: [...] }` for an assessment, and so on. Declare that key in the dialect's `schema.json` so `data use` consumers can validate against it.

Avoid generic envelopes like `{ value: [...] }` — they carry no semantic meaning and collide poorly with the existing `data` builtin, which already means "upstream input." The key should describe the content, not the wrapping.

basis does not enforce this; it is a dialect-authoring convention. The basis compiler passes the top-level result through as-is.

## Errors

Errors are propagated as a list of objects with `message`, `from`, and `to` fields (the `from`/`to` point at character offsets in the source when the error has a known location, otherwise `-1`). A program that produces any error fails to compile; its rendered output is replaced with the error list.

## How to pick a dialect

For agents, the discovery flow is:

1. `list_languages(search, domain)` — match a keyword or brand. Optional `domain` filter narrows to a product family (`questioncompiler`, `embedsheet`, `diagramcompiler`, …). The catalog is built from each dialect's `scope.json` (see below).
2. `get_language_info(language)` — read the dialect's `authoring_guide` summary and example prompts. Most requests can be answered from this alone.
3. If you need deeper reference (corner cases, vocabulary cues, item-type docs), read the dialect's `usage-guide.md` resource.
4. Call `create_item(language, description)` with a natural-language description. The dialect's backend generates the Graffiticode source.
5. To iterate: `update_item(item_id, modification)`.

For humans authoring directly, the same dialect's usage guide lists the vocabulary and example prompts. There is no global "do everything" dialect — the right one is whichever guide reads like it was written for your task.

## `scope.json` — the dialect's routing descriptor

Every dialect publishes a short `scope.json` at `https://l<id>.graffiticode.org/scope.json`. It is the single source of truth for **routing decisions**: which dialect handles a given request, and which doesn't. It does **not** describe how to author the dialect — `language-info.json` and `usage-guide.md` cover that, downstream of the routing decision.

```json
{
  "id": "0158",
  "summary": "Authors Learnosity-compatible assessment items from natural-language descriptions.",
  "in_scope": [
    "Multiple-choice (MCQ) items",
    "Spreadsheet-based assessment items",
    "Concept-web assessment items",
    "..."
  ],
  "out_of_scope": [
    "Activity-level assembly (timed tests, sections, branching)",
    "Delivery configuration",
    "Learner-side analytics",
    "..."
  ]
}
```

Required fields: `id`, `summary`, `in_scope` (array of capability strings). Optional but recommended: `out_of_scope` (array of strings naming what the dialect explicitly does NOT cover).

**`in_scope` describes user-visible capabilities, not implementation.** If L0158 supports spreadsheet questions through L0166 composition, the `in_scope` entry is "Spreadsheet-based assessment items" — not "hosts L0166 via custom + data use". How the dialect implements that capability is its own concern (lives in `instructions.md` and training examples).

The console catalog and the reactive language router read every dialect's `scope.json` to build the routing catalog. The fetcher caches with a TTL; restart or wait out the cache after editing.

## Out of scope

These belong outside Graffiticode entirely; no dialect provides them:

- **External I/O at runtime.** Programs compile against literal inputs (and optionally one chained upstream). They do not perform HTTP calls, file reads, database queries, or async work.
- **Mutable state across evaluations.** All values are immutable; there are no variables that mutate after binding.
- **Cross-dialect calls.** A program runs in exactly one dialect. To combine dialects, compose them via `data use "<lang>"` — the upstream produces a value, the head consumes it. There is no `import` mechanism.
- **Custom rendering beyond what a dialect emits.** If you need a renderer that doesn't exist, that's a new dialect, not a base-library extension.
