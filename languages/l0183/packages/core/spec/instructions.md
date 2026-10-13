# L0183 — concept webs

L0183 draws a **concept web**: a hub in the centre, nodes on a circle around it, and lines
between them that may carry labels. Any node or line can be a **blank** that the learner fills by
dragging an answer from a tray, and the filled web is scored.

OUT_OF_SCOPE: flowcharts, timelines, trees, org charts and any diagram whose layout is not a hub
with nodes around it. Free-drawing, where the learner adds nodes or lines of their own, is not
built yet. Multiple choice, short answer and other question types do NOT belong here; use L0180,
or L0176 for Learnosity items. Venn diagrams are L0171.

## The shape of a program

```
concept-web [
  hub text "The Cell" {}
  nodes [
    node text "Nucleus" {}
    node text "Mitochondria" assess [expected] {}
    node text "Chlorophyll" assess [distractor] {}
  ] {}
] title "Parts of a cell" {}..
```

Everything that describes one thing is a **chain**: words, each followed by its value, ending in
`{}`. `text "Nucleus" color "blue" {}` describes one node. Order does not matter.

- `hub`, `node` and `edge` each take one chain: `node text "Nucleus" color "blue" {}`.
- A **member list** holds several things of ONE kind, each written with its word:
  `nodes [ node text "A" {} node text "B" {} ]`. A member list is ALWAYS followed by its
  settings, which are a chain too — write `{}` when there are none.
- `concept-web` takes a list of its parts (`hub`, `nodes`, `edges`), then the program's settings
  chain. So every program ends `] … {}..`.
- `assess` is the one word that takes a bracket list: `assess [expected]`,
  `assess [expected points 2]`, `assess [distractor points -1]`.

**Every `hub`, `node` and `edge` ends in `{}`.** Leaving it off — `node text "B" ]` — is a
parse error ("Too few arguments for TEXT"), because the last word swallows the `]`.

| Target shape                   | How it is written                                             |
| :----------------------------- | :------------------------------------------------------------ |
| one thing                      | a chain ending in `{}` — `hub text "The Cell" color "green" {}` |
| several things of one kind     | a member list of typed members, then settings — `nodes [ node text "A" {} node text "B" {} ] {}` |
| a blank                        | the answer as its text, and `assess [expected]` — `node text "Mitochondria" assess [expected] {}` |
| a wrong answer in the tray     | a member with `assess [distractor]` — `node text "Chlorophyll" assess [distractor] {}` |
| a setting                      | after the `]`, before the record — `] title "Cells" theme DARK {}` |

**Settings go after the closing bracket, never inside it.** `title`, `instructions`, `theme` and
`instant-feedback` follow the `]` of `concept-web`; `tray-align` follows the `]` of `nodes` or `edges`. A word
written in the wrong place is a compile error that says where it goes.

## Functions

| Function       | Signature                 | Description |
| :------------- | :------------------------ | :---------- |
| `concept-web`  | `<list record: record>`   | The program: its parts (hub, nodes, edges), then its settings ending in a record |
| `hub`          | `<record: record>`        | The node at the centre. Its id is always `hub` |
| `nodes`        | `<list record: record>`   | The `node`s around the hub, then the node tray's settings |
| `edges`        | `<list record: record>`   | The `edge`s between nodes, then the label tray's settings. Without it, every node gets a line from the hub |
| `node`         | `<record: record>`        | One node, described by a chain: `node text "Nucleus" {}` |
| `edge`         | `<record: record>`        | One line, described by a chain: `edge from "hub" to "Nucleus" {}` |
| `id`           | `<string record: record>` | A name for a node or edge, so an edge can refer to it |
| `text`         | `<string record: record>` | What a node shows — on a blank, its answer |
| `shape`        | `<string record: record>` | `"rounded"` (default), `"rect"`, `"pill"` or `"circle"` |
| `color`        | `<string record: record>` | `"gray"`, `"red"`, `"orange"`, `"amber"`, `"yellow"`, `"green"`, `"teal"`, `"blue"`, `"indigo"`, `"purple"` or `"pink"` |
| `size`         | `<string record: record>` | `"small"`, `"medium"` or `"large"` |
| `from`         | `<string record: record>` | Where an edge starts: a node's id or exact text |
| `to`           | `<string record: record>` | Where an edge ends: a node's id or exact text |
| `label`        | `<string record: record>` | The words on an edge — on a blank, its answer |
| `style`        | `<string record: record>` | `"solid"` (default), `"dashed"`, `"solid-arrow"` or `"dashed-arrow"` |
| `assess`       | `<list record: record>`   | Scores a node or edge: `assess [expected]` or `assess [distractor]` |
| `expected`     | `<: record>`              | In `assess`: this is a blank, and its text or label is the answer |
| `distractor`   | `<: record>`              | In `assess`: this is a wrong answer, shown only in the tray |
| `points`       | `<number: record>`        | In `assess`: a blank's worth (above 0, default 1), or a distractor's cost (0 or below, default 0) |
| `title`        | `<string record: record>` | Setting of `concept-web`: the heading |
| `instructions` | `<string record: record>` | Setting of `concept-web`: guidance under the heading |
| `theme`        | `<tag record: record>`    | Setting of `concept-web`: the bare tag `DARK` or `LIGHT` |
| `instant-feedback` | `<boolean record: record>` | Setting of `concept-web`: `true` shows right and wrong as each blank is filled; default `false`, feedback waits for Check |
| `tray-align`   | `<tag record: record>`    | Setting of `nodes` or `edges`: where that tray sits — the bare tag `right`, `left`, `top` or `bottom` |

## Which words each container takes

| Container     | Words |
| :------------ | :---- |
| `concept-web` | hub, nodes, edges |
| `hub`         | text, shape, color, size, assess |
| `node`        | id, text, shape, color, size, assess |
| `edge`        | id, from, to, label, style, assess |
| `assess`      | expected, distractor, points |

## Which settings each container takes

| Container     | Settings |
| :------------ | :------- |
| `concept-web` | title, instructions, theme, instant-feedback |
| `nodes`       | tray-align |
| `edges`       | tray-align |

## Guidelines

- **Blanks.** A node with `assess [expected]` is a blank: write its answer as its `text`. The
  learner sees an empty slot; the text is kept as the answer key. A blank edge works the same way
  with its `label`. Ids are `n1`, `n2`, … by position among the drawn nodes.
- **The tray builds itself.** Every blank's answer goes into its tray automatically. Do NOT list
  the answers again.
- **Distractors are members too.** A wrong answer is a `node` (for the node tray) or an `edge`
  (for the label tray) with `assess [distractor]`. It is not drawn: a distractor node takes only
  `text` and `assess`, a distractor edge only `label` and `assess`. `points -1` makes dropping it
  on a blank cost a point. A distractor must not equal an answer, and needs at least one blank of
  its kind.
- **Lines.** Leave out `edges` and every node gets a plain line from the hub. Write `edges` only
  to label lines, style them, join nodes to each other, or make a label a blank — and then write
  EVERY line you want, including the ones from the hub, because `edges` replaces the default.
- **Refer to nodes by text.** `from` and `to` take a node's exact text — a blank's too — or its
  `id`. The hub is `"hub"` or its text. Use an id for two nodes with the same text.
- **Interchangeable blanks.** Blanks the learner cannot tell apart — same place in the web, same
  lines, same labels — accept each other's answers, so any arrangement of the right answers
  scores. You do not need to do anything for this.
- `theme` and `tray-align` take bare tags, `theme DARK`, `tray-align left`, never strings.
- `instant-feedback` takes bare `true` or `false`, never a string. Write it only when the request
  asks for feedback as the learner works; without it, feedback waits for Check.
- Do not shuffle the tray in the program; the view shuffles it.
- Every program ends in `{}..` — the settings record of `concept-web`, then the terminator.

### Math and images

- Wrap math in `$…$`: `text "$x^2$"`. Text outside the delimiters stays prose.
- **Double every backslash** inside a string: `text "$\\frac{1}{2}$"`, `label "$\\sqrt{2}$"`.
  A single backslash is eaten before the web ever sees it — `\t` in `\theta` becomes a tab.
- A `text` that is just an image URL renders as the image. There is no separate
  word for images. An image answer goes in the tray like any other.
- **A URL the author gave you goes in exactly as they wrote it**, whatever its domain. Never judge
  a URL by its host and never rewrite it.
- **Never invent an image URL.** A URL assembled from memory does not resolve, and nothing
  catches it. The one constructible source is country flags:
  `https://flagcdn.com/w320/<ISO 3166-1 alpha-2>.png`. If the author wants pictures but gives no
  URLs, write the node as text naming the picture and say the web needs URLs.

## Example Patterns

- A labelled web with nothing to fill in:
  ```
  concept-web [
    hub text "Water cycle" {}
    nodes [
      node text "Evaporation" {}
      node text "Condensation" {}
      node text "Precipitation" {}
      node text "Collection" {}
    ] {}
  ] title "The water cycle" {}..
  ```
- Blank nodes, with distractors in the tray:
  ```
  concept-web [
    hub text "Mammals" {}
    nodes [
      node text "Whale" assess [expected] {}
      node text "Bat" assess [expected] {}
      node text "Human" assess [expected] {}
      node text "Shark" assess [distractor] {}
      node text "Penguin" assess [distractor points -1] {}
    ] tray-align left {}
  ] instructions "Drag the mammals onto the web." {}..
  ```
- Blank labels on the lines — relation labelling:
  ```
  concept-web [
    hub text "Sun" {}
    nodes [ node text "Plants" {} node text "Earth" {} ] {}
    edges [
      edge from "Sun" to "Plants" style "solid-arrow" label "feeds" assess [expected] {}
      edge from "Sun" to "Earth" style "solid-arrow" label "warms" assess [expected] {}
      edge label "cools" assess [distractor] {}
    ] {}
  ] {}..
  ```
- Nodes joined to each other, with a blank node referred to by its text:
  ```
  concept-web [
    hub text "Food chain" {}
    nodes [
      node text "Grass" {}
      node text "Rabbit" assess [expected] {}
      node text "Fox" {}
      node text "Oak tree" assess [distractor] {}
    ] {}
    edges [
      edge from "hub" to "Grass" {}
      edge from "Grass" to "Rabbit" style "solid-arrow" label "eaten by" {}
      edge from "Rabbit" to "Fox" style "solid-arrow" label "eaten by" {}
    ] {}
  ] theme DARK {}..
  ```
- Styled nodes and math:
  ```
  concept-web [
    hub text "$\\pi$" shape "circle" color "indigo" size "large" {}
    nodes [
      node text "$\\pi r^2$" color "blue" {}
      node text "$2\\pi r$" color "green" {}
      node text "$\\approx 3.14159$" assess [expected points 2] {}
    ] {}
  ] title "Where $\\pi$ appears" {}..
  ```
