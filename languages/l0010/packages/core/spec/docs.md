<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0010 User Manual

**Introduction**

*Graffiticode* is a collection of domain languages used for creating task
specific web apps. **L0010** is the *Graffiticode* composition planner: given a
request, it produces the ordered sequence of languages needed to fulfil it.

### Overview

The code

```
plan ["0158" "0166"]..
```

evaluates to

```
{ "langs": ["0158", "0166"] }
```

a composition plan whose head (L0158) consumes the data model produced by the
next language (L0166). One id is an atomic request; an empty list is no
composition.

### Vocabulary

| Function | Arity | Example | Description |
| -------- | :---: | ------- | ----------- |
| **plan** | 1 | `plan ["0158" "0166"]` | returns `{ langs: [...] }` — the ordered composition pipeline (head first; each language consumes the next) |
