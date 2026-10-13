<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0013 Usage Guide

Agent-facing guide for authoring L0013 programs. Read this before composing a `create_item` prompt or an `update_item` modification.

## Overview

L0013 is a utility dialect that photographs an item. Given an item id, `snap` renders that item's form view in a headless browser (the task id and language are resolved from the item id), crops the capture **content-aware** (by default trimming the surrounding whitespace down to the inked content; with `slice "W:H"`, cropping a fixed-aspect band of the content — all the ink by default, or with `zoom` tightening onto the densest part of the form), uploads the resulting PNG to Firebase Storage at an item-derived path (`thumbnails/{item}.png`), and returns a record `{ url, item }` — a public CDN URL for the image (`url`) and the item id the path was derived from (`item`). L0013 does not author any content of its own; it only captures the rendered output of an existing item, so it is the right tool when the job is "make a thumbnail / screenshot of this item" and never when the job is to create assessments, spreadsheets, charts, diagrams, boards, or data — those belong in the domain-specific dialects. Every L0013 program is a single `snap <opts>..` expression whose evaluation performs the capture and upload as a side effect.

A program is `snap` applied to an options record that is assembled by chaining arity-2 modifier functions onto a base record `{}`. The required modifier is `item "<id>"` (the item to capture). Optional modifiers: `slice "<W:H>"` (crop the densest band at that aspect — e.g. `"4:1"` for a wide banner), `viewport { width: height: }` (the layout window), `crop { x: y: width: height: }` (an explicit clip in CSS pixels that overrides the content-aware crop), and `width <n>` (output width in pixels; the height follows the crop's aspect). The simplest program is `snap item "item123" {}..`; every program ends with `..`.

In scope: rendering a given item's form view to an image, cropping it, uploading the PNG, and returning its URL. Out of scope: authoring domain content, editing or recompiling the target item (it is rendered read-only), interactive UI, and cross-language composition (L0013 takes an item reference; it does not import another dialect's functions).

## Vocabulary Cues

Say this to get that:

- **snap** — "thumbnail / screenshot item X" → `snap item "X" {}..`.
- **item** — the required modifier naming the item to capture: `item "item123" {}`.
- **viewport** — "render in a 1280×800 window" → `viewport { width: 1280 height: 800 }`. Bounds the form's layout before capture (most form views fill the window).
- **slice** — "a wide 4:1 banner of the busiest part" → `slice "4:1"`. Crops the densest region at that aspect (`"1:4"` for a tall slice), sized to the content.
- **zoom** — how far to zoom in within a `slice`, from all the ink to the densest natural region. "a 1:1 square holding all the content" → `slice "1:1" zoom 0`; "a square centered on the pie" → `slice "1:1" zoom 1` (the tightest box still capturing the dense cluster, size derived from the ink). Mid values (e.g. `zoom 0.5`) interpolate between the two.
- **crop** — "exactly the top 800×600" → `crop { x: 0 y: 0 width: 800 height: 600 }` (explicit override of the content-aware crop).
- **width / height** — "at most 240px wide" → `width 240`; "no taller than 512" → `height 512`. Together they form a max bounding box (output fits inside, aspect preserved). Use `height` to keep a tall `slice "1:4"` from blowing up.
- **Program terminator** — every L0013 program ends with `..`. Don't omit it.

## Example Prompts

- *"Capture a thumbnail of item item123."* → `thumbnail`
- *"A wide 4:1 banner of item item123's busiest region."* → `thumbnail`
- *"Thumbnail item item123 at 240px wide."* → `thumbnail`

## Out of Scope

- **Authoring content** — assessments, spreadsheets, charts, diagrams, boards, data pipelines. L0013 only photographs an existing item's output; author with the domain-specific dialects.
- **Editing the target** — the item is rendered read-only; `snap` never recompiles or mutates it.
- **Interactive UI** — the output is a static image.
- **Cross-language composition** — L0013 takes an item reference; it does not `import` another dialect's functions.
