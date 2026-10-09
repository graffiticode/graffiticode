<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0186 Specification

L0186 is a Graffiticode dialect for FigJam boards. A program is one `board` of one or more
`page`s; each page holds sticky notes, text, shapes with text, sections, reaction stamps and
connectors. The compiled board is previewed as a picture of the board, and the Graffiticode FigJam
plugin draws it into a FigJam file named by `save-to-figjam`.

# Program

A program is one board, ending in `..`:

```
board [
  page [
    sticky id "idea" text "Idea" x 0 y 0 {}
    shape kind DIAMOND id "go" text "Go?" x 300 y 0 {}
    connector from "idea" to "go" {}
  ] {}
] {}..
```

Every description — a `sticky`, `shape`, `textbox`, `stamp` or `connector`, and each list's
settings after its `]` — ends in exactly one `{}` after its last word.

The style is typed members and attribute chains: a **container** (`board`, `page`, `section`)
takes a list of typed **members** and then a settings chain; a **member** (`sticky`, `shape`,
`textbox`, `stamp`, `connector`) takes one description chain; every other word is a **property**
that takes its value and the rest of the chain; closed sets are bare uppercase **tags**.

# Words

| Word | Signature | Meaning |
| --- | --- | --- |
| `id` | `<string record: record>` | The name connectors use to refer to a node. Defaults to the node's text, so give an id whenever two nodes say the same thing or the text is long. |
| `text` | `<string record: record>` | What a sticky, shape or textbox says. |
| `name` | `<string record: record>` | A section's or a page's name, shown as its title or tab. |
| `label` | `<string record: record>` | Text written on a connector. |
| `title` | `<string record: record>` | The board's title, after the board's `]`. |
| `kind` | `<tag record: record>` | A shape's outline (SQUARE, ELLIPSE, ROUNDED_RECTANGLE, DIAMOND, TRIANGLE_UP, TRIANGLE_DOWN, PARALLELOGRAM_RIGHT, PARALLELOGRAM_LEFT, ENG_DATABASE, ENG_QUEUE, ENG_FILE, ENG_FOLDER, TRAPEZOID, PREDEFINED_PROCESS, SHIELD, DOCUMENT_SINGLE, DOCUMENT_MULTIPLE, MANUAL_INPUT, HEXAGON, CHEVRON, PENTAGON, OCTAGON, STAR, PLUS, ARROW_LEFT, ARROW_RIGHT, SUMMING_JUNCTION, OR, SPEECH_BUBBLE, INTERNAL_STORAGE; defaults to SQUARE), or a stamp's reaction (LIKE, LOVE, LAUGH, SURPRISED, CELEBRATE, HEART; required). |
| `x` | `<number record: record>` | Distance from the left of the page, in pixels. Defaults to 0. |
| `y` | `<number record: record>` | Distance from the top of the page, in pixels. Defaults to 0. |
| `width` | `<number record: record>` | Width in pixels. Defaults to FigJam's size for the shape, or to fit a section's contents. |
| `height` | `<number record: record>` | Height in pixels. Defaults like width. |
| `fill` | `<string record: record>` | The background colour of a sticky, shape or section: a hex code like "#ffcc00", or red, blue, green, yellow, purple, orange, pink, white, black, gray. |
| `stroke` | `<string record: record>` | The outline colour of a shape, or a connector's line colour. |
| `color` | `<string record: record>` | A textbox's text colour. |
| `opacity` | `<number record: record>` | How opaque, from 0 (invisible) to 100 (solid). Defaults to 100. |
| `font-size` | `<tag\|number record: record>` | Text size: SMALL (16), MEDIUM (24), LARGE (40), EXTRA_LARGE (64), HUGE (96), or a number of pixels. |
| `stroke-width` | `<tag\|number record: record>` | Line thickness: THIN (4), THICK (8), or a number of pixels. |
| `from` | `<string\|list record: record>` | Where a connector starts: a node's id (or text), a list of them to fan in, or "*" for every other node on the page. |
| `to` | `<string\|list record: record>` | Where a connector ends: a node's id (or text), a list of them to fan out, or "*" for every other node on the page. |
| `line-type` | `<tag record: record>` | A connector's path: ELBOWED (the default), STRAIGHT or CURVED. |
| `line-style` | `<tag record: record>` | A connector's dash: SOLID (the default) or DASHED. |
| `from-cap` | `<tag record: record>` | The cap at a connector's start: NONE, ARROW_LINES, ARROW_EQUILATERAL, TRIANGLE_FILLED, CIRCLE_FILLED, DIAMOND_FILLED. Defaults to NONE. |
| `to-cap` | `<tag record: record>` | The cap at a connector's end: NONE, ARROW_LINES, ARROW_EQUILATERAL, TRIANGLE_FILLED, CIRCLE_FILLED, DIAMOND_FILLED. Defaults to ARROW_LINES. |
| `from-side` | `<tag record: record>` | Which side of the start node a connector leaves from: AUTO, TOP, BOTTOM, LEFT, RIGHT, CENTER. Defaults to AUTO (the facing side) for ELBOWED and CURVED connectors, CENTER for STRAIGHT ones; only a STRAIGHT connector can use CENTER. |
| `to-side` | `<tag record: record>` | Which side of the end node a connector arrives at. Same choices and default as from-side. |
| `waypoints` | `<list record: record>` | Points a connector passes through on its way, in order: waypoints [ waypoint [300 0] waypoint [300 400] ]. Needs a single from and a single to. |
| `background` | `<string record: record>` | A page's canvas colour. |
| `show-page-tabs` | `<boolean record: record>` | Show a tab per page. Defaults to true with two or more pages, false with one. |
| `show-page-menu` | `<boolean record: record>` | Show the page menu, which lists every page. Defaults to false. |
| `sticky` | `<record: record>` | A sticky note, e.g. `sticky id "kick" text "Kickoff" x 0 y 0 {}`. |
| `shape` | `<record: record>` | A shape with text, e.g. `shape kind DIAMOND text "Valid?" x 300 y 0 {}`. |
| `textbox` | `<record: record>` | Free text on the page, e.g. `textbox text "Roadmap" font-size LARGE {}`. |
| `stamp` | `<record: record>` | A reaction stamp, e.g. `stamp kind LIKE x 200 y 300 {}`. |
| `connector` | `<record: record>` | A line between nodes, e.g. `connector from "kick" to "valid" {}`. |
| `waypoint` | `<list: record>` | A point a connector passes through, as an [x y] pair of page pixels, inside `waypoints [ … ]`, e.g. `waypoint [300 0]`. It takes no `{}`. |
| `board` | `<list record: record>` | The program: the FigJam board's pages, then its settings (title, show-page-tabs, show-page-menu). |
| `page` | `<list record: record>` | One page: its nodes and connectors, then its settings (name, background). |
| `section` | `<list record: record>` | A titled area of a page holding nodes, then its settings (name, x, y, width, height, fill, opacity). |
| `save-to-figjam` | `<string: record>` | Draw this board into a FigJam file with the Graffiticode FigJam plugin: `save-to-figjam "<file key or figma.com link>"`, on its own line before the board. |

# Tags

Shape kinds, for `kind` on a `shape`, spelled as FigJam's own shape types: `SQUARE`, `ELLIPSE`,
`ROUNDED_RECTANGLE`, `DIAMOND`, `TRIANGLE_UP`, `TRIANGLE_DOWN`, `PARALLELOGRAM_RIGHT`, `PARALLELOGRAM_LEFT`,
`ENG_DATABASE`, `ENG_QUEUE`, `ENG_FILE`, `ENG_FOLDER`, `TRAPEZOID`, `PREDEFINED_PROCESS`, `SHIELD`,
`DOCUMENT_SINGLE`, `DOCUMENT_MULTIPLE`, `MANUAL_INPUT`, `HEXAGON`, `CHEVRON`, `PENTAGON`, `OCTAGON`, `STAR`, `PLUS`,
`ARROW_LEFT`, `ARROW_RIGHT`, `SUMMING_JUNCTION`, `OR`, `SPEECH_BUBBLE`, `INTERNAL_STORAGE`.

Stamps, for `kind` on a `stamp`: `LIKE`, `LOVE`, `LAUGH`, `SURPRISED`, `CELEBRATE`, `HEART`.

Connector paths (`line-type`): `ELBOWED` (the default), `STRAIGHT`, `CURVED`. Dashes (`line-style`): `SOLID`, `DASHED`.
Caps (`from-cap`, `to-cap`): `NONE`, `ARROW_LINES`, `ARROW_EQUILATERAL`, `TRIANGLE_FILLED`,
`CIRCLE_FILLED`, `DIAMOND_FILLED`. Sides (`from-side`, `to-side`): `AUTO`, `TOP`, `BOTTOM`, `LEFT`, `RIGHT`,
`CENTER`.

Sizes: `font-size` takes `SMALL` (16), `MEDIUM` (24), `LARGE` (40), `EXTRA_LARGE` (64) or `HUGE` (96);
`stroke-width` takes `THIN` (4) or `THICK` (8). Both also take a number of pixels.

# Nodes

A `sticky`, `shape`, `textbox` or `stamp` sits at its `x` and `y`, in pixels from the top left of
its page; both default to 0. Sizes left out take FigJam's defaults: a sticky is 240 by 240, a
shape 176 by 176, a stamp 40 by 40, and text is as wide as it is written.

A node's key — what a connector names — is its `id`, or its `text` when it has none; a stamp's key
is its reaction (`like`). Ids are unique on a page.

Colours are a hex code (`"#ffcc00"`) or one of `red`, `blue`, `green`, `yellow`, `purple`,
`orange`, `pink`, `white`, `black`, `gray`. Opacity is a percentage from 0 to 100.

# Sections

`section [ members ] settings` groups nodes under a title. It holds stickies, shapes, textboxes and
stamps, never another section or a connector. The section sits at its `x` and `y`; its nodes keep
their arrangement and are centred inside it with 24 pixels of padding, and a section with no
`width` or `height` fits its nodes.

```
board [
  page [
    section [
      sticky text "Shipped on time" x 0 y 0 {}
      sticky text "Good pairing" x 280 y 0 {}
    ] name "Went well" x 0 y 0 fill "#ecfdf5" {}
  ] {}
] {}..
```

# Connectors

A `connector` joins nodes on its own page, including nodes inside sections. `from` and `to` each
name a node's key, a list of keys (one connector per pair), or `"*"` — every node on the page but
the other end. A connector cannot attach to a section.

```
board [
  page [
    sticky id "hub" text "Hub" x 300 y 0 {}
    sticky text "A" x 0 y 300 {}
    sticky text "B" x 300 y 300 {}
    sticky text "C" x 600 y 300 {}
    connector from "hub" to ["A" "B" "C"] line-type ELBOWED from-side BOTTOM to-side TOP {}
    connector from "A" to "C" label "related" line-style DASHED from-cap ARROW_LINES {}
  ] {}
] {}..
```

The default connector is elbowed, solid, 4 pixels wide, with no cap at its start and an open
arrowhead at its end. An elbowed or curved connector picks the facing sides (`AUTO`); a straight
one meets each node at its centre unless a side is given. Only a straight connector can attach at
`CENTER`: FigJam refuses it on elbowed and curved ones.

`waypoints [ … ]` routes a connector through fixed points, in order. Each is `waypoint [x y]`, in
page pixels like a node's `x` and `y`; it is a pair, not a description, so no `{}` follows it. A
connector with waypoints joins one node to one node (a single `from` and `to`, no list or `"*"`).
FigJam has no waypoints of its own, so the plugin draws one FigJam connector per leg: `from-side`
and `from-cap` apply to the first leg, `to-side` and `to-cap` to the last, the label sits on the
middle leg, and the points stay put when a node is dragged.

```
board [
  page [
    shape kind ROUNDED_RECTANGLE id "test" text "Test" x 0 y 0 {}
    shape kind ROUNDED_RECTANGLE id "build" text "Build" x 0 y 400 {}
    connector from "test" to "build" {}
    connector from "build" to "test" label "fix" from-side LEFT to-side LEFT
      waypoints [ waypoint [-120 488] waypoint [-120 88] ] {}
  ] {}
] {}..
```

# Pages

A board holds one or more pages, shown as tabs when there are two or more. A board with more
than one page names every page, and page names are unique.

```
board [
  page [ sticky text "Goals" {} ] name "Planning" {}
  page [ sticky text "Went well" {} ] name "Retro" background "#f5f5f5" {}
] title "Q4 offsite" show-page-menu true {}..
```

# Saving to FigJam

`save-to-figjam` names the FigJam file to draw the board into — a figma.com board, design or file
link, or a bare file key — and is written on its own line, before or after the board, at most
once:

```
save-to-figjam "https://www.figma.com/board/ABC123/Planning"
board [
  page [ sticky text "Kickoff" {} ] {}
] {}..
```

Compiling does not write to FigJam. The compiled board carries the file's key, and the
Graffiticode FigJam plugin, opened in that file, draws it there. Without `save-to-figjam` the board
is previewed only.

# Output

A program compiles to `{type: "board", title?, showPageTabs, showPageMenu, pages, fileKey?}`.
Each page is `{name, background?, nodes}`, and each node carries its `type` (`sticky`, `shape`,
`text`, `stamp`, `section` or `connector`) and only the fields the program wrote: a shape adds its
`shapeType`, a stamp its `stamp`, a section its `nodes`; property names are camel case
(`fontSize`, `lineType`, `toCap`); line enums are lower case with dashes (`elbowed`,
`arrow-lines`); size presets are pixels. `schema.json` describes the output exactly.
