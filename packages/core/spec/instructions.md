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
  hub [text "The Cell"]
  nodes [
    [text "Nucleus"]
    [assess [expected "Mitochondria"]]
  ] {}
] title "Parts of a cell" {}..
```

Two kinds of list, and the difference matters:

- An **attribute list** describes ONE thing. Its entries are different words, each applied to a
  value, and they merge into one object: `[text "Nucleus" color "blue"]`. Order does not matter.
- A **member list** holds several things of ONE kind, in order: `nodes [ [text "A"] [text "B"] ] {}`.
  Each member is its own attribute list. A member list is ALWAYS followed by its settings, which
  end in a record — write `{}` when there are none.

`concept-web` takes an attribute list — the diagram — and then the program's settings, ending in
a record. So every program ends `] … {}..`.

| Target shape                   | How it is written                                             |
| :----------------------------- | :------------------------------------------------------------ |
| one thing                      | an attribute list — `hub [text "The Cell" color "green"]`      |
| several things of one kind     | a member list, then settings — `nodes [ [text "A"] [text "B"] ] {}` |
| a scalar                       | the value itself — `text "Nucleus"`, `points 2`               |
| a setting                      | after the `]`, before the record — `] title "Cells" theme DARK {}` |

**Settings go after the closing bracket, never inside it.** `title`, `instructions` and `theme`
follow the `]` of `concept-web`; `distractors` and `tray` follow the `]` of `nodes` or `edges`.
A setting written inside the brackets is a compile error that says where it goes.

## Functions

| Function       | Signature               | Description |
| :------------- | :---------------------- | :---------- |
| `concept-web`  | `<list record: record>` | The program: the diagram (hub, nodes, edges), then its settings ending in a record |
| `hub`          | `<list: record>`        | The node at the centre. Its id is always `hub` |
| `nodes`        | `<list record: record>` | The nodes around the hub, then the node tray's settings |
| `edges`        | `<list record: record>` | The lines between nodes, then the label tray's settings. Without it, every node gets a line from the hub |
| `id`           | `<string: record>`      | A name for a node or edge, so an edge can refer to it |
| `text`         | `<string: record>`      | What a node shows |
| `shape`        | `<string: record>`      | `"rounded"` (default), `"rect"`, `"pill"` or `"circle"` |
| `color`        | `<string: record>`      | `"gray"`, `"red"`, `"orange"`, `"amber"`, `"yellow"`, `"green"`, `"teal"`, `"blue"`, `"indigo"`, `"purple"` or `"pink"` |
| `size`         | `<string: record>`      | `"small"`, `"medium"` or `"large"` |
| `from`         | `<string: record>`      | Where an edge starts: a node's id or exact text |
| `to`           | `<string: record>`      | Where an edge ends: a node's id or exact text |
| `label`        | `<string: record>`      | The words on an edge |
| `style`        | `<string: record>`      | `"solid"` (default), `"dashed"`, `"solid-arrow"` or `"dashed-arrow"` |
| `assess`       | `<list: record>`        | Makes a node or edge a blank: `assess [expected "…"]` |
| `expected`     | `<string: record>`      | The correct answer for a blank |
| `points`       | `<number: record>`      | What a blank is worth. Defaults to 1 |
| `title`        | `<string record: record>` | Setting of `concept-web`: the heading |
| `instructions` | `<string record: record>` | Setting of `concept-web`: guidance under the heading |
| `theme`        | `<tag record: record>`  | Setting of `concept-web`: the bare tag `DARK` or `LIGHT` |
| `distractors`  | `<list record: record>` | Setting of `nodes` or `edges`: wrong answers added to that tray |
| `tray`         | `<string record: record>` | Setting of `nodes` or `edges`: where that tray sits — `"right"`, `"left"`, `"top"` or `"bottom"` |

## Which words each container takes

| Container     | Words |
| :------------ | :---- |
| `concept-web` | hub, nodes, edges |
| `hub`         | text, shape, color, size, assess |
| `node`        | id, text, shape, color, size, assess |
| `edge`        | id, from, to, label, style, assess |
| `assess`      | expected, points |

## Which settings each container takes

| Container     | Settings |
| :------------ | :------- |
| `concept-web` | title, instructions, theme |
| `nodes`       | distractors, tray |
| `edges`       | distractors, tray |

## Guidelines

- **Blanks.** A node or edge with `assess` is a blank. It shows nothing until the learner fills
  it, so a blank node has NO `text` and a blank edge has NO `label`. Give a blank node an `id` if
  an edge needs to refer to it; otherwise it is `n1`, `n2`, … by its position in `nodes`.
- **The tray builds itself.** Every `expected` answer goes into the tray automatically. Do NOT
  list the answers again. Add wrong answers with `distractors`, after the `]` of `nodes` (for
  node answers) or of `edges` (for label answers). A distractor must not equal an answer.
- **Lines.** Leave out `edges` and every node gets a plain line from the hub. Write `edges` only
  to label lines, style them, join nodes to each other, or make a label a blank — and then write
  EVERY line you want, including the ones from the hub, because `edges` replaces the default.
- **Refer to nodes by text.** `from` and `to` take a node's exact text, or its `id`. The hub is
  `"hub"` or its text. Use an id for a blank node (it has no text) and for two nodes with the
  same text.
- **Interchangeable blanks.** Blanks the learner cannot tell apart — same place in the web, same
  lines, same labels — accept each other's answers, so any arrangement of the right answers
  scores. You do not need to do anything for this.
- `theme` takes a bare tag, `theme DARK`, never the string `theme "dark"`.
- Do not shuffle the tray in the program; the view shuffles it.
- Lists are space-separated: `distractors ["Golgi" "Lysosome"]`, no commas.
- Every program ends in `{}..` — the settings record of `concept-web`, then the terminator.

### Math and images

- Wrap math in `$…$`: `text "$x^2$"`. Text outside the delimiters stays prose.
- **Double every backslash** inside a string: `text "$\\frac{1}{2}$"`, `expected "$\\sqrt{2}$"`.
  A single backslash is eaten before the web ever sees it — `\t` in `\theta` becomes a tab.
- A `text` or `expected` that is just an image URL renders as the image. There is no separate
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
    hub [text "Water cycle"]
    nodes [ [text "Evaporation"] [text "Condensation"] [text "Precipitation"] [text "Collection"] ] {}
  ] title "The water cycle" {}..
  ```
- Blank nodes, with distractors in the tray:
  ```
  concept-web [
    hub [text "Mammals"]
    nodes [
      [assess [expected "Whale"]]
      [assess [expected "Bat"]]
      [assess [expected "Human"]]
    ] distractors ["Shark" "Penguin"] tray "left" {}
  ] instructions "Drag the mammals onto the web." {}..
  ```
- Blank labels on the lines — relation labelling:
  ```
  concept-web [
    hub [text "Sun"]
    nodes [ [text "Plants"] [text "Earth"] ] {}
    edges [
      [from "Sun" to "Plants" style "solid-arrow" assess [expected "feeds"]]
      [from "Sun" to "Earth" style "solid-arrow" assess [expected "warms"]]
    ] distractors ["cools"] {}
  ] {}..
  ```
- Nodes joined to each other, with a blank node referred to by id:
  ```
  concept-web [
    hub [text "Food chain"]
    nodes [
      [text "Grass"]
      [id "herbivore" assess [expected "Rabbit"]]
      [text "Fox"]
    ] distractors ["Oak tree"] {}
    edges [
      [from "hub" to "Grass"]
      [from "Grass" to "herbivore" style "solid-arrow" label "eaten by"]
      [from "herbivore" to "Fox" style "solid-arrow" label "eaten by"]
    ] {}
  ] theme DARK {}..
  ```
- Styled nodes and math:
  ```
  concept-web [
    hub [text "$\\pi$" shape "circle" color "indigo" size "large"]
    nodes [
      [text "$\\pi r^2$" color "blue"]
      [text "$2\\pi r$" color "green"]
      [assess [expected "$\\approx 3.14159$" points 2]]
    ] {}
  ] title "Where $\\pi$ appears" {}..
  ```
