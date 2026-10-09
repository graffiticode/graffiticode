# L0186 — FigJam boards

L0186 builds **FigJam boards**: sticky notes, text, shapes with text, sections, reaction stamps
and connectors, laid out on one or more pages. The compiled board is previewed as a picture of the
board, and the Graffiticode FigJam plugin draws it into a FigJam file.

OUT_OF_SCOPE: concept maps and webs with drag-and-drop answers are L0183; charts are L0184;
spreadsheets are L0179; quizzes are L0180. Figma design files (frames, components, auto layout),
Miro, Mural and other whiteboards are not built. Comments, cursors, images, tables and
FigJam widgets are not built yet.

**Every description ends in exactly one `{}`, after its last word — every `sticky`, `shape`,
`textbox`, `stamp` and `connector`, and every list's settings after its `]`.** Leaving a `{}` off
(`sticky text "A" ]`) fails in the PARSER, before any compiler message can say what went wrong.
Writing one too early (`sticky text "A" {} x 300 {}`) ends the sticky there and leaves `x 300`
stranded.

## The shape of a program

Every program is ONE `board`, and a board holds one or more `page`s:

```
board [
  page [
    sticky id "idea" text "Idea" x 0 y 0 {}
    sticky id "plan" text "Plan" x 300 y 0 {}
    connector from "idea" to "plan" {}
  ] {}
] {}..
```

- `board [ … ] settings {}` is the program: a FigJam board (a FigJam file). Its list holds its
  `page`s. Its settings, after the outer `]`: `title`, `show-page-tabs`, `show-page-menu`.
- `page [ … ] settings {}` is one page. Its list holds the page's `sticky`, `shape`, `textbox`,
  `stamp`, `section` and `connector` members. Its settings, after the page's `]`: `name` and
  `background`. A board with more than one page names every page.
- `section [ … ] settings {}` is a titled area on a page. Its list holds `sticky`, `shape`,
  `textbox` and `stamp` members; its settings are `name`, `x`, `y`, `width`, `height`, `fill`,
  `opacity`. Sections do not nest, and connectors are written in the page, never in a section.
- Every member is written with its own word and ends in `{}`. Order within a description does not
  matter; each word appears once in a description.
- Closed sets are UPPERCASE tags, written bare: `kind DIAMOND`, `line-type ELBOWED`,
  `to-cap ARROW_LINES`, `font-size LARGE`. Never quote them and never lowercase them.

## Drawing into FigJam: `save-to-figjam`

A board is a preview until it names the FigJam file to draw into. Write `save-to-figjam` with the
file's link (or its file key) **on its own line, before the board**:

```
save-to-figjam "https://www.figma.com/board/ABC123/Planning"
board [
  page [ sticky text "Kickoff" {} ] {}
] {}..
```

Write it ONLY when the request asks to put the board in FigJam or Figma ("add this to my FigJam
board <link>", "draw it in https://www.figma.com/board/…"). Otherwise leave it out: the board is
previewed only. Never invent a link. `save-to-figjam` is never inside a list or a description.

## Nodes

- `sticky` — a sticky note. Words: `id`, `text`, `x`, `y`, `fill`, `opacity`, `font-size`.
- `shape` — a shape with text. `kind` picks the outline (defaults to `SQUARE`). Words: `id`,
  `kind`, `text`, `x`, `y`, `width`, `height`, `fill`, `stroke`, `stroke-width`, `opacity`,
  `font-size`.
- `textbox` — free text. Words: `id`, `text`, `x`, `y`, `color`, `opacity`, `font-size`.
- `stamp` — a reaction stamp. `kind` is required: `LIKE`, `LOVE`, `LAUGH`, `SURPRISED`,
  `CELEBRATE`, `HEART`. Words: `kind`, `x`, `y`, `opacity`.

Shape kinds: `SQUARE`, `ELLIPSE`, `ROUNDED_RECTANGLE`, `DIAMOND`, `TRIANGLE_UP`,
`TRIANGLE_DOWN`, `PARALLELOGRAM_RIGHT`, `PARALLELOGRAM_LEFT`, `TRAPEZOID`, `HEXAGON`,
`PENTAGON`, `OCTAGON`, `STAR`, `PLUS`, `CHEVRON`, `ARROW_LEFT`, `ARROW_RIGHT`, `SHIELD`,
`SPEECH_BUBBLE`, flowchart shapes `PREDEFINED_PROCESS`, `MANUAL_INPUT`, `DOCUMENT_SINGLE`,
`DOCUMENT_MULTIPLE`, `INTERNAL_STORAGE`, `SUMMING_JUNCTION`, `OR`, and engineering shapes
`ENG_DATABASE`, `ENG_QUEUE`, `ENG_FILE`, `ENG_FOLDER`.

For a flowchart: a terminator (start/end) is `ROUNDED_RECTANGLE` or `ELLIPSE`, a step is
`SQUARE` or `PREDEFINED_PROCESS`, a decision is `DIAMOND`, input/output is
`PARALLELOGRAM_RIGHT`, a database is `ENG_DATABASE`.

## Connectors

```
connector from "idea" to "plan" label "next" line-type ELBOWED to-cap ARROW_LINES {}
```

- `from` and `to` are required. Each names a node by its `id`, or by its `text` when it has no
  id. Give a node an `id` whenever its text is long or another node says the same thing.
- A list fans out or in: `to ["a" "b" "c"]` draws one connector to each. `"*"` means every
  other node on the page: `from "hub" to "*"`.
- A connector joins nodes on its own page, including nodes inside sections. It cannot attach to a
  section itself — connect to a node inside it.
- `line-type`: `ELBOWED` (default), `STRAIGHT`, `CURVED`. `line-style`: `SOLID` (default),
  `DASHED`.
- `from-cap` / `to-cap`: `NONE`, `ARROW_LINES`, `ARROW_EQUILATERAL`, `TRIANGLE_FILLED`,
  `CIRCLE_FILLED`, `DIAMOND_FILLED`. The default is no cap at the start and `ARROW_LINES` at the
  end; a two-way arrow sets both caps.
- `from-side` / `to-side`: `AUTO`, `TOP`, `BOTTOM`, `LEFT`, `RIGHT`, `CENTER`. An elbowed or
  curved connector picks the facing sides (`AUTO`); a `STRAIGHT` one meets each node at its
  centre unless a side is given. `CENTER` is for `STRAIGHT` connectors only.
- `label`, `stroke`, `stroke-width`, `opacity`, `font-size` style the line and its label.
- `waypoints [ … ]` routes the line through fixed points, in order. Each point is
  `waypoint [x y]` (page pixels, like a node's `x` and `y`). It is a pair, not a description,
  so write no `{}` after it. Use waypoints to go around a node or to pick where an elbow bends.
  A connector with waypoints needs a single `from` and a single `to`: no list, no `"*"`.

```
connector from "test" to "build" label "fix" waypoints [ waypoint [-120 400] waypoint [-120 0] ] {}
```

## Layout

Nothing is laid out for you: every node sits at its `x` and `y` (pixels from the page's top
left; both default to 0, and may be negative). Plan positions on a grid before writing them.

- A sticky is about 240×240. Space stickies at least 280 apart; 300 is a comfortable grid cell.
- A shape is 176×176 unless `width`/`height` are given. Give flowchart shapes a size
  (e.g. `width 200 height 120`) and leave at least 80 between them so a connector shows.
- A text label is as wide as its text. `font-size` takes `SMALL` (16), `MEDIUM` (24), `LARGE`
  (40), `EXTRA_LARGE` (64), `HUGE` (96) or a number.
- A section is placed at its `x`, `y`. Its nodes keep their arrangement and are centred inside it
  with 24 pixels of padding, so give them positions relative to each other; leave `width` and
  `height` out and the section fits its nodes. Leave room between sections for their titles.
- Stamps are 40×40.

## Colours

`fill`, `stroke`, `color` and `background` take a hex code (`"#ffcc00"`, `"#fc0"`) or one of
`"red"`, `"blue"`, `"green"`, `"yellow"`, `"purple"`, `"orange"`, `"pink"`, `"white"`, `"black"`,
`"gray"`. `fill` colours a sticky, shape or section; `color` colours a textbox's text; `stroke`
colours a shape's outline or a connector's line. `opacity` is a percentage, 0 to 100.

## Several pages

```
board [
  page [ sticky text "Goals" {} ] name "Planning" {}
  page [ sticky text "Went well" {} ] name "Retro" background "#f5f5f5" {}
] title "Q4 offsite" {}..
```

Pages show as tabs. `show-page-tabs false` hides them (then add `show-page-menu true`, or no page
but the first can be reached); `show-page-menu true` adds a menu that lists every page. A board
with a single page shows neither.

## Functions

| Word | Signature | Meaning |
| --- | --- | --- |
| `id` | `<string record: record>` | The name connectors use to refer to a node. Defaults to the node's text, so give an id whenever two nodes say the same thing or the text is long. |
| `text` | `<string record: record>` | What a sticky, shape or textbox says. |
| `name` | `<string record: record>` | A section's or a page's name, shown as its title or tab. |
| `label` | `<string record: record>` | Text written on a connector. |
| `title` | `<string record: record>` | The board's title, after the board's `]`. |
| `kind` | `<tag record: record>` | A shape's outline (defaults to SQUARE), or a stamp's reaction (LIKE, LOVE, LAUGH, SURPRISED, CELEBRATE, HEART; required). |
| `x` | `<number record: record>` | Distance from the left of the page, in pixels. Defaults to 0. |
| `y` | `<number record: record>` | Distance from the top of the page, in pixels. Defaults to 0. |
| `width` | `<number record: record>` | Width in pixels. Defaults to FigJam's size for the shape, or to fit a section's contents. |
| `height` | `<number record: record>` | Height in pixels. Defaults like width. |
| `fill` | `<string record: record>` | The background colour of a sticky, shape or section. |
| `stroke` | `<string record: record>` | The outline colour of a shape, or a connector's line colour. |
| `color` | `<string record: record>` | A textbox's text colour. |
| `opacity` | `<number record: record>` | How opaque, from 0 (invisible) to 100 (solid). Defaults to 100. |
| `font-size` | `<tag\|number record: record>` | Text size: SMALL (16), MEDIUM (24), LARGE (40), EXTRA_LARGE (64), HUGE (96), or a number of pixels. |
| `stroke-width` | `<tag\|number record: record>` | Line thickness: THIN (4), THICK (8), or a number of pixels. |
| `from` | `<string\|list record: record>` | Where a connector starts: a node's id (or text), a list of them, or "*" for every other node on the page. |
| `to` | `<string\|list record: record>` | Where a connector ends: a node's id (or text), a list of them, or "*" for every other node on the page. |
| `line-type` | `<tag record: record>` | A connector's path: ELBOWED (the default), STRAIGHT or CURVED. |
| `line-style` | `<tag record: record>` | A connector's dash: SOLID (the default) or DASHED. |
| `from-cap` | `<tag record: record>` | The cap at a connector's start. Defaults to NONE. |
| `to-cap` | `<tag record: record>` | The cap at a connector's end. Defaults to ARROW_LINES. |
| `from-side` | `<tag record: record>` | Which side of the start node a connector leaves from. |
| `to-side` | `<tag record: record>` | Which side of the end node a connector arrives at. |
| `waypoints` | `<list record: record>` | Points a connector passes through, in order: waypoints [ waypoint [300 0] ]. |
| `background` | `<string record: record>` | A page's canvas colour. |
| `show-page-tabs` | `<boolean record: record>` | Show a tab per page. Defaults to true with two or more pages, false with one. |
| `show-page-menu` | `<boolean record: record>` | Show the page menu, which lists every page. Defaults to false. |
| `sticky` | `<record: record>` | A sticky note. |
| `shape` | `<record: record>` | A shape with text. |
| `textbox` | `<record: record>` | Free text on the page. |
| `stamp` | `<record: record>` | A reaction stamp. |
| `connector` | `<record: record>` | A line between nodes. |
| `waypoint` | `<list: record>` | One point a connector passes through, as an [x y] pair, inside `waypoints [ … ]`. No `{}`. |
| `board` | `<list record: record>` | The program: the board's pages, then its settings. |
| `page` | `<list record: record>` | One page: its nodes and connectors, then its settings. |
| `section` | `<list record: record>` | A titled area holding nodes, then its settings. |
| `save-to-figjam` | `<string: record>` | Draw the board into this FigJam file (a link or a file key). A statement on its own line before the board. |

## Which members each container holds

| Container | Members |
| --- | --- |
| `board` | page |
| `page` | sticky, shape, textbox, stamp, section, connector |
| `section` | sticky, shape, textbox, stamp |
| `waypoints` | waypoint |

## Which words each description takes

| Description | Words |
| --- | --- |
| `sticky` | id, text, x, y, fill, opacity, font-size |
| `shape` | id, kind, text, x, y, width, height, fill, stroke, stroke-width, opacity, font-size |
| `textbox` | id, text, x, y, color, opacity, font-size |
| `stamp` | kind, x, y, opacity |
| `connector` | from, to, label, line-type, line-style, from-cap, to-cap, from-side, to-side, stroke, stroke-width, opacity, font-size, waypoints |

## Which settings each container takes

| Container | Settings |
| --- | --- |
| `board` | title, show-page-tabs, show-page-menu |
| `page` | name, background |
| `section` | name, x, y, width, height, fill, opacity |

## If you know L0172

L0186 replaces L0172 and does not accept its programs. The old spellings map like this:

| L0172 | L0186 |
| --- | --- |
| `board "<key>" nodes [ … ] {}` | `save-to-figjam "<key>"` then `board [ page [ … ] {} ] {}` |
| `sticky "Kickoff" …` | `sticky text "Kickoff" …` (add `id "…"` to refer to it by another name) |
| `text "Title" …` | `textbox text "Title" …` |
| `diamond "Valid?" …`, `ellipse …`, `eng-database …` | `shape kind DIAMOND text "Valid?" …`, `kind ELLIPSE`, `kind ENG_DATABASE` |
| `stamp like …` | `stamp kind LIKE …` |
| `section "Phase 1" nodes [ … ] {}` | `section [ … ] name "Phase 1" {}` |
| `connector "next" from … to …` | `connector from … to … label "next"` |
| `line-type elbowed`, `to-cap arrow-lines`, `font-size large` | `line-type ELBOWED`, `to-cap ARROW_LINES`, `font-size LARGE` |

## Guidelines

- Put on the board only what the request asks for. Never invent content the request does not
  state; when it asks for a template ("a retro board"), use the template's usual headings.
- Give every node a connector refers to a short `id`, and connect by id.
- Lay nodes out on a grid with generous spacing; group related nodes in sections.
- Use one page unless the request asks for several pages, tabs or separate boards for parts of
  the work.

## Example patterns

A decision flowchart:

```
board [
  page [
    shape kind ROUNDED_RECTANGLE id "start" text "Start" x 0 y 0 width 200 height 100 {}
    shape kind DIAMOND id "valid" text "Valid?" x 300 y -20 width 200 height 140 {}
    shape kind ROUNDED_RECTANGLE id "save" text "Save" x 600 y 0 width 200 height 100 {}
    shape kind ROUNDED_RECTANGLE id "error" text "Report error" x 300 y 260 width 200 height 100 {}
    connector from "start" to "valid" {}
    connector from "valid" to "save" label "yes" {}
    connector from "valid" to "error" label "no" from-side BOTTOM to-side TOP line-type ELBOWED {}
  ] {}
] {}..
```

A retrospective in sections:

```
board [
  page [
    textbox text "Sprint 12 retro" font-size LARGE x 0 y -120 {}
    section [
      sticky text "Shipped on time" fill "#bbf7d0" x 0 y 0 {}
      sticky text "Good pairing" fill "#bbf7d0" x 0 y 280 {}
    ] name "Went well" x 0 y 0 {}
    section [
      sticky text "Flaky tests" fill "#fecaca" x 0 y 0 {}
    ] name "To improve" x 400 y 0 {}
    section [
      sticky text "Quarantine flaky tests" fill "#bfdbfe" x 0 y 0 {}
    ] name "Action items" x 800 y 0 {}
  ] {}
] title "Sprint 12 retro" {}..
```

A hub with spokes, drawn into a FigJam file:

```
save-to-figjam "https://www.figma.com/board/ABC123/Brainstorm"
board [
  page [
    sticky id "hub" text "Idea" x 300 y 300 fill "yellow" {}
    sticky text "Who" x 0 y 0 {}
    sticky text "What" x 600 y 0 {}
    sticky text "Why" x 0 y 600 {}
    sticky text "How" x 600 y 600 {}
    stamp kind CELEBRATE x 560 y 300 {}
    connector from "hub" to ["Who" "What" "Why" "How"] line-style DASHED {}
  ] {}
] {}..
```
