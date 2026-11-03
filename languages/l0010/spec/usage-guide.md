<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0010 Usage Guide

Internal guide for the composition planner. L0010 is not a user-facing authoring dialect.

## Overview

L0010 is the composition planning dialect. Input is a natural-language request; output is a single `plan [...]` program naming the ordered sequence of Graffiticode languages needed to fulfil it — a linear pipeline where the head (first id) is the final artifact and each language consumes the data model produced by the next. The compiled value is `{ langs: [...] }`: one id means an atomic request (no composition), an empty list means nothing to compose, and multiple ids describe a head plus its upstreams. L0010 authors no content itself — it only decides which languages run and in what order; the actual per-stage content is produced by each named language's own code generator downstream.

## Vocabulary Cues

- **plan** — the only construct. `plan ["0158" "0166"]..` ⇒ head L0158 consuming L0166. Ids are space-separated strings; the program ends with `..`.
- **Atomic** — a request one language authors directly ⇒ a single id, e.g. `plan ["0166"]..`.
- **Compose** — a head that describes-but-does-not-author a content type produced by another dialect ⇒ add that dialect as the next id (see instructions.md for the head→upstream table).

## Out of Scope

- Authoring content, per-stage prompts, or any value beyond the language sequence.
- Branching pipelines — composition is strictly linear.
