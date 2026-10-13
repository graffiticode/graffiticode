<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0013 Dialect Extensions

L0013 adds one side-effecting function, `snap`, to the base (L0000) dialect. It renders the
form view of an existing task to a PNG, uploads it to Firebase Storage at an item-derived path,
and returns the image URL. It is a utility dialect (used to generate thumbnails), not a
content-authoring target.

## L0013 Functions

| Function | Signature | Description |
| :------- | :-------- | :---------- |
| `snap` | `<opts: record>` | Render the item's form view, crop, upload PNG, return `{ url, item }` |
| `item` | `<string opts: opts>` | Set the item id to capture (task + language resolved from it) |
| `viewport` | `<record opts: opts>` | Set the browser window `{ width, height }` the form lays out into |
| `slice` | `<string opts: opts>` | Crop the densest region at a `"W:H"` aspect (`"4:1"` wide, `"1:4"` tall) |
| `zoom` | `<number opts: opts>` | Zoom within a `slice` (0–1) — `0` = all ink, `1` = densest region (ink-derived, e.g. a square on a pie) |
| `crop` | `<record opts: opts>` | Explicit clip `{ x, y, width, height }` (CSS pixels) — manual override |
| `width` | `<number opts: opts>` | Max output width in pixels |
| `height` | `<number opts: opts>` | Max output height in pixels |

Options are assembled by chaining the arity-2 modifiers onto a base record `{}`. `item` is
required; `viewport`, `slice`, `zoom`, `crop`, `width`, and `height` are optional. `width`/`height` form
a max bounding box (the output fits inside, preserving aspect). The crop is content-aware:
by default `snap` trims whitespace to the inked content; `slice` crops a fixed-aspect box (framing
all the ink by default, i.e. `zoom 0`; `zoom 1` tightens onto the densest region); an explicit
`crop` overrides both.

## L0013 Examples

```
snap item "item123" {}..
snap slice "4:1" item "item123" {}..
```
