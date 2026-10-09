<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0186 usage guide

## Overview

L0186 makes FigJam boards: sticky notes, text, shapes with text (flowchart, engineering and
decorative shapes), sections that group them, reaction stamps, and connectors between them, on
one page or several. Describe what should be on the board and roughly where — "a retro with three
columns of stickies", "a flowchart from Start through a Valid? decision" — and it lays the board
out and shows a picture of it. To put the board in FigJam, give the link of a FigJam file: the
Graffiticode FigJam plugin, opened in that file, draws the board there.

## What to ask for

- The nodes and what they say: stickies, headings, shapes (a decision diamond, a database, a
  rounded start box), stamps.
- How they connect: arrows with labels, two-way arrows, dashed or elbowed lines, one node to many, lines routed through given points.
- How they are grouped: sections with names, and pages for separate parts of the work.
- Colours, sizes and emphasis.
- A FigJam link, if the board should be drawn into a FigJam file.

## What it does not do

- It does not edit Figma design files or other whiteboards.
- It does not read what is already on a FigJam board; it adds the board it describes.
- Images, tables, comments and automatic layout are not built yet.
- It does not make concept maps to complete (L0183), charts (L0184), spreadsheets (L0179) or quiz
  questions (L0180).

## Example

```
board [
  page [
    sticky id "a" text "Plan" x 0 y 0 {}
    sticky id "b" text "Build" x 300 y 0 {}
    connector from "a" to "b" label "then" {}
  ] {}
] {}..
```
