<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0003 Usage Guide

Agent-facing guide for authoring L0003 programs. Read this before composing a `create_item` prompt or an `update_item` modification.

## Overview

L0003 is the base Graffiticode dialect — a small functional language with the full core toolkit (arithmetic, strings, lists, lambdas, pattern matching, tags) plus a handful of UI rendering primitives (`hello`, `image`, `theme`, `id`). Input is a natural-language description of either a value to compute or a simple piece of UI to display; output is an L0003 program whose evaluation is what you get back — either a computed value (number, string, list, record) or a rendered HTML fragment in the hosted React app. Because L0003 is the base dialect, it is the right tool when the job is "evaluate a small program" or "render a hello / image / themed greeting" — not when the job needs a domain-specific artifact (assessments, spreadsheets, SVG, board content). Those belong in higher-numbered dialects.

When composing a request, name what you want first — the value to compute or the UI element to render — then the inputs (literals, ranges, lists) and any transformation (map, filter, reduce, pattern match). For UI, the pattern is `theme DARK hello "world"..` or `image "https://..."..`; every L0003 program ends with `..`. For computation, the pattern is an expression whose value is the result: `1 + 2..`, `map double [1 2 3]..`, `filter (lambda x (gt x 3)) [1 2 3 4 5]..`. Tags (`DARK`, `LIGHT`, user-defined) use the `tag` keyword and pattern-match with `case`. Lists are space-separated (`[1 2 3]`, not `[1, 2, 3]`). Prefer built-ins (`map`, `filter`, `reduce`, `range`, `pow`, `concat`, `cons`, `append`, `last`, `length`, `take`, `drop`, `json`, comparison operators `eq`/`ne`/`gt`/`lt`/`ge`/`le`) over defining helpers from scratch.

In scope: arithmetic, string manipulation, list construction and traversal, `range`, `map` / `filter` / `reduce`, lambdas and `let`-bound helpers, pattern matching on numbers / lists / pairs / records / tags, comparison operators, `hello` / `image` / `theme` / `id` UI primitives, `DARK` / `LIGHT` built-in tags. Out of scope: domain-specific artifacts (assessments → L0158, spreadsheets → L0166, FigJam boards → L0172, data pipelines → L0170, and so on), external data sources, stateful operations, streaming I/O, and custom renderers beyond the four UI primitives.

## Vocabulary Cues

Say this to get that:

- **Arithmetic** — "add 7 and 5", "compute 2 to the power of 10", "the remainder when 17 is divided by 5". Triggers literal expressions like `7 + 5..`, `pow 2 10..`, `17 % 5..`.
- **Lists** — "the list [1 2 3]", "first / last / length of the list", "range from 1 to 10". Uses `[a b c]` (space-separated), `head` / `last` / `length`, `range 1 10 1`.
- **Map / filter / reduce** — "double every element", "keep only even numbers", "sum the list". Triggers `map (lambda x (mul x 2)) [1 2 3]..`, `filter (lambda x (eq (mod x 2) 0)) [...]..`, `reduce add 0 [...]..`.
- **Lambda** — "define a function", "with a lambda that doubles x". Syntax: `let double = lambda x (mul x 2)..` or inline `lambda x (...)`.
- **Pattern matching** — "match a pair (x, y) and return their sum", "match the number 1 and return 'one'". Uses `case` with patterns `(x, y)`, `{name, age}`, literals, and `_` wildcard.
- **Tags** — "define a tag `red`", "match a tag and return a string". Use `tag red..` to declare, `case` to dispatch, `equiv` to compare.
- **hello** — "render a hello message for 'world'" → `hello "world"..`. Produces `hello, world!`.
- **image** — "display the image at URL X" → `image "https://..."..`.
- **theme** — "in dark / light theme". Wraps a body: `theme DARK hello "night"..`. `DARK` and `LIGHT` are built-in tags; the rendered page gets a theme toggle.
- **id** — "with id 'greeting'" → `id "greeting" hello "world"..`. Attaches an element identifier for downstream referencing.
- **Comparison** — `eq`, `ne`, `gt`, `lt`, `ge`, `le`. "Checks if 5 equals 5" → `eq 5 5..`.
- **Program terminator** — every L0003 program ends with `..`. Don't omit it.

## Example Prompts

- *"Double every number in [1 2 3 4] and then sum them."* → `expression`
- *"Define a function `triple` that multiplies a number by 3, then map it over the range 1 to 5."* → `expression`
- *"Filter the even numbers out of [1 2 3 4 5 6] using a lambda with `eq` and `mod`."* → `expression`
- *"Match a pair (x, y) and return whichever value is larger."* → `expression`
- *"Render a hello greeting for 'world' in the dark theme."* → `rendered_ui`
- *"Display the image at https://example.com/photo.jpg."* → `rendered_ui`
- *"Define tags `yes` and `no`, then return `true` for `yes` and `false` for `no` using `case`."* → `expression`
- *"Sum the squares of the numbers from 1 to 10."* → `expression`

## Out of Scope

- **Domain-specific artifacts** — assessments, spreadsheets, SVG charts, FigJam boards, data pipelines, etc. Use the higher-numbered dialects (L0158 assessments, L0166 spreadsheets, L0170 data, L0172 FigJam, and so on).
- **External data** — HTTP calls, file I/O, database queries. L0003 evaluates a closed program against literal inputs.
- **Stateful or streaming operations** — no mutable variables, no event loops, no async.
- **Custom rendering** — only `hello`, `image`, `theme`, and `id` emit UI. Richer UI belongs in a domain-specific dialect with its own renderer.
- **Cross-language composition** — L0003 cannot `import` another dialect's functions; each item runs in exactly one language.
