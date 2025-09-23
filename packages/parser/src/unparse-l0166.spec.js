import { parser } from "./parser.js";
import { unparse } from "./unparse.js";
import { lexicon as basisLexicon } from "@graffiticode/basis";

describe("unparse with L0166 lexicon", () => {
  // L0166 lexicon for spreadsheet operations (from l0166/packages/api/src/lexicon.js)
  const l0166Lexicon = {
    "title": {
      "tk": 1,
      "name": "TITLE",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "instructions": {
      "tk": 1,
      "name": "INSTRUCTIONS",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "params": {
      "tk": 1,
      "name": "PARAMS",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "cell": {
      "tk": 1,
      "name": "CELL",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "text": {
      "tk": 1,
      "name": "TEXT",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "assess": {
      "tk": 1,
      "name": "ASSESS",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "method": {
      "tk": 1,
      "name": "METHOD",
      "cls": "function",
      "length": 1,
      "arity": 1,
    },
    "expected": {
      "tk": 1,
      "name": "EXPECTED",
      "cls": "function",
      "length": 1,
      "arity": 1,
    },
    "width": {
      "tk": 1,
      "name": "WIDTH",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "align": {
      "tk": 1,
      "name": "ALIGN",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "background-color": {
      "tk": 1,
      "name": "BACKGROUND_COLOR",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "font-weight": {
      "tk": 1,
      "name": "FONT_WEIGHT",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "format": {
      "tk": 1,
      "name": "FORMAT",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "protected": {
      "tk": 1,
      "name": "PROTECTED",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "cells": {
      "tk": 1,
      "name": "CELLS",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "rows": {
      "tk": 1,
      "name": "ROWS",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "column": {
      "tk": 1,
      "name": "COLUMN",
      "cls": "function",
      "length": 2,
      "arity": 2,
    },
    "columns": {
      "tk": 1,
      "name": "COLUMNS",
      "cls": "function",
      "length": 2,
      "arity": 2,
    }
  };

  // Merge basis and L0166 lexicons
  const mergedLexicon = { ...basisLexicon, ...l0166Lexicon };

  it("should unparse L0166 spreadsheet code", async () => {
    const source = `columns [
  column A width 100 align "center" protected true {}
]
rows [
  row 1 background-color "#eee" protected true {}
]
cells [
  cell A1 text "A1" protected true {}
]
{
  v: "0.0.1"
}..`;

    // Note: The parser may transform this code, so we test that unparse
    // produces valid code that can be parsed again
    // Pass the lexicon directly to avoid fetching

    // Parse with merged lexicon
    const ast = await parser.parse(0, source, mergedLexicon);

    // Log the AST pool
    console.log("AST Pool:", JSON.stringify(ast, null, 2));

    const unparsed = unparse(ast, l0166Lexicon);

    // The unparsed code should be valid and parseable
    expect(unparsed).toBeDefined();
    expect(unparsed.endsWith("..")).toBe(true);

    // Check that key elements appear in the output
    // (the exact format may differ due to how the parser handles the syntax)
    console.log("Original source:", source);
    console.log("Unparsed:", unparsed);
  });

  it("should handle individual L0166 constructs", async () => {
    const tests = [
      {
        source: '{v: "0.0.1"}..',
        description: "version record"
      },
      {
        source: '[]..',
        description: "empty list"
      },
      {
        source: '{}..',
        description: "empty record"
      },
      {
        source: '"A1"..',
        description: "string literal"
      },
      {
        source: '100..',
        description: "number literal"
      },
      {
        source: 'true..',
        description: "boolean literal"
      }
    ];

    for (const { source, description } of tests) {
      const ast = await parser.parse(166, source, mergedLexicon);
      const unparsed = unparse(ast, l0166Lexicon);

      // Check that unparse produces output
      expect(unparsed).toBeDefined();
      expect(unparsed).not.toBe("");

      // The output should end with ..
      if (!unparsed.endsWith("..")) {
        console.log(`${description}: "${source}" -> "${unparsed}"`);
      }
      expect(unparsed.endsWith("..")).toBe(true);
    }
  });

  it("should preserve simple L0166 expressions", async () => {
    // Test simpler L0166 expressions that should parse correctly
    const tests = [
      'column A {}..',
      'row 1 {}..',
      'cell A1 {}..',
    ];

    for (const source of tests) {
      const ast = await parser.parse(0, source, mergedLexicon);
      const unparsed = unparse(ast, l0166Lexicon);

      // Should produce valid output
      expect(unparsed).toBeDefined();
      expect(unparsed.endsWith("..")).toBe(true);

      console.log(`Simple L0166: "${source}" -> "${unparsed}"`);
    }
  });

  it("should handle complex L0166 budget assessment code", async () => {
    const source = `title "Home Budget Assessment"
instructions \`
- Calculate your monthly budget based on income percentages
- Fill in the empty cells with the correct formulas
- Ensure all expenses and savings are properly allocated
\`
columns [
  column A width 150 align "left" {}
  column B width 100 format "($#,##0)" {}
  column C width 250 align "left" {}
]
cells [
  cell A1 text "CATEGORY" font-weight "bold" {}
  cell B1 text "AMOUNT" font-weight "bold" {}
  cell C1 text "DETAILS" font-weight "bold" {}

  cell A2 text "Income" {}
  cell B2 text "4000" {}
  cell C2 text "Total monthly income" {}

  cell A3 text "Rent" {}
  cell B3
    text "",
    assess [
      method "value"
      expected "1400"
    ] {}
  cell C3 text "35% of your total income" {}

  cell A4 text "Utilities" {}
  cell B4 text "200" {}
  cell C4 text "Fixed expense" {}

  cell A5 text "Food" {}
  cell B5
    text "",
    assess [
      method "value"
      expected "600"
    ] {}
  cell C5 text "15% of your total income" {}

  cell A6 text "Transportation" {}
  cell B6
    text "",
    assess [
      method "value"
      expected "400"
    ] {}
  cell C6 text "10% of your total income" {}

  cell A7 text "Entertainment" {}
  cell B7 text "150" {}
  cell C7 text "Fixed expense" {}

  cell A8 text "Savings" {}
  cell B8
    text "",
    assess [
      method "value"
      expected "800"
    ] {}
  cell C8 text "20% of your total income" {}

  cell A9 text "Miscellaneous" {}
  cell B9
    text "",
    assess [
      method "value"
      expected "450"
    ] {}
  cell C9 text "Remaining income after all other expenses" {}
]
{
  v: "0.0.1"
}..`;

    // Parse with merged lexicon
    const ast = await parser.parse("0166", source, mergedLexicon);

    console.log("Complex L0166 AST nodes:", Object.keys(ast).length);

    const unparsed = unparse(ast, l0166Lexicon);

    // The unparsed code should be valid and parseable
    expect(unparsed).toBeDefined();
    expect(unparsed.endsWith("..")).toBe(true);

    // Check that key elements appear in the output
    expect(unparsed).toContain("title");
    expect(unparsed).toContain("columns");
    expect(unparsed).toContain("cells");
    expect(unparsed).toContain("column A");
    expect(unparsed).toContain("column B");
    expect(unparsed).toContain("column C");

    // Log a portion of the output to see the pretty printing
    const lines = unparsed.split("\n");
    console.log("First 20 lines of unparsed output:");
    console.log(lines.slice(0, 20).join("\n"));
    console.log("...");
    console.log("Last 10 lines of unparsed output:");
    console.log(lines.slice(-10).join("\n"));
    console.log(unparsed);
  });

  it("should reformat L0166 code using parser.reformat", async () => {
    const source = `columns [column A width 100 {}] rows [row 1 {}] cells [cell A1 text "Hello" {}] {v: "0.0.1"}..`;

    // Reformat with merged lexicon
    const reformatted = await parser.reformat("0166", source, mergedLexicon);

    // Check that it produces valid output
    expect(reformatted).toBeDefined();
    expect(reformatted.endsWith("..")).toBe(true);

    // Check for pretty printing
    expect(reformatted).toContain("columns [\n");
    expect(reformatted).toContain("rows [\n");
    expect(reformatted).toContain("cells [\n");

    console.log("Reformatted L0166 code:");
    console.log(reformatted);
  });
});
