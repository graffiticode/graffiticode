<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0179 Usage Guide

Agent-facing guide for authoring interactive spreadsheets through L0179. Read this before
composing a `create_item` prompt or an `update_item` modification.

## Overview

L0179 is an authoring language for interactive spreadsheets. Input is a natural-language
description of a grid; output is a spreadsheet that renders as an editable table, optionally with
assessed cells that grade what a learner types. A primary use case is spreadsheet-based
assessment — cells that check a typed value or formula against an expected answer, with inputs
that can vary per render. L0179 also serves display and worksheet modes with no grading at all:
cell grids with text, formatting (fonts, colors, borders, alignment, column widths), and formulas
(SUM, AVERAGE, ROUND, POWER, MAX, MIN, ABS, IF, arithmetic).

When composing a request, describe the grid the way you would describe a table: which cells hold
which text, which columns need a width or an alignment, and which cells the learner fills in.
Name the cells by address (A1, B2) when their positions matter, and give the formula you want
rather than the arithmetic result — `=ROUND(SUM(A1:A3),1)` says more than "the rounded total".
For an assessed cell, state the expected answer and whether it is a literal value or a formula;
a formula expectation is re-evaluated against the current cell values at scoring time, which is
what lets one item generate many variants. Say what each correct cell is worth only if it is not
worth one point — per-cell scoring is the default, so partial credit needs no special request.
Feedback waits for the learner to check their answers unless you ask for it to be instant, in
which case each assessed cell turns right or wrong as it is answered.

For values that change per render, describe them as parameters: a list of choices, or a numeric
range with a step. Each rendered instance draws one combination, and an assessed cell whose
expectation is a formula stays correct across all of them.

In scope: spreadsheet layout, cell formatting, formulas, assessed cells, per-cell points,
parameterized values, and several sheets in one item — tabs and a sheet menu to move between them.
Out of scope: authoring question items (multiple choice, reading passages, answer keys,
rubric-scored prose), charts, pivot tables, cross-sheet formula references, data imports, and
macros. Note the difference on that second-to-last one: several sheets are fine, but a formula on
one sheet cannot read a cell on another. A spreadsheet can be embedded INTO an assessment item by a host dialect; authoring
that item is that dialect's job, not this one's.

## Writing a request

- Describe the grid top-to-bottom and left-to-right; the backend places cells by address.
- Give formulas verbatim, including the `=`.
- For an assessed cell, say what the learner should enter and how it is checked.
- Say so if feedback should be instant (shown as the learner answers) rather than on a check.
- For a parameterized sheet, name the parameter cells and their ranges or choice lists.
- Mention formatting where it carries meaning (a bold header row, a currency column).

## What comes back

A program whose compiled form is a table: rows, columns, and cells, plus a validation record
describing every assessed cell and the total points available. The rendered spreadsheet is
editable, checks each assessed cell independently, and reports a score out of that total.
