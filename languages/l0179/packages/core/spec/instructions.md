<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0179 — interactive spreadsheets

L0179 authors interactive spreadsheets: cell grids with text, formatting, and formulas, plus
optional assessed cells that grade what a learner types.

OUT_OF_SCOPE: assessment ITEMS or QUESTIONS as content (multiple-choice, reading passages, stems,
answer keys, rubric-scored prose); charts and visualizations; pivot tables; cross-sheet
references; database tables, CSV editors, or query builders; macros and user-defined functions.
L0179 authors a spreadsheet INTERACTION, not question items. If the request is for one of these,
say so instead of emitting a program.

## The shape of a program

Every program is one `sheets` list holding one or more `sheet`s. Each sheet's body is a list of
attributes; anything that describes the whole program goes **after** the closing `]`:

```
sheets [
  sheet "s1" [
    columns [
      column A [width 200 align "right"]
    ] {}
    cells [
      cell A1 [text "Revenue" font-weight "bold"]
      cell B1 [text "=SUM(B2:B4)"]
    ] {}
  ]
] title "Quarterly Totals" {
  "v": "0.0.1"
}..
```

**`title` and `instructions` go after the `]`, never inside a sheet.** They name the program, and
a program can have several sheets. Writing `title` inside a `sheet [...]` is an error.

For more than one sheet, add `sheet` entries and give each a `name` for its tab:

```
sheets [
  sheet "s1" [
    name "Revenue"
    cells [ cell A1 [text "Q1"] ] {}
  ]
  sheet "s2" [
    name "Costs"
    cells [ cell A1 [text "Rent"] ] {}
  ]
] title "Quarterly Totals" {
  "v": "0.0.1"
}..
```

Each sheet needs its own id, and the ids must differ. A tab strip appears once there are two or
more sheets; a sheet menu is always there. `show-sheet-tabs <bool>` and `hide-sheet-menu <bool>`, both
written after the `]`, override that.

## Three rules cover the whole syntax

1. **An attribute is a word applied to a value**, written inside a `[...]` list:
   `text "Revenue"`, `width 200`, `points 2`. Order does not matter.
2. **A cell, column, or row is its name followed by its attribute list**:
   `cell A1 [text "10"]`, `column A [width 100]`, `row 1 [font-weight "bold"]`.
   A cell with no attributes is `cell B1 []`.
3. **`cells`, `columns`, and `rows` are lists of those, each followed by `{}`**:
   `cells [ cell A1 [...] cell A2 [...] ] {}`. The `{}` is the block's configuration and is
   almost always empty — write it anyway.

There is no chaining. An attribute never takes the rest of the program.

## Attributes

**On a cell** — `text`, `assess`, and the presentation attributes below.
**On a column or row** — the presentation attributes, plus `assess` to set defaults for the
cells in it.
**On the sheet** — `title`, `instructions`, `hide-formulabar`, and the `columns` / `rows` /
`cells` blocks.

Presentation: `width`, `align`, `background-color`, `font-weight`, `font-size`, `font-family`,
`font-style`, `color`, `text-decoration`, `border`, `vertical-align`, `format`, `protected`.

Values are CSS, written as strings, with two exceptions taking bare literals: `width` a number,
and `protected` a `true` or `false`. Quoting either is a compile error:

```
column A [width 200]
cell A1 [font-size "14px" font-weight "bold" color "#1a2744" background-color "#eee"]
cell A2 [text "2+3=" protected true]
```

**A size needs its unit.** `font-size "14px"` renders; `font-size "16"` and `font-size 16` are
both compile errors, because a bare number is not a CSS size and a browser discards it silently.

An attribute a container does not accept is a compile error naming what it does take, so put
each attribute on the thing it describes: `width` belongs to a column, not to the sheet.

**Scope an attribute where the request scopes it.** "the formula in B7, right aligned" describes
one cell, so it is `cell B7 [... align "right"]` — not `column B [align "right"]`, which says
something about every cell in the column that the request never said. Reach for a column or row
only when the request describes the column or the row ("right-align the amounts", "bold the header
row").

**`title` and `instructions` are content, not chrome.** Both default to empty, and the sheet draws
a heading panel above the grid only when at least one of them is non-empty — so writing either one
adds a visible panel above the sheet.

Write a `title` **only when the request asks for one in as many words**: it names a title or a
heading, or gives the text to use. A subject mentioned in passing is not a request for a title.
"Create a worksheet tracking freezer temperature checks" says what the sheet is for and asks for
no heading, so that sheet gets no `title`. When in doubt there is no doubt: no title.

`instructions` follows the same test — write them when the request says what the learner should be
told, never to restate the task back to them.

### Which level wins

The same presentation attribute may be set on a cell, on its column, and on its row. Each cell
resolves all three, most specific first: **cell beats column beats row.**

Note that ordering, because `points` does not share it — it inherits **cell beats row beats
column** (see Assessed cells). The two are genuinely different; do not reason from one to the
other.

A column or row attribute reaches exactly the cells that exist. The grid is sized from the
populated cells, so `column A [...]` covers A1 down to the last populated row and stops there —
it cannot leak past the sheet. Setting an attribute on the column is therefore equivalent to
repeating it on every cell of that column, and is the better way to write it.

### Borders

`border` takes two forms and they do not behave alike:

- **A CSS string** — `border "1px solid black"` — draws a ring around **each cell that carries
  it**, on all four sides, in that width and colour. It cannot outline a region: setting it on
  fifteen cells, or on the three columns those cells live in, draws fifteen rings and no
  rectangle.
- **A side list** — `border "top"`, `border "top,left"`, `border "all"` — draws only the named
  sides, and is the only form that **unions**: the sides set on the row, on the column and on the
  cell are added together instead of overriding one another. Sides render as a 2px grey edge and
  take no colour or width of their own.

So an outline around a region is drawn from its edges, not from its cells:

```
sheets [
  sheet "s1" [
    columns [
      column A [border "left"]
      column C [border "right"]
    ] {}
    rows [
      row 1 [border "top" font-weight "bold"]
      row 5 [border "bottom"]
    ] {}
    cells [
      cell A1 [text "Sample ID"] cell B1 [text "Nitrogen ppm"] cell C1 [text "Phosphorus ppm"]
      cell A2 [text "S-01"] cell B2 [text "42"] cell C2 [text "18"]
      cell A3 [text "S-02"] cell B3 [text "37"] cell C3 [text "22"]
      cell A4 [text "S-03"] cell B4 [text "55"] cell C4 [text "15"]
      cell A5 [text "S-04"] cell B5 [text "29"] cell C5 [text "31"]
    ] {}
  ]
] {
  "v": "0.0.1"
}..
```

A1 unions its row's `top` with its column's `left`; C5 unions `bottom` with `right`; B3 gets
neither. Every cell of the region gets a ring instead if you write the CSS form.

Border values are **not checked** at compile time. `border "sideways"` compiles and then renders
nothing at all, so use exactly `top`, `bottom`, `left`, `right`, or `all`.

## Cell text and formulas

`text` holds either a literal value or a formula beginning with `=`:

```
cell A4 [text "=ROUND(SUM(A1:A3),1)"]
```

Available in formulas: `SUM`, `AVERAGE`, `ROUND`, `POWER`, `MAX`, `MIN`, `ABS`, `IF`, and arithmetic.

## Assessed cells

An assessed cell is a blank cell with an `assess` attribute list:

```
cell B2 [text "" assess [method "value" expected "836"]]
```

- `method "value"` compares what the learner enters to `expected`.
- `expected` may be a literal (`"836"`) or a formula (`"=A1+C1"`), evaluated at scoring time
  against the current cell values — which is what makes parameterized items work.
- `points` sets what a correct cell is worth. Omitting it is the same as `points 1`. It may be
  fractional, and `points 0` marks a cell that is checked but scores nothing. It can be set on a
  row or column instead, and each cell inherits it — cell beats row beats column.

Each assessed cell is scored independently and the results are summed, so partial credit is the
default behaviour rather than something to switch on.

Feedback waits for a check by default: no cell turns right or wrong until the learner presses
Check (or Learnosity's Check Answer). To colour each assessed cell as the learner answers it,
write `instant-feedback true` after the `]` of `sheets`:

```
sheets [
  sheet "s1" [
    cells [
      cell A1 [text "2 + 2"]
      cell B1 [text "" assess [method "value" expected "4"]]
    ] {}
  ]
] instant-feedback true {
  "v": "0.0.1"
}..
```

Use it only when the request asks for immediate or live feedback; leave it out otherwise.

## Parameterized sheets

`params` supplies values that vary per render, and goes after the `sheets` list:

```
sheets [
  sheet "s1" [
    cells [
      cell A1 [text "{{A1}}"]
      cell A2 [text "" assess [method "value" expected "=A1*2"]]
    ] {}
  ]
] params {
  "A1": "10..50:10"
} {
  "v": "0.0.1"
}..
```

**Params keys are quoted strings.** A value is a literal, a comma-separated list of choices
(`"pigs, chickens, cows"`), or a range `start..stop:step` (`"1000..2000:500"`). Cells reference
a param with `{{NAME}}`.

## Conventions

- Address cells as `A1`, columns as `A`, rows as a number (`row 1`) or a quoted region
  (`row "*"` for every row).
- **Write cells in reading order** — row by row, left to right within each row: `A1 B1 A2 B2 …`,
  not all of column A followed by all of column B. Order carries no meaning to the compiler (the
  output is keyed by cell name), which is exactly why it should be fixed by convention: an edit
  that re-orders the cells it did not change produces a diff the size of the whole sheet, and every
  version of that item is then unreadable against the one before it.
- End the program with the version record and `..`: `] {\n  "v": "0.0.1"\n}..`
- Give each sheet a short id: `sheet "s1"`, `sheet "s2"`. Ids must be distinct.
- Write `title` and `instructions` after the `sheets` list, never inside a `sheet`.
- `params` goes last of all — anything written after it is discarded.
