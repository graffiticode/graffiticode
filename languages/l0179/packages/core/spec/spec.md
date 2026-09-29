<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# Graffiticode L0179 Vocabulary

L0179 is an authoring language for interactive spreadsheets. A primary use case is
spreadsheet-based assessment — cells that grade student-entered values or formulas against an
expected answer, optionally with parameterized inputs that vary per render. L0179 also supports
display and worksheet modes without grading.

L0179 emits the same compiled form as L0166 and differs only in how source is written: attributes
are collected in a bracket list rather than chained. See
`console/docs/language-authoring-style.md`.

## Structure

A program is a `sheets` list holding one or more `sheet`s. Each sheet's body is an attribute
list; whatever describes the program as a whole is written *after* the list.

```
sheets [
  sheet "s1" [
    columns [
      column A [width 200 align "right"]
    ] {}
    cells [
      cell A1 [text "Revenue" font-weight "bold"]
      cell A2 [text "=SUM(B2:B4)"]
    ] {}
  ]
] title "Quarterly Totals" {
  "v": "0.0.1"
}..
```

`title` sits after the `]`, not inside the sheet, because it names the **program** — with two
sheets, a title written inside one of them has no meaning. The same goes for `instructions`,
`show-sheet-tabs`, `hide-sheet-menu`, and `instant-feedback`.

| Word | Form | Description |
| :--- | :--- | :---------- |
| `sheets` | member list | The program's sheets, then its program-level attributes, then a configuration record. |
| `sheet` | keyed entry | An id and the sheet's attribute list. |
| `cells` / `columns` / `rows` | member list | The cells, columns, or row regions, plus a configuration record. |
| `cell` / `column` / `row` | keyed entry | An address and its attribute list. |
| `assess` | attribute list | Grading rules for a cell, column, or row. |
| `params` | chaining attribute | Per-render values; written last, after the `sheets` list. |

## Several sheets

Add more `sheet` entries. Give each a `name` to label it; without one the tab and menu fall back
to the id.

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

Ids must be distinct — they key each sheet's answers and grading, so a duplicate would silently
overwrite one sheet with the other.

The form always shows a **sheet menu** listing every sheet, even when there is only one, and shows
a **tab strip** once there are two or more. Two attributes adjust that:

| Word | Value | Effect |
| :--- | :--- | :----- |
| `show-sheet-tabs` | boolean | Force the tab strip on for a single sheet, or off for several. |
| `hide-sheet-menu` | boolean | Hide the sheet menu. |

Setting `hide-sheet-menu true` together with `show-sheet-tabs false` on a program with several sheets is
an error: nothing would be left to reach the other sheets with.

## Attributes

Written inside a `[...]` list as a word applied to a value. Order does not matter.

| Attribute | Applies to | Description |
| :-------- | :--------- | :---------- |
| `text` | cell | The cell's content: a literal, or a formula starting with `=`. |
| `width` | column | Column width in pixels. |
| `align` | cell, column, row | `left`, `right`, `center`, `justify`. |
| `background-color`, `color` | cell, column, row | Fill and text color. |
| `font-weight`, `font-size`, `font-family`, `font-style` | cell, column, row | Type. |
| `text-decoration`, `vertical-align`, `border` | cell, column, row | Presentation. |
| `format` | cell, column, row | A number format, e.g. `"#,##0.00"`. |
| `protected` | cell, column, row | When true the learner cannot edit the cell. A bare `true` or `false`. |
| `name` | sheet | The sheet's label in the tab strip and the sheet menu. Defaults to its id. |
| `hide-formulabar` | sheet | Hides the `fx` input above the grid. |
| `title`, `instructions` | **program** | Text shown above the grid. Written after the `sheets` list, not inside a sheet. |
| `show-sheet-tabs`, `hide-sheet-menu` | **program** | See [Several sheets](#sec-Several-sheets). Written after the `sheets` list. |
| `instant-feedback` | **program** | Colour assessed cells as the learner answers, not only on a check. See [assess](#sec-assess). Written after the `sheets` list. |

An attribute a container does not accept is a compile error naming what that container takes.

### protected

Written as a bare `true` or `false`, never quoted — `protected "true"` is a compile error.
Use it for display-only cells, such as the labels a learner reads but must not change.

```
cell A1 [text "2+3=" protected true]
```

Set on a column or row, it protects every cell in it.

```
column A [protected true]
```

### assess

Grading rules for a cell. Also settable on a column or row, where the cells inherit it.

```
cell B2 [text "" assess [method "value" expected "836" points 2]]
```

| Member | Description |
| :----- | :---------- |
| `method` | `"value"` compares the entered value to `expected`. |
| `expected` | A literal (`"836"`) or a formula (`"=A1+C1"`) evaluated at scoring time. |
| `points` | What a correct cell is worth. Default 1. Fractions allowed; `points 0` is checked but unscored. |

Points precedence is cell, then row, then column. Every assessed cell is scored independently
and the results summed, so partial credit is the default rather than a mode.

By default the grid shows no right-or-wrong colouring while the learner works: feedback waits for
a check — the Check button under the form, or Learnosity's Check Answer. `instant-feedback`,
written after the `sheets` list, changes that:

| Word | Value | Effect |
| :--- | :--- | :----- |
| `instant-feedback` | boolean | `true` colours each assessed cell as the learner answers it. `false` is the default. |

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

### params

Per-render values, written after the `sheets` list. Keys are quoted cell addresses; a cell reads
one with `{{NAME}}`.

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

A value is a literal, a comma-separated choice list (`"pigs, chickens, cows"`), or a range
`start..stop:step`.

`params` goes **last** in the chain, after any `title` or `instructions` — anything written after
it is discarded.

With several sheets, qualify a name with the sheet id and `!`, the same form the grid uses for a
cell on another sheet. A bare name means the first sheet.

```
] params {
  "A1": "10..50:10",
  "s2!A1": "100..500:100"
} {
```

## Formula functions

Available inside a `text` or `expected` value that begins with `=`.

| Function | Syntax | Description |
| :------- | :----- | :---------- |
| `SUM` | `=SUM(A1:A10)` | Adds numeric values in a range. |
| `AVERAGE` | `=AVERAGE(A1:A10)` | Arithmetic mean. |
| `ROUND` | `=ROUND(A1,2)` | Rounds to a number of decimal places. |
| `POWER` | `=POWER(A1,2)` | Raises a base to an exponent. Also written `=A1^2`. |
| `MAX` | `=MAX(A1:A10)` | Largest numeric value; text and blanks are skipped. |
| `MIN` | `=MIN(A1:A10)` | Smallest numeric value; text and blanks are skipped. |
| `ABS` | `=ABS(A1)` | Absolute value. |
| `IF` | `=IF(A1,B1,C1)` | Conditional value. |

## Examples

### A display grid

```
sheets [
  sheet "s1" [
    columns [
      column A [width 150]
      column B [width 100 align "right"]
    ] {}
    cells [
      cell A1 [text "Item" font-weight "bold"]
      cell B1 [text "Value" font-weight "bold"]
      cell A2 [text "Alpha"]
      cell B2 [text "10.0" format "#,##0.0"]
    ] {}
  ]
] {
  "v": "0.0.1"
}..
```

### An assessed formula cell

```
sheets [
  sheet "s1" [
    cells [
      cell A1 [text "10"]
      cell A2 [text "20"]
      cell A3 [text "30"]
      cell A4 [text "" assess [method "value" expected "=SUM(A1:A3)"]]
    ] {}
  ]
] {
  "v": "0.0.1"
}..
```

### Weighted cells with row inheritance

```
sheets [
  sheet "s1" [
    rows [
      row 2 [assess [points 2]]
    ] {}
    cells [
      cell A1 [text "Employee" font-weight "bold"]
      cell B1 [text "Gross Pay" font-weight "bold"]
      cell A2 [text "Nakamura"]
      cell B2 [text "" assess [method "value" expected "836"]]
    ] {}
  ]
] {
  "v": "0.0.1"
}..
```
