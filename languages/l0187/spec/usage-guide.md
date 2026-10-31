<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0187 usage guide

## Overview

L0187 makes FigJam boards from what they contain: sticky notes, shapes, text, titled sections,
invisible groups and labelled connectors, on one or more pages. Ask for the content, how it is
grouped, what connects to what and which order matters — the compiler measures the text, lays the
board out, routes the connectors and checks that nothing overlaps. You never give positions or
sizes. The board is previewed as a picture and can be drawn into a FigJam file with the
Graffiticode FigJam plugin.

## What to ask for

- Retrospectives, kanban boards and workshop pages: titled columns of sticky notes.
- Comparisons and agendas: sections side by side, grids of notes, headings.
- Process and decision flows: steps, decisions, labelled branches, return paths.
- Small system diagrams: services, databases and the connections between them.
- Boards with several pages, shown as tabs.
- Drawing the board into a FigJam file you link.

## What it does not do

- Exact positions, sizes or routes: placement is the compiler's. For a drawing with coordinates,
  use L0186.
- Reaction stamps, images, tables, sections inside sections, or editing an existing board.
- Charts (L0184), spreadsheets (L0179), quizzes (L0180), concept maps with answers (L0183).

## Example

"A sprint retro with Went well, To improve and Action items columns, two notes in each."

```gc
board [
  page [
    section [
      sticky id "w1" text "Shipped on time" fill "green" {}
      sticky id "w2" text "Pairing helped" fill "green" {}
    ] id "went-well" name "Went well" layout COLUMN {}
    section [
      sticky id "i1" text "Flaky tests" fill "pink" {}
      sticky id "i2" text "Late reviews" fill "pink" {}
    ] id "improve" name "To improve" layout COLUMN {}
    section [
      sticky id "a1" text "Quarantine flaky tests" fill "blue" {}
      sticky id "a2" text "Review within a day" fill "blue" {}
    ] id "actions" name "Action items" layout COLUMN {}
  ] id "retro" name "Retro" layout ROW {}
] title "Sprint retro" {}..
```
