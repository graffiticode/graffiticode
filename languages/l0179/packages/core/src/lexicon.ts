// SPDX-License-Identifier: MIT
// L0179's lexicon = L0000's base vocabulary + L0179's spreadsheet additions (child keys win).
//
// Two shapes, and the arity tells them apart:
//   arity 1 — an attribute. Takes its value and evaluates to a single-key record which the
//             enclosing attribute list merges. Every word in attributeFields is one of these.
//   arity 2 — a word that needs a second argument role:
//             member list  `cells [...] {config}`      children + a configuration record
//             keyed entry  `cell A1 [attributes]`      a key + its attribute list
//             chaining     `params {...} {v: "1"}`     a value + the rest of the chain
//
// See console/docs/language-authoring-style.md.
import { lexicon as base } from "@graffiticode/l0000";
import { attributeFields } from "./attributes.js";

const fn = (name: string, arity: 1 | 2) => ({
  tk: 1,
  name,
  cls: "function",
  length: arity,
  arity,
});

// Attributes are generated from the same table the handlers are, so a word can never exist in
// one and not the other — including their ARITY, which the table decides. A `chaining` attribute
// is arity 2: it takes its value and the rest of the chain, and is written in the `sheets`
// configuration slot rather than inside an attribute list. Getting this from the same table is
// what stops a word being arity 1 in the lexicon and arity 2 in the Transformer, which parses
// as nonsense rather than as an error.
const attributeWords = Object.fromEntries(
  Object.entries(attributeFields).map(([name, meta]) => [
    name.toLowerCase().replace(/_/g, "-"),
    fn(name, meta.chaining ? 2 : 1),
  ]),
);

const structural = {
  // Member lists: children + a configuration record.
  sheets: fn("SHEETS", 2),
  cells: fn("CELLS", 2),
  columns: fn("COLUMNS", 2),
  rows: fn("ROWS", 2),

  // Keyed entries: a key + its attribute list.
  sheet: fn("SHEET", 2),
  cell: fn("CELL", 2),
  column: fn("COLUMN", 2),
  row: fn("ROW", 2),

  // Chaining attribute: params expands into `templateVariablesRecords`, and unlike an ordinary
  // chaining attribute it REPLACES the continuation rather than merging it — transcribed from
  // L0166, where the trailing `{v: "0.0.1"}` is discarded for exactly this reason.
  params: fn("PARAMS", 2),
};

/**
 * Barewords for spreadsheet addresses, transcribed from L0166: a regex-keyed TAG entry is how
 * the parser accepts `cell A1 [...]` and `column A [...]` without every address being a declared
 * word. `cls: "val"` / arity 0 means they evaluate to themselves.
 *
 * Row regions stay quoted strings (`row "*" [...]`, `row "1..5" [...]`) exactly as in L0166 —
 * they are ranges, not identifiers, and `getPrimaryColumn` parses them as such.
 */
const tag = { tk: 22, name: "TAG", cls: "val", length: 0, arity: 0 };
const addresses = {
  "^[A-Z][0-9]+$": tag,   // cell:   A1, B12
  "^[A-Z]$": tag,         // column: A, B
};

export const lexicon = { ...base, ...attributeWords, ...structural, ...addresses };
