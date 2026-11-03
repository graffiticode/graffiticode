<!-- SPDX-License-Identifier: CC-BY-4.0 -->
**Note:** This document trains the dialect-specific code-generation model. It is not a guide for client AI agents.

# Dialect L0010 — Composition Planning

L0010 is the **composition planner**. Given a user's request, you emit a program that names the ordered sequence of Graffiticode languages needed to fulfil it. You author **no content** — only the sequence.

## The only construct

```
plan ["<id>" "<id>" ...]..
```

- `plan` takes a list of language-id strings and evaluates to `{ langs: [...] }`.
- The list is the pipeline **head first**: `langs[0]` is what the user ultimately gets; each language **consumes the data model produced by the next** (a linear pipeline, no branches).
- **One id** = atomic (no composition). **Empty** `plan []` = nothing to compose.

Emit ONLY a `plan [...]..` program. No other Graffiticode constructs.

## How to decide the sequence

Composition is a LINEAR PIPELINE. Decompose the request from the head (the final artifact) down to the deepest data source. Stage *i* consumes the data model produced by stage *i+1*.

**Core rule:** add a downstream stage whenever a stage *describes but does not author* a content type that another dialect produces. Stop when a stage can author its content directly (a leaf). If the head language can fulfil the request alone, return a single id.

## Capabilities and their providers

Composition is **capability resolution**, not a fixed set of language pairs.
Each language *provides* and authors certain capabilities directly. When a
request needs a capability the head **can't author itself**, add the language
that *provides* it as the next stage. The same provider serves **every** head —
there is no per-head pairing to memorize, and a head you've never seen composes
the same way the moment it needs a capability it lacks.

| Capability the request needs | Provider | Upstream id |
| :--- | :--- | :--- |
| **Fetch data** (web / URL, JSON or CSV) **and transform it** — filter, select, mutate, group, sort, take / top-N, join, flatten, unique, reshape | **L0170** — data fetching & transformation | `0170` |
| Spreadsheet / table / worksheet content | L0166 | `0166` |
| Flashcard interactions | L0159 | `0159` |
| Concept-web / concept-map | L0169 | `0169` |

**L0170 is the go-to provider for data acquisition and transformation.**
Whenever any stage needs data it cannot author inline — the request says
*fetch*, *scrape*, *pull*, *load*, *from <a public source / URL / API>*,
*live*, *latest*, *real*, or asks to *filter / sort / rank / top-N / group /
aggregate / join / dedupe / reshape* a dataset — reach for `0170` to produce
that data model. It both **fetches** (JSON/CSV from a URL) and **transforms**
(dplyr/jq-style). It is a **leaf**: nothing goes downstream of it.

A head authors its own content directly (no upstream) when the request gives it
everything inline — e.g. a chart with the numbers provided, a spreadsheet, a
flashcard deck, a concept web, or an L0158 question (MCQ, short text, cloze,
formula, classification, order list, choice matrix). If there is **no
capability gap**, return the head alone — never invent an upstream.

## Heuristics

- A "spreadsheet question/assessment", "table-based assessment", or "use the spreadsheet" request under L0158 ⇒ `plan ["0158" "0166"]`.
- A pure question-form request (MCQ, short text, fill-in-the-blank) under L0158 ⇒ `plan ["0158"]`.
- A chart/graph/plot that names a data source to **fetch** or data to **filter/sort/rank/aggregate** (e.g. "bar chart of the ten biggest economies — fetch and filter public GDP data") ⇒ `plan ["0173" "0170"]`. A chart with the values given inline ⇒ `plan ["0173"]`.
- A request to **fetch and/or transform data** with no other artifact (e.g. "fetch this JSON and keep the top 10 by revenue") ⇒ `plan ["0170"]`.
- If the user is already in the dialect that authors the content (e.g. a spreadsheet request under L0166) ⇒ single id.
- At most **4** stages. **No language id repeats** in the sequence.

## Examples

- "create a simple spreadsheet assessment for learnosity" → `plan ["0158" "0166"]..`
- "make an mcq about France" → `plan ["0158"]..`
- "make a budget tracker spreadsheet" → `plan ["0166"]..`
- "a flashcard deck embedded as a learnosity item" → `plan ["0158" "0159"]..`
- "create a bar chart of the ten biggest economies by GDP. fetch and filter public GDP data" → `plan ["0173" "0170"]..`
- "line chart of world population by year from public data" → `plan ["0173" "0170"]..`
- "bar chart of Q1–Q4 revenue 320, 450, 380, 510" (data inline) → `plan ["0173"]..`
- "fetch this CSV and keep the top 10 rows by revenue" → `plan ["0170"]..`
