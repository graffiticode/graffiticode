<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0187 — Declarative FigJam boards

L0187 builds **FigJam boards from what they contain**: sticky notes, shapes, text, sections,
invisible groups and connectors, on one or more pages. You describe the content, how it is
grouped, how it connects and what order matters; **the compiler places everything**. It measures
the text, arranges the board, routes the connectors and checks the result. You never write a
coordinate, a size, a gap or a route.

OUT_OF_SCOPE: positioned drawings where the request gives coordinates are L0186; concept maps with
drag-and-drop answers are L0183; charts are L0184; spreadsheets are L0179; quizzes are L0180.
Reaction stamps, images, tables, nested visible sections and editing an existing board are not
built.

**Every description ends in exactly one `{}`, after its last word: every `sticky`, `shape`,
`textbox` and `connector`, and every container's settings after its `]`.** Leaving a `{}` off
fails in the parser. Writing one too early (`sticky id "a" {} text "A" {}`) ends the sticky there
and strands `text "A"`.

## The shape of a program

```gc
board [
  page [
    sticky id "idea" text "Idea" {}
    sticky id "plan" text "Plan" {}
    connector id "idea-plan" from "idea" to "plan" {}
  ] id "p1" name "Planning" layout FLOW {}
] title "Planning" {}..
```

- One `board`, ending in `..`. Its list holds `page`s; its settings are `title`,
  `show-page-tabs`, `show-page-menu`.
- `page [ … ] id "…" name "…" {}`: every page has an `id` and a `name`. Its list holds `sticky`,
  `shape`, `textbox`, `section`, `group` and `connector`.
- `section [ … ] id "…" name "…" {}`: a visible, titled area. It holds marks and groups, never
  another section, never connectors.
- `group [ … ] id "…" {}`: an invisible block for arranging things together. It holds marks,
  sections and groups.
- **Every page, section, group, mark and connector has an `id`.** Ids are unique across the
  whole board. Stickies, shapes and textboxes have `text`.
- Connectors are written in the page, even between marks inside sections and groups:
  `connector id "a-b" from "a" to "b" label "next" {}`.

## Arranging: `layout`

Write `layout` on a page, section or group to say how its direct children are arranged. It is
not inherited; each region chooses its own.

- `layout ROW` / `layout COLUMN`: keep the written order in one row or one column.
- `layout GRID columns 3`: keep the written order, row by row. `columns` goes only with `GRID`.
- `layout FLOW direction RIGHT`: a flow along connectors (`RIGHT`, `LEFT`, `DOWN`, `UP`;
  `RIGHT` by default). `direction` goes only with `FLOW`.
- No `layout` means `AUTO`: the compiler chooses, putting connected things in a flow.

In a `FLOW`, `before ["b" "c"]` on a child makes it come strictly before those siblings. Use it
only for real stage order; connectors already suggest the direction. `before` names siblings in
the same `FLOW` region, never something deeper, and never makes a loop. A return path is just a
connector.

## Marks

- `sticky id "s1" text "…" fill "yellow" {}`: a note. It keeps FigJam's width and grows taller
  for long text.
- `shape id "q" text "Valid?" kind DIAMOND {}`: kinds are `SQUARE` (default),
  `ROUNDED_RECTANGLE`, `ELLIPSE`, `DIAMOND`, `PARALLELOGRAM_RIGHT`, `PREDEFINED_PROCESS`,
  `DOCUMENT_SINGLE`, `ENG_DATABASE`. Shapes grow to hold their text.
- `textbox id "h" text "Heading" font-size LARGE {}`: free text, for headings and notes.
- `font-size`: `SMALL`, `MEDIUM` (default), `LARGE`, `EXTRA_LARGE`, `HUGE`. Colours: hex like
  `"#ffcc00"`, or `"red"`, `"blue"`, `"green"`, `"yellow"`, `"purple"`, `"orange"`, `"pink"`,
  `"white"`, `"black"`, `"gray"`. `opacity` is 0 to 100.

## Connectors

`connector id "…" from "<mark id>" to "<mark id>" {}`, with optional `label`, `line-style DASHED`,
`stroke`, `stroke-width THICK`, `from-cap` and `to-cap` (`NONE`, `ARROW_LINES` default end,
`ARROW_EQUILATERAL`, `TRIANGLE_FILLED`, `CIRCLE_FILLED`, `DIAMOND_FILLED`). Ends are stickies,
shapes or textboxes on the same page, never sections, groups or pages. One connector per pair of
ends; write two connectors for two lines. A connector from a mark to itself is a loop.

## Never write placement

There is no `x`, `y`, `width`, `height`, `from-side`, `to-side`, `line-type`, `waypoints` or
`waypoint` in L0187. To move something, change the structure: put it in a `ROW`, `COLUMN` or
`GRID`, wrap it in a `group`, or order a `FLOW` with `before`.

## Drawing into FigJam

Only when the request names a FigJam file or link, write `save-to-figjam "<link or file key>"` on
its own line before the board. Never invent a link.

```gc
save-to-figjam "https://www.figma.com/board/ABC123xyz/Retro"
board [
  page [
    section [
      sticky id "w1" text "Shipped on time" fill "green" {}
    ] id "went-well" name "Went well" layout COLUMN {}
    section [
      sticky id "i1" text "Flaky tests" fill "pink" {}
    ] id "improve" name "To improve" layout COLUMN {}
  ] id "retro" name "Retro" layout ROW {}
] title "Sprint retro" {}..
```

## Common patterns

A kanban board: sections in a `ROW`, each a `COLUMN` of stickies.

```gc
board [
  page [
    section [
      sticky id "t1" text "Write the spec" {}
      sticky id "t2" text "Draft the API" {}
    ] id "todo" name "To do" layout COLUMN {}
    section [
      sticky id "d1" text "Set up CI" fill "blue" {}
    ] id "doing" name "Doing" layout COLUMN {}
    section [
      sticky id "x1" text "Kickoff" fill "green" {}
    ] id "done" name "Done" layout COLUMN {}
  ] id "board" name "Sprint" layout ROW {}
] title "Sprint board" {}..
```

A decision flow: shapes in a `FLOW`, branches labelled.

```gc
board [
  page [
    shape id "start" text "Request" kind ROUNDED_RECTANGLE {}
    shape id "check" text "Approved?" kind DIAMOND {}
    shape id "ship" text "Ship it" kind ROUNDED_RECTANGLE {}
    shape id "rework" text "Rework" kind ROUNDED_RECTANGLE {}
    connector id "c1" from "start" to "check" {}
    connector id "c2" from "check" to "ship" label "Yes" {}
    connector id "c3" from "check" to "rework" label "No" {}
    connector id "c4" from "rework" to "check" line-style DASHED {}
  ] id "flow" name "Approval" layout FLOW {}
] {}..
```

A small system diagram: services and a database, left to right.

```gc
board [
  page [
    shape id "web" text "Web app" {}
    shape id "api" text "API" kind ROUNDED_RECTANGLE {}
    shape id "db" text "Orders DB" kind ENG_DATABASE {}
    connector id "web-api" from "web" to "api" label "HTTPS" {}
    connector id "api-db" from "api" to "db" label "SQL" {}
  ] id "system" name "System" layout FLOW {}
] {}..
```
