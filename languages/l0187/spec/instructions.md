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
  `show-page-tabs`, `show-page-menu` and `layout-profile` (see "Writing the text").
- `page [ … ] id "…" name "…" {}`: every page has an `id` and a `name`. Its list holds `sticky`,
  `shape`, `textbox`, `section`, `group` and `connector`. `background "gray"` colours the page.
- `section [ … ] id "…" name "…" {}`: a visible, titled area, with optional `fill` and `opacity`.
  It holds marks and groups, never another section, never connectors.
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
  A `textbox` written first in a `GRID` becomes its heading, on a row of its own.
- `layout FLOW direction RIGHT`: a flow along connectors (`RIGHT`, `LEFT`, `DOWN`, `UP`;
  `RIGHT` by default). `direction` goes only with `FLOW`.
- No `layout` means `AUTO`: the compiler chooses, putting connected things in a flow.

**Keep boards compact.** A board is read on one screen, so arrange a page with more than three
sections or groups as a `GRID` (`columns 2` or `columns 3`), or leave it `AUTO`; never stack many
sections in a page-level `COLUMN` or `ROW`, which makes one very tall or very wide strip. Inside a
section, use `COLUMN` for up to four notes and `GRID columns 2` (or `3`) for more, so no section
grows much taller than its neighbours; use `ROW` or `FLOW` for a short sequence of stages. Put a
long list in one sticky or textbox, or split it into a few stickies in a `GRID`, rather than one
sticky per word.

A `FLOW` of more than three shapes is wide, and a section takes the width of its widest child, so
notes stacked above or below that flow in the same `COLUMN` leave a wide empty area beside them.
Give the flow a section of its own, or put the notes that share its section in a
`group [ … ] id "…" layout ROW {}` so they sit side by side across the flow's width.

Connectors read best when they don't cross. A page `GRID` keeps the written order, so write the
sections that connectors join next to each other: a section whose last step leads into another
section comes right before it, and a decision comes right before the steps it opens. Fewer
connectors between distant sections means fewer crossings.

In a `FLOW`, `before ["b" "c"]` on a child makes it come strictly before those siblings. Use it
only for real stage order; connectors already suggest the direction. `before` names siblings in
the same `FLOW` region, never something deeper, and never makes a loop. A return path is just a
connector.

## Marks

- `sticky id "s1" text "…" fill "yellow" {}`: a note. It keeps FigJam's width and grows taller
  for long text.
- `shape id "q" text "Valid?" kind DIAMOND {}`: kinds are `SQUARE` (default),
  `ROUNDED_RECTANGLE`, `ELLIPSE`, `DIAMOND`, `PARALLELOGRAM_RIGHT`, `PREDEFINED_PROCESS`,
  `DOCUMENT_SINGLE`, `ENG_DATABASE`. Shapes grow to hold their text. Optional `fill`, `stroke`
  (outline colour) and `stroke-width THICK`.
- **Keep shape text short.** A shape is a label, not a paragraph: a few words. A `DIAMOND` is a
  decision and holds only a short question of about five words (`"Autorização obtida?"`): its
  text fits only in the middle of the shape, so a sentence makes it several times larger than
  everything around it. Put the detail in a sticky next to the diamond, in the same section,
  rather than in the diamond itself.
- `textbox id "h" text "Heading" font-size LARGE {}`: free text, for headings and notes; `color`
  sets its text colour.
- `font-size`: `SMALL`, `MEDIUM` (default), `LARGE`, `EXTRA_LARGE`, `HUGE`. Colours: hex like
  `"#ffcc00"`, or `"red"`, `"blue"`, `"green"`, `"yellow"`, `"purple"`, `"orange"`, `"pink"`,
  `"white"`, `"black"`, `"gray"`. `opacity` is 0 to 100, on marks, sections and connectors.
- Every colour property: `fill` on stickies, shapes and sections; `stroke` on shapes and
  connectors; `color` on textboxes; `background` on pages.

## Writing the text

Write every `text`, `name`, `label` and `title` in the language the request uses, spelled
correctly with all its accents and letters (`"Missão"`, `"decisões"`, `"segurança"`, `"Größe"`,
`"élève"`), never stripped to plain ASCII: a lost accent can change the meaning (`"não é"`, "is
not", is not `"nao e"`). Use ordinary sentence case, not all capitals; a section's `name` already
serves as its heading.

Use that language's own words, even where the request writes an English term in passing: in
Portuguese `"Salvaguardas"`, not `"Guardrails"`; `"Alternativa offline"`, not `"Fallback"`;
`"Painel"`, not `"Dashboard"`. Keep proper names, acronyms and product names as given (`"DHIS2"`,
`"UNESCO"`, `"FigJam"`).

When the request asks for a language, or quotes the labels to use, that is the board's language,
even when the rest of the request is in English: copy quoted labels exactly, with their
punctuation (`·`, `→`, `，`, `？`). For Chinese or Japanese text, write `layout-profile FIGJAM_V2`
in the board's settings; it measures those characters, and the default profile does not. Never
translate the text into English or another script to make a board compile.

```gc
board [
  page [
    shape id "api" text "新业务 API" kind ROUNDED_RECTANGLE {}
    shape id "db" text "新业务库 edu-game-fixed" kind ENG_DATABASE {}
    connector id "api-db" from "api" to "db" label "业务读写" {}
  ] id "p1" name "新系统" layout FLOW {}
] title "两套业务库" layout-profile FIGJAM_V2 {}..
```

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
