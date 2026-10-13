<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0013 Vocabulary

This specification documents the dialect-specific function added by the **L0013**
language of Graffiticode. L0013 extends the core (L0000) language with a single
side-effecting function, `snap`, that renders a task's form view to an image.

The core language specification — syntax, semantics, and base library — can be found here:
[Graffiticode Language Specification](./graffiticode-language-spec.html)

## Functions

| Function | Signature | Description |
| :------- | :-------- | :---------- |
| `snap` | `<opts: record>` | Renders an item's form view, crops it, uploads a PNG, returns the image URL |
| `item` | `<string opts: opts>` | Sets the item id to capture (task + language are resolved from it) |
| `viewport` | `<record opts: opts>` | Sets the browser window `{ width, height }` the form lays out into |
| `slice` | `<string opts: opts>` | Crops the densest region at a `"W:H"` aspect (e.g. `"4:1"` wide, `"1:4"` tall) |
| `zoom` | `<number opts: opts>` | Linear zoom within a `slice` (0–1) — `0` = frame all ink, `1` = densest core |
| `crop` | `<record opts: opts>` | Explicit clip `{ x, y, width, height }` (CSS pixels) — manual override |
| `width` | `<number opts: opts>` | Max output width in pixels |
| `height` | `<number opts: opts>` | Max output height in pixels |

### snap

`snap` takes an options record — assembled by chaining the modifier functions onto a base
record `{}` — and returns `{ url, item }`: a public CDN URL for the uploaded PNG
(`url`) and the item id the upload path was derived from (`item`). The task id and
language are resolved from the item id.

The crop is **content-aware**. By default `snap` trims the surrounding whitespace down to the
inked content. `slice "W:H"` instead crops a fixed-aspect region — by default the smallest box at
that aspect that **contains** all the ink (= `zoom 0`). `zoom <0–1>` scales that region between
framing **all** the ink (`zoom 0` — the full content box, e.g. a 1:1 square enclosing the content)
and the **densest natural region** (`zoom 1` — the tightest box that still captures a dense
cluster, e.g. `slice "1:1" zoom 1` on a pie chart → a square centered on the pie). The zoom-1 size
is derived from the ink itself (the window maximizing ink × density), not a fixed ratio. An
explicit `crop` rectangle overrides both.

Modifiers (each arity 2 — a value plus the rest of the options):

- `item "<id>"` (required) — the item to capture; its form view is rendered.
- `viewport { width: height: }` (optional) — the browser window the form lays out into; defaults to 1024×768. Most form views fill the window, so this bounds the layout before capture.
- `slice "<W:H>"` (optional) — crop a region at this aspect ratio (`"4:1"` = wide, `"1:4"` = tall); frames all the ink by default (= `zoom 0`), `zoom` tightens onto the densest region.
- `zoom <0–1>` (optional, with `slice`) — zoom from framing all the ink to the densest natural region; `0` = all ink (e.g. `slice "1:1" zoom 0` → a square holding all the content), `1` = the tightest box still capturing a dense cluster (e.g. `slice "1:1" zoom 1` on a pie chart → a square centered on the pie). The zoom-1 size comes from the ink, not a fixed ratio.
- `crop { x: y: width: height: }` (optional) — explicit clip in CSS pixels; overrides the content-aware crop.
- `width <n>` / `height <n>` (optional) — max output width / height in pixels. Together they form a bounding box: the image is scaled to the largest size that fits while preserving the crop's aspect. With only `width`, height follows the aspect (and vice-versa); with neither, the default width is used. Use `height` to bound tall `slice` ratios (e.g. `slice "1:4" height 512`).

## Program Examples

Capture an item's form view, trimmed to its content (simplest form):

```
snap item "item123" {}..
```

A wide 4:1 banner over the busiest part of the form:

```
snap slice "4:1" item "item123" {}..
```

With an explicit crop and output width:

```
snap width 240 crop { x: 0 y: 0 width: 800 height: 600 } item "item123" {}..
```
