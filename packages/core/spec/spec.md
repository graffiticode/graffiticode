<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# L0183

L0183 is a Graffiticode dialect for **concept webs**: a hub in the centre, nodes on a circle
around it, and lines between them. A node or a line can be a **blank** that the learner fills by
dragging an answer from a tray; the web is then scored, with partial credit per blank.

L0183 succeeds L0169. It is not source-compatible with it.

# Structure

```
concept-web [
  hub [text "The Cell"]
  nodes [
    [text "Nucleus"]
    [assess [expected "Mitochondria"]]
    [assess [expected "Ribosome"]]
  ] distractors ["Chlorophyll"] {}
] title "Parts of a cell" {}..
```

A program is one `concept-web`. Its first argument is an **attribute list** describing the
diagram; its second is the program's **settings**, ending in a record.

L0183 has two kinds of list:

- An **attribute list** is heterogeneous: different named properties of one thing, merged into
  one object, like an element's attributes. `[text "Nucleus" color "blue"]`.
- A **member list** is homogeneous: children of one kind, kept in order, like an element's child
  elements. The word that takes it is arity 2, and its second argument is its own settings,
  ending in a record: `nodes [ [text "A"] [text "B"] ] {}`. The `{}` is the empty settings
  record, not a terminator.

Settings are built by **chaining**: each setting word takes its value and the rest of the
settings, so `] title "Cells" theme DARK {}` computes `{title: "Cells", theme: "dark"}`. Chaining
happens only there.

## Functions

| Function       | Signature                 | Description |
| :------------- | :------------------------ | :---------- |
| `concept-web`  | `<list record: record>`   | The program: the diagram, then its settings |
| `hub`          | `<list: record>`          | The node at the centre |
| `nodes`        | `<list record: record>`   | The nodes around the hub, then the node tray's settings |
| `edges`        | `<list record: record>`   | The lines between nodes, then the label tray's settings |
| `id`           | `<string: record>`        | A node's or edge's name |
| `text`         | `<string: record>`        | What a node shows |
| `shape`        | `<string: record>`        | A node's outline |
| `color`        | `<string: record>`        | A node's colour |
| `size`         | `<string: record>`        | A node's size |
| `from`         | `<string: record>`        | Where an edge starts |
| `to`           | `<string: record>`        | Where an edge ends |
| `label`        | `<string: record>`        | The words on an edge |
| `style`        | `<string: record>`        | How an edge is drawn |
| `assess`       | `<list: record>`          | Makes a node or edge a blank |
| `expected`     | `<string: record>`        | A blank's correct answer |
| `points`       | `<number: record>`        | A blank's worth |
| `title`        | `<string record: record>` | The heading |
| `instructions` | `<string record: record>` | Guidance under the heading |
| `theme`        | `<tag record: record>`    | `DARK` or `LIGHT` |
| `distractors`  | `<list record: record>`   | Wrong answers for a tray |
| `tray`         | `<string record: record>` | Where a tray sits |

# The diagram

## hub

The node at the centre. It takes `text`, `shape`, `color`, `size` and `assess`, and its id is
always `hub`. A web must have one.

## nodes

The nodes around the hub, spaced evenly on a circle starting at the top. Each is an attribute
list taking `id`, `text`, `shape`, `color`, `size` and `assess`. A node has `text` or, if it is a
blank, `assess` — never both. Ids default to `n1`, `n2`, … by position.

```
concept-web [
  hub [text "Primary colours" size "large"]
  nodes [
    [text "Red" color "red" shape "circle"]
    [text "Yellow" color "yellow" shape "circle"]
    [text "Blue" color "blue" shape "circle"]
  ] {}
] {}..
```

`shape` is `"rounded"` (the default), `"rect"`, `"pill"` or `"circle"`. `color` is one of
`"gray"`, `"red"`, `"orange"`, `"amber"`, `"yellow"`, `"green"`, `"teal"`, `"blue"`, `"indigo"`,
`"purple"` or `"pink"`. `size` is `"small"`, `"medium"` or `"large"`; the hub defaults to large.

A `text` that is only an image URL renders as the image. `$…$` spans render as math, with every
backslash doubled: `"$\\sqrt{2}$"`.

## edges

The lines between nodes. Each is an attribute list taking `id`, `from`, `to`, `label`, `style`
and `assess`. `from` and `to` name a node by its id or its exact text; the hub is `"hub"` or its
text. A reference that names no node, or names two, is a compile error.

Without `edges`, every node gets a plain line from the hub. With `edges`, only the lines written
are drawn — including the ones from the hub.

```
concept-web [
  hub [text "Plant"]
  nodes [ [text "Roots"] [text "Leaves"] [text "Water"] ] {}
  edges [
    [from "Plant" to "Roots" label "has"]
    [from "Plant" to "Leaves" label "has"]
    [from "Roots" to "Water" style "dashed-arrow" label "absorb"]
  ] {}
] {}..
```

`style` is `"solid"` (the default), `"dashed"`, `"solid-arrow"` or `"dashed-arrow"`. An arrow
points at `to`. Edge ids default to `e1`, `e2`, … by position.

# Assessment

## assess

`assess [expected "…" points n]` makes a node or an edge a **blank**. A blank node has no `text`
and a blank edge no `label`: it shows an empty slot until the learner drags an answer onto it.
`points` defaults to 1 and must be above 0.

```
concept-web [
  hub [text "Photosynthesis"]
  nodes [
    [id "in1" assess [expected "Carbon dioxide"]]
    [id "in2" assess [expected "Water"]]
    [id "out" assess [expected "Glucose" points 2]]
  ] distractors ["Nitrogen"] {}
  edges [
    [from "in1" to "hub" style "solid-arrow"]
    [from "in2" to "hub" style "solid-arrow"]
    [from "hub" to "out" style "solid-arrow"]
  ] {}
] title "Inputs and outputs" {}..
```

## The trays

There are up to two trays: one of node answers and one of edge labels. Each holds every
`expected` answer of its kind plus that member list's `distractors`, and the view shuffles it.
A tray exists only when its kind has a blank.

`tray` places a tray beside the web: `"right"`, `"left"`, `"top"` or `"bottom"`. The node tray
defaults to right, the label tray to bottom.

```
concept-web [
  hub [text "Force"]
  nodes [ [text "Mass"] [text "Acceleration"] ] {}
  edges [
    [from "Force" to "Mass" assess [expected "equals ÷ acceleration"]]
    [from "Force" to "Acceleration" assess [expected "equals ÷ mass"]]
  ] distractors ["equals × mass"] tray "top" {}
] {}..
```

## Interchangeable blanks

Blanks whose places in the web cannot be told apart — the same kind, and the same lines, drawn
the same way with the same labels, to the same neighbours — **share a pool**. The scorer matches
answers across a pool as a whole, so any arrangement of the right answers is correct. In the
first example above, the two blank spokes of "Parts of a cell" accept "Mitochondria" and
"Ribosome" in either order.

# Settings

`concept-web`'s settings are `title`, `instructions` and `theme`:

```
concept-web [
  hub [text "Energy"]
  nodes [ [text "Kinetic"] [text "Potential"] ] {}
] title "Forms of energy" instructions "Study the web." theme DARK {}..
```

`theme` takes the bare tag `DARK` or `LIGHT`. A setting may also be written in the record
literal: `] {title: "Forms of energy"}..`.

# Output

A program compiles to:

```json
{
  "title": "Parts of a cell",
  "interaction": {
    "type": "concept-web",
    "hub": { "id": "hub", "text": "The Cell" },
    "nodes": [{ "id": "n1", "text": "Nucleus" }, { "id": "n2", "blank": true }],
    "edges": [{ "id": "e1", "from": "hub", "to": "n1", "style": "solid" }],
    "trays": { "nodes": { "items": [{ "id": "c1", "text": "Mitochondria" }], "align": "right" } },
    "cells": { "n2": {} }
  },
  "validation": {
    "points": 1,
    "cells": { "n2": { "assess": { "expected": "Mitochondria", "points": 1 }, "pool": "p1" } }
  }
}
```

`interaction` is what the learner sees; `validation` is the answer key, kept apart so a graded
delivery can withhold it. `interaction.cells` has one entry per blank, and the learner's answer
is its `value`. This is the cell-scoring shape of Graffiticode's Learnosity custom questions, so
an L0176 item can embed an L0183 web with `custom [lang "0183" …]`.
