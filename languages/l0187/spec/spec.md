<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0187 Specification

L0187 builds **declarative FigJam boards**. A program declares content, membership, connections
and meaningful order; the compiler measures the content, arranges it, routes the connectors and
validates the result before returning a positioned board. Coordinates, sizes, spacing and
connector routes are compiled output, never source.

# Program

A program constructs exactly one `board`, ending in `..`. Optionally, one `save-to-figjam`
statement names the FigJam file to draw the board into, on its own line before the board.

```gc
board [
  page [
    sticky id "idea" text "Idea" {}
    sticky id "plan" text "Plan" {}
    connector id "idea-plan" from "idea" to "plan" label "develop" {}
  ] id "planning" name "Planning" layout FLOW direction RIGHT {}
] title "Planning board" layout-profile FIGJAM_V1 {}..
```

There are four construct shapes:

| Construct | Arity | Form |
| --- | --- | --- |
| Container | 2 | `section [ members ] settings {}` |
| Typed member | 1 | `sticky id "a" text "A" {}` |
| Property | 2 | `text "A" fill "yellow" {}` |
| Closed-set tag | 0 | `DIAMOND`, `ROW`, `RIGHT` |

**Every member description and every container settings chain ends in `{}`.** Properties may
appear in any order, once each. Shared base-language expressions and bindings remain available
(`set-var`, `get-var`); evaluated values are checked exactly as literal ones.

# Words

| Word | Arity | Meaning |
| --- | --- | --- |
| `board` | 2 | Ordered pages and board settings. |
| `page` | 2 | One independently arranged canvas and its settings. |
| `section` | 2 | A visible, named container; its title and border participate in layout. |
| `group` | 2 | An invisible layout region; contributes structure and bounds, with no visible frame or title. |
| `sticky` | 1 | A sticky note containing plain text. |
| `shape` | 1 | A text-bearing diagram shape. |
| `textbox` | 1 | Standalone plain text, measured and wrapped by the compiler. |
| `connector` | 1 | One relationship between two marks on the same page. |
| `save-to-figjam` | 1 | A top-level statement naming the destination file. |

| Container | Allowed children |
| --- | --- |
| `board` | `page` |
| `page` | `sticky`, `shape`, `textbox`, `section`, `group`, `connector` |
| `section` | `sticky`, `shape`, `textbox`, `group` |
| `group` | `sticky`, `shape`, `textbox`, `section`, `group` |

Connectors are written directly in the page, including those between marks deep inside its
groups and sections. A section cannot have another section anywhere beneath it, including through
a group. Groups may nest within groups and sections.

## Properties

All property words have arity 2: a value, then the rest of the description.

| Word | Value | Meaning |
| --- | --- | --- |
| `id` | Nonempty string | Explicit semantic identity. |
| `text` | String, including empty | Full plain-text content of a mark. |
| `name` | Nonempty string | Display name of a page or section. |
| `title` | Nonempty string | Board title metadata. |
| `kind` | Shape tag | Shape outline; default `SQUARE`. |
| `layout` | Layout tag | Structural arrangement of a region's direct placeable children. |
| `direction` | Direction tag | Preferred progression axis of an explicit `FLOW`. |
| `columns` | Positive integer | Structural column count of a `GRID`. |
| `before` | Nonempty list of ID strings | Strict precedence over named siblings in an explicit `FLOW`. |
| `from`, `to` | One ID string each | Source and target mark of a connector. |
| `label` | String, including empty | Full connector label. |
| `fill` | Color string | Sticky, shape, or section fill. |
| `stroke` | Color string | Shape outline or connector stroke. |
| `color` | Color string | Textbox text color. |
| `background` | Color string | Page background. |
| `opacity` | Number from 0 to 100 | Presentation opacity; does not remove an object from layout. |
| `font-size` | Font-size tag | Requested text size; no numeric override. |
| `stroke-width` | Stroke-width tag | Stroke weight; no numeric override. |
| `line-style` | Line-style tag | Solid or dashed connector presentation. |
| `from-cap`, `to-cap` | Cap tag | Endpoint decoration. |
| `show-page-tabs`, `show-page-menu` | Boolean | Page navigation in the preview. |
| `layout-profile` | Profile tag | Immutable measurement, layout, and validation policy bundle. |

| Description | Allowed properties |
| --- | --- |
| `sticky` | `id`, `text`, `fill`, `opacity`, `font-size`, `before` |
| `shape` | `id`, `text`, `kind`, `fill`, `stroke`, `stroke-width`, `opacity`, `font-size`, `before` |
| `textbox` | `id`, `text`, `color`, `opacity`, `font-size`, `before` |
| `connector` | `id`, `from`, `to`, `label`, `stroke`, `stroke-width`, `opacity`, `font-size`, `line-style`, `from-cap`, `to-cap` |

| Container settings | Allowed properties |
| --- | --- |
| `board` | `title`, `show-page-tabs`, `show-page-menu`, `layout-profile` |
| `page` | `id`, `name`, `background`, `layout`, `direction`, `columns` |
| `section` | `id`, `name`, `fill`, `opacity`, `layout`, `direction`, `columns`, `before` |
| `group` | `id`, `layout`, `direction`, `columns`, `before` |

`id` is required on every page, section, group, mark and connector. `text` is required on
stickies, shapes and textboxes. `name` is required on pages and sections. `from` and `to` are
required on connectors. A board requires at least one page; pages and regions may be empty.

# Tags

| Property | Initial tags |
| --- | --- |
| `layout` | `AUTO`, `ROW`, `COLUMN`, `GRID`, `FLOW` |
| `direction` | `RIGHT`, `LEFT`, `DOWN`, `UP` |
| `kind` | `SQUARE`, `ROUNDED_RECTANGLE`, `ELLIPSE`, `DIAMOND`, `PARALLELOGRAM_RIGHT`, `PREDEFINED_PROCESS`, `DOCUMENT_SINGLE`, `ENG_DATABASE` |
| `font-size` | `SMALL`, `MEDIUM`, `LARGE`, `EXTRA_LARGE`, `HUGE` |
| `stroke-width` | `THIN`, `THICK` |
| `line-style` | `SOLID`, `DASHED` |
| `from-cap`, `to-cap` | `NONE`, `ARROW_LINES`, `ARROW_EQUILATERAL`, `TRIANGLE_FILLED`, `CIRCLE_FILLED`, `DIAMOND_FILLED` |
| `layout-profile` | `FIGJAM_V1` |

Tags are bare and uppercase. Colors are three- or six-digit hex strings, or one of `"red"`,
`"blue"`, `"green"`, `"yellow"`, `"purple"`, `"orange"`, `"pink"`, `"white"`, `"black"`,
`"gray"`. Font sizes are 16, 24, 40, 64 and 96 pixels; marks default to `MEDIUM` and connector
labels to `SMALL`. Strokes are 4 and 8 pixels; connectors default to `THIN`, `SOLID`, no start cap
and an `ARROW_LINES` end cap.

# Identity

There is one board-wide namespace across pages, sections, groups, marks and connectors. Ids are
case-sensitive strings, compared exactly. Whitespace-only ids are invalid, surrounding whitespace
is rejected, and `"*"` is reserved. Display names may repeat; references always use ids.

Connector endpoints are stickies, shapes and textboxes on the same page, including descendants of
any region. Forward references are valid. Parallel connectors and self-loops are valid.

# Layout

Every page, section and group is a layout region. Its placeable children are its direct marks,
sections and groups; connectors do not occupy sequence slots.

- `AUTO` (the default): unordered. Children joined by connectors are arranged as a flow; the rest
  are packed. Source order only breaks ties.
- `ROW`, `COLUMN`: the written order, left to right or top to bottom, without wrapping.
- `GRID`: the written order, row by row, in exactly `columns` columns.
- `FLOW`: connectors give the preferred progression along `direction` (`RIGHT` by default);
  `before` gives strict order. Declaration order only breaks ties.

`layout` defaults to `AUTO` in each region and is not inherited. `columns` is legal only with
`GRID`, which requires it; `direction` only with `FLOW`. `before` is legal only on a direct child
of an explicit `FLOW` region and names siblings in that region; strict order may not cycle,
connections may.

```gc
board [
  page [
    shape id "fetch" text "Fetch data" kind ROUNDED_RECTANGLE before ["valid"] {}
    shape id "valid" text "Valid?" kind DIAMOND before ["save" "error"] {}
    shape id "save" text "Save result" kind ROUNDED_RECTANGLE {}
    shape id "error" text "Report error" kind ROUNDED_RECTANGLE {}
    connector id "fetch-valid" from "fetch" to "valid" {}
    connector id "valid-save" from "valid" to "save" label "Yes" {}
    connector id "valid-error" from "valid" to "error" label "No" {}
    connector id "retry" from "error" to "fetch" label "Retry" line-style DASHED {}
  ] id "processing" name "Processing" layout FLOW direction RIGHT {}
] layout-profile FIGJAM_V1 {}..
```

A strict-order cycle is an error; a connector can show the return path instead:

```gc-invalid strict-cycle
board [
  page [
    shape id "a" text "A" before ["b"] {}
    shape id "b" text "B" before ["a"] {}
  ] id "cycle" name "Invalid order" layout FLOW {}
] layout-profile FIGJAM_V1 {}..
```

Sections and groups compose: a parent places each child region's measured extent as one block.

```gc
board [
  page [
    textbox id "heading" text "Workshop agenda" font-size LARGE {}
    group [
      section [
        textbox id "goal" text "Agree on the release scope" {}
      ] id "goals" name "Goals" {}
      section [
        sticky id "scope" text "Discuss scope" {}
        sticky id "risk" text "Review risks" {}
        sticky id "owner" text "Assign owners" {}
      ] id "topics" name "Topics" layout GRID columns 2 {}
    ] id "agenda-panels" layout ROW {}
  ] id "agenda" name "Agenda" layout COLUMN {}
] layout-profile FIGJAM_V1 {}..
```

# Geometry is compiled

The authoring vocabulary excludes `x`, `y`, `width`, `height`, `from-side`, `to-side`, `line-type`, `waypoints`, and `waypoint`. It also excludes numeric offsets, pinning, rotation, manual ports,
gaps, padding and bounding boxes. Such fields are rejected however they arrive: as words, in
records, through bindings or from upstream data.

```gc-invalid removed-geometry
board [
  page [
    sticky id "a" text "A" x 10 {}
  ] id "p1" name "Page" {}
] {}..
```

The compiler measures full text with the profile's font, wraps it and grows regions; it never
shrinks text, truncates it, or substitutes another shape. Stickies keep FigJam's width and grow
taller; shapes are sized to hold their text; textboxes wrap at a measure proportional to their
font size.

# Profiles

`layout-profile FIGJAM_V1` selects an immutable bundle of measurement, sizing, spacing, layout,
routing and validation policy. Omitting the property means `FIGJAM_V1`, never "latest". The same
program and profile always compile to the same board.

# Saving to FigJam

`save-to-figjam` takes a FigJam file key or a figma.com link, appears at most once before the
board, and is never a property or a member. Without it the board is a preview.

```gc
save-to-figjam "https://www.figma.com/board/ABC123xyz/Planning"
board [
  page [
    sticky id "kickoff" text "Kickoff" {}
  ] id "p1" name "Planning" {}
] {}..
```

# Output

A program compiles to a positioned board (`schema.json`): every mark with its box, its wrapped
lines and its text area; every section with its border and title band; every connector with its
side magnets, waypoints, modeled route and label box; and the validator's report. Only a board
the independent validator accepts is returned. Diagnostics carry a `category` (`source`,
`content-limit`, `layout`, `resource`) and a `code` naming the rule.
