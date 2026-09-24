<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# L0183

L0183 is a Graffiticode dialect for **concept webs**: a hub in the centre, nodes on a circle
around it, and lines between them. A node or a line can be a **blank** that the learner fills by
dragging an answer from a tray; the web is then scored, with partial credit per blank.

L0183 succeeds L0169. It is not source-compatible with it.

# Structure

```
concept-web [
  hub text "The Cell" {}
  nodes [
    node text "Nucleus" {}
    node text "Mitochondria" assess [expected] {}
    node text "Ribosome" assess [expected] {}
    node text "Chlorophyll" assess [distractor] {}
  ] {}
] title "Parts of a cell" {}..
```

A program is one `concept-web`. Its first argument is a list of its parts — `hub`, `nodes` and
`edges`; its second is the program's **settings**, ending in a record.

Everything that describes one thing is a **chain**: each word takes its value and the rest of
the chain, and the chain ends in a record. `text "Nucleus" color "blue" {}` computes
`{text: "Nucleus", color: "blue"}`. Settings are chains too, so `] title "Cells" theme DARK {}`
computes `{title: "Cells", theme: "dark"}`.

- `hub`, `node` and `edge` each take a chain and give it a type: `node text "Nucleus" {}`.
- A **member list** is homogeneous and typed: children of one kind, kept in order, each written
  with its word. The container is arity 2, and its second argument is its own settings, ending
  in a record: `nodes [ node text "A" {} node text "B" {} ] {}`. The `{}` is the empty settings
  record, not a terminator.
- `assess` is the one word whose value is a bracket list: `assess [expected points 2]`.

A chain word written last before a `]`, without its `{}`, swallows the bracket and fails to
parse. Every `hub`, `node` and `edge` ends in `{}`.

## Functions

| Function       | Signature                 | Description |
| :------------- | :------------------------ | :---------- |
| `concept-web`  | `<list record: record>`   | The program: its parts, then its settings |
| `hub`          | `<record: record>`        | The node at the centre |
| `nodes`        | `<list record: record>`   | The nodes around the hub, then the node tray's settings |
| `edges`        | `<list record: record>`   | The lines between nodes, then the label tray's settings |
| `node`         | `<record: record>`        | One node |
| `edge`         | `<record: record>`        | One line |
| `id`           | `<string record: record>` | A node's or edge's name |
| `text`         | `<string record: record>` | What a node shows, or a blank's answer |
| `shape`        | `<string record: record>` | A node's outline |
| `color`        | `<string record: record>` | A node's colour |
| `size`         | `<string record: record>` | A node's size |
| `from`         | `<string record: record>` | Where an edge starts |
| `to`           | `<string record: record>` | Where an edge ends |
| `label`        | `<string record: record>` | The words on an edge, or a blank's answer |
| `style`        | `<string record: record>` | How an edge is drawn |
| `assess`       | `<list record: record>`   | Makes a node or edge a blank or a distractor |
| `expected`     | `<: record>`              | Marks a blank |
| `distractor`   | `<: record>`              | Marks a wrong answer |
| `points`       | `<number: record>`        | A blank's worth, or a distractor's cost |
| `title`        | `<string record: record>` | The heading |
| `instructions` | `<string record: record>` | Guidance under the heading |
| `theme`        | `<tag record: record>`    | `DARK` or `LIGHT` |
| `tray-align`   | `<tag record: record>`    | Where a tray sits |

# The diagram

## hub

The node at the centre. It takes `text`, `shape`, `color`, `size` and `assess`, and its id is
always `hub`. A web must have one.

## nodes

The nodes around the hub, spaced evenly on a circle starting at the top. Each is a `node`
taking `id`, `text`, `shape`, `color`, `size` and `assess`. Every node has `text`. Ids default
to `n1`, `n2`, … by position among the drawn nodes.

```
concept-web [
  hub text "Primary colours" size "large" {}
  nodes [
    node text "Red" color "red" shape "circle" {}
    node text "Yellow" color "yellow" shape "circle" {}
    node text "Blue" color "blue" shape "circle" {}
  ] {}
] {}..
```

`shape` is `"rounded"` (the default), `"rect"`, `"pill"` or `"circle"`. `color` is one of
`"gray"`, `"red"`, `"orange"`, `"amber"`, `"yellow"`, `"green"`, `"teal"`, `"blue"`, `"indigo"`,
`"purple"` or `"pink"`. `size` is `"small"`, `"medium"` or `"large"`; the hub defaults to large.

A `text` that is only an image URL renders as the image. `$…$` spans render as math, with every
backslash doubled: `"$\\sqrt{2}$"`.

## edges

The lines between nodes. Each is an `edge` taking `id`, `from`, `to`, `label`, `style` and
`assess`. `from` and `to` name a node by its id or its exact text; the hub is `"hub"` or its
text. A reference that names no node, or names two, is a compile error.

Without `edges`, every node gets a plain line from the hub. With `edges`, only the lines written
are drawn — including the ones from the hub.

```
concept-web [
  hub text "Plant" {}
  nodes [ node text "Roots" {} node text "Leaves" {} node text "Water" {} ] {}
  edges [
    edge from "Plant" to "Roots" label "has" {}
    edge from "Plant" to "Leaves" label "has" {}
    edge from "Roots" to "Water" style "dashed-arrow" label "absorb" {}
  ] {}
] {}..
```

`style` is `"solid"` (the default), `"dashed"`, `"solid-arrow"` or `"dashed-arrow"`. An arrow
points at `to`. Edge ids default to `e1`, `e2`, … by position among the drawn edges.

# Assessment

## assess

`assess [expected]` makes a node or an edge a **blank**. Its own `text` (or `label`) is the
answer: the compiler moves it into the answer key and draws an empty slot until the learner
drags an answer onto it. `points` is what the blank is worth; it defaults to 1 and must be
above 0.

`assess [distractor]` makes a node or an edge a **distractor**: a wrong answer that sits in the
tray and is not drawn. A distractor node takes only `text` and `assess`; a distractor edge only
`label` and `assess`. Its `points` is what dropping it on a blank costs; it defaults to 0 and
must be 0 or below. A distractor may not equal an answer.

```
concept-web [
  hub text "Photosynthesis" {}
  nodes [
    node id "in1" text "Carbon dioxide" assess [expected] {}
    node id "in2" text "Water" assess [expected] {}
    node id "out" text "Glucose" assess [expected points 2] {}
    node text "Nitrogen" assess [distractor points -1] {}
  ] {}
  edges [
    edge from "in1" to "hub" style "solid-arrow" {}
    edge from "in2" to "hub" style "solid-arrow" {}
    edge from "hub" to "out" style "solid-arrow" {}
  ] {}
] title "Inputs and outputs" {}..
```

## The trays

There are up to two trays: one of node answers and one of edge labels. Each holds every blank's
answer of its kind plus that member list's distractors, and the view shuffles it. A tray exists
only when its kind has a blank.

`tray-align` places a tray beside the web: `right`, `left`, `top` or `bottom`, written as bare
tags. It is a setting of `nodes` or `edges`. The node tray defaults to right, the label tray to
bottom.

```
concept-web [
  hub text "Force" {}
  nodes [ node text "Mass" {} node text "Acceleration" {} ] {}
  edges [
    edge from "Force" to "Mass" label "equals ÷ acceleration" assess [expected] {}
    edge from "Force" to "Acceleration" label "equals ÷ mass" assess [expected] {}
    edge label "equals × mass" assess [distractor] {}
  ] tray-align top {}
] {}..
```

## Scoring

Each blank filled with a right answer scores its `points`. A blank holding a distractor from
its own tray scores that distractor's `points`, so `points -1` makes a tempting wrong answer
cost a point. Any other wrong answer, or an empty blank, scores 0. The web's total never goes
below 0.

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
  hub text "Energy" {}
  nodes [ node text "Kinetic" {} node text "Potential" {} ] {}
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
    "trays": {
      "nodes": {
        "items": [{ "id": "c1", "text": "Mitochondria" }, { "id": "c2", "text": "Chlorophyll" }],
        "align": "right"
      }
    },
    "cells": { "n2": {} }
  },
  "validation": {
    "points": 1,
    "cells": {
      "n2": { "assess": { "expected": "Mitochondria", "points": 1 }, "pool": "p1", "tray": "nodes" }
    },
    "distractors": { "nodes": { "Chlorophyll": 0 } }
  }
}
```

`interaction` is what the learner sees; `validation` is the answer key, kept apart so a graded
delivery can withhold it — which is why a blank's text is missing from its drawn node.
`interaction.cells` has one entry per blank, and the learner's answer is its `value`.
`validation.distractors` holds each tray's distractor costs. This is the cell-scoring shape of
Graffiticode's Learnosity custom questions, so an L0176 item can embed an L0183 web with
`custom [lang "0183" …]`.
