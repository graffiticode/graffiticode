<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0010 Vocabulary

This specification documents the dialect-specific function added by the **L0010**
language of Graffiticode — the composition planner. L0010 extends the core
language with a single function, `plan`, that names an ordered sequence of
Graffiticode languages.

The core language specification including the definition of its syntax,
semantics and base library can be found here:
[Graffiticode Language Specification](./graffiticode-language-spec.html)

## Functions

| Function | Signature | Description |
| :------- | :-------- | :---------- |
| `plan` | `<list: record>` | Build a composition plan from a list of language-id strings |

### plan

Takes a list of language-id strings and evaluates to `{ langs: [...] }` — the
ordered composition pipeline. `langs[0]` is the head (the final artifact); each
language consumes the data model produced by the next (a linear pipeline, no
branches). One id is an atomic request; an empty list is no composition. Each
element must be a language id matching `^\d{3,5}$`; duplicates are rejected and
at most four stages are allowed.

```
plan ["0158" "0166"]  | returns { langs: ["0158", "0166"] }
```

## Program Examples

A spreadsheet-based Learnosity assessment — head L0158 consuming an L0166 spreadsheet:

```
plan ["0158" "0166"]..
```

An atomic request (one language authors it directly):

```
plan ["0166"]..
```
