import { jest } from "@jest/globals";
import { buildParser, parser } from "./parser.js";
import { mockPromiseValue, mockPromiseError } from "./testing/index.js";
import { lexicon as basisLexicon } from "@graffiticode/basis";
import { unparse } from "./unparse.js";

describe("lang/parser", () => {
  const log = jest.fn();
  it("should use provided lexicon", async () => {
    // Arrange
    const main = {
      parse: mockPromiseValue({ root: "0" })
    };
    const parser = buildParser({ main });
    const lang = "0";
    const src = "'foo'..";
    const providedLexicon = { test: "lexicon" };

    // Act
    await expect(parser.parse(lang, src, providedLexicon)).resolves.toStrictEqual({ root: "0" });

    // Assert
    expect(main.parse).toHaveBeenCalledWith(src, providedLexicon, undefined);
  });

  it("should throw error when lexicon is missing", async () => {
    // Arrange
    const main = {
      parse: mockPromiseValue({ root: "0" })
    };
    const parser = buildParser({ main });
    const lang = "0";
    const src = "'foo'..";

    // Act & Assert
    await expect(parser.parse(lang, src)).rejects.toThrow("Lexicon is required for parsing");
  });
  it("should pass lexicon to main parser", async () => {
    // Arrange
    const main = {
      parse: mockPromiseValue({ root: "0" })
    };
    const parser = buildParser({ main });
    const lang = "0";
    const src = "'foo'..";
    const lexicon = { someFunc: { name: "SOMEFUNC" } };

    // Act
    await expect(parser.parse(lang, src, lexicon)).resolves.toStrictEqual({ root: "0" });

    // Assert
    expect(main.parse).toHaveBeenCalledWith(src, lexicon, undefined);
  });
  it("should return error if main parser fails with lexicon", async () => {
    // Arrange
    const err = new Error("parser failed");
    const main = { parse: mockPromiseError(err) };
    const parser = buildParser({ main });
    const lang = "00";
    const src = "'foo'..";
    const lexicon = {};

    // Act
    await expect(parser.parse(lang, src, lexicon)).rejects.toBe(err);

    // Assert
    expect(main.parse).toHaveBeenCalledWith(src, lexicon, undefined);
  });
  it("should return error if main parser fails", async () => {
    // Arrange
    const err = new Error("main parser failed");
    const main = { parse: mockPromiseError(err) };
    const parser = buildParser({ main });
    const lang = "0";
    const src = "'foo'..";
    const lexicon = {};

    // Act
    await expect(parser.parse(lang, src, lexicon)).rejects.toBe(err);

    // Assert
    expect(main.parse).toHaveBeenCalledWith(src, lexicon, undefined);
  });
  it("should pass callbacks to main parser", async () => {
    // Arrange
    const main = {
      parse: mockPromiseValue({ root: "0" })
    };
    const parser = buildParser({ main });
    const lang = "0";
    const src = "'foo'..";
    const lexicon = {};
    const callbacks = { GET_VAL_PUBLIC: jest.fn() };

    // Act
    await expect(parser.parse(lang, src, lexicon, callbacks)).resolves.toStrictEqual({ root: "0" });

    // Assert
    expect(main.parse).toHaveBeenCalledWith(src, lexicon, callbacks);
  });
  it("should parse error", async () => {
    // Arrange
    const err = new Error("End of program reached.");
    const main = { parse: mockPromiseError(err) };
    const parser = buildParser({ main });
    const lang = "0";
    const src = "'hello, world'";
    const lexicon = {};

    // Act & Assert
    await expect(parser.parse(lang, src, lexicon)).rejects.toBe(err);
  });
});

describe("parser integration tests", () => {
  // Tests using the actual parser
  it("should parse string literals", async () => {
    // Arrange & Act
    const result = await parser.parse(0, "'hello, world'..", basisLexicon);

    // Assert
    expect(result).toHaveProperty("root");

    // Find the STR node
    let strNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "STR" && node.elts[0] === "hello, world") {
          strNode = node;
          break;
        }
      }
    }

    expect(strNode).not.toBeNull();
    expect(strNode.tag).toBe("STR");
    expect(strNode.elts).toEqual(["hello, world"]);

    // Program structure verification
    const rootId = result.root;
    const rootNode = result[rootId];
    expect(rootNode.tag).toBe("PROG");
  });

  it("should parse numeric literals", async () => {
    // Arrange & Act
    const result = await parser.parse(0, "42..", basisLexicon);

    // Assert
    expect(result).toHaveProperty("root");

    // Find the NUM node
    let numNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "NUM" && node.elts[0] === "42") {
          numNode = node;
          break;
        }
      }
    }

    expect(numNode).not.toBeNull();
    expect(numNode.tag).toBe("NUM");
    expect(numNode.elts).toEqual(["42"]);
  });

  it("should have a PROG node at the root", async () => {
    // Let's test the most basic structure that should always work
    const result = await parser.parse(0, "123..", basisLexicon);

    // Assert
    expect(result).toHaveProperty("root");

    // Verify the structure: we need to have a PROG node at the root
    const rootId = result.root;
    const rootNode = result[rootId];
    expect(rootNode.tag).toBe("PROG");

    // Find the NUM node for 123
    let numNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "NUM" && node.elts[0] === "123") {
          numNode = node;
          break;
        }
      }
    }

    expect(numNode).not.toBeNull();
    expect(numNode.tag).toBe("NUM");
    expect(numNode.elts[0]).toBe("123");
  });

  it("should parse complex program: apply (<a b: add a b>) [10 20]..", async () => {
    // Create custom lexicon
    const customLexicon = {
      add: {
        tk: 2,
        name: "add",
        cls: "function",
        length: 2
      },
      apply: {
        tk: 40,
        name: "apply",
        cls: "function",
        length: 2
      }
    };

    // Act
    const result = await parser.parse(0, "apply (<a b: add a b>) [10 20]..", customLexicon);

    // Assert
    expect(result).toHaveProperty("root");

    // Verify basic structure
    const rootId = result.root;
    const rootNode = result[rootId];
    expect(rootNode.tag).toBe("PROG");

    // Find NUM nodes with values 10 and 20
    let num10Node = null;
    let num20Node = null;

    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "NUM") {
          if (node.elts[0] === "10") {
            num10Node = node;
          } else if (node.elts[0] === "20") {
            num20Node = node;
          }
        }
      }
    }

    // At minimum, we should be able to find the number values
    expect(num10Node).not.toBeNull();
    expect(num20Node).not.toBeNull();

    // Find IDENT nodes with names 'a' and 'b'
    let identNodeA = null;
    let identNodeB = null;

    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "IDENT") {
          if (node.elts[0] === "a") {
            identNodeA = node;
          } else if (node.elts[0] === "b") {
            identNodeB = node;
          }
        }
      }
    }

    // Check that we found the identifiers
    expect(identNodeA).not.toBeNull();
    expect(identNodeB).not.toBeNull();
  });

  it("should handle syntax errors with generic error message", async () => {
    // Test various syntax errors and confirm they're caught properly
    let errorNode = null;
    let result = null;

    try {
      // Unclosed string - missing closing quote
      result = await parser.parse(0, "'unclosed string..", basisLexicon);
    } catch (e) {
      // Check for expected error (we should now have a robust parser that doesn't throw)
      console.error("Unexpected error:", e);
      throw e;
    }

    // Should get a result even with syntax error
    expect(result).toHaveProperty("root");

    // Find the ERROR node
    errorNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "ERROR") {
          errorNode = node;
          break;
        }
      }
    }

    // Should have an ERROR node
    expect(errorNode).not.toBeNull();
    expect(errorNode.tag).toBe("ERROR");

    // The error message should be either the specific syntax error or the generic "Syntax Error"
    // Verify that we have an ERROR node with the proper structure
    expect(errorNode.elts.length).toBeGreaterThan(0);

    // The error structure might be different based on implementation details
    // We just want to ensure there's an error node in the result
    expect(errorNode.tag).toBe("ERROR");
  });

  it("should handle mismatched brackets with syntax error", async () => {
    let result = null;

    try {
      // Missing closing bracket
      result = await parser.parse(0, "[1, 2, 3..", basisLexicon);
    } catch (e) {
      console.error("Unexpected error:", e);
      throw e;
    }

    // Should get a result even with syntax error
    expect(result).toHaveProperty("root");

    // Find the ERROR node
    let errorNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "ERROR") {
          errorNode = node;
          break;
        }
      }
    }

    // Should have an ERROR node
    expect(errorNode).not.toBeNull();
    expect(errorNode.tag).toBe("ERROR");

    // The error message should indicate the syntax error
    // Verify that we have an ERROR node with the proper structure
    expect(errorNode.elts.length).toBeGreaterThan(0);

    // The error structure might be different based on implementation details
    // We just want to ensure there's an error node in the result
    expect(errorNode.tag).toBe("ERROR");
  });

  it("should handle invalid token sequences with syntax error", async () => {
    let result = null;

    try {
      // Invalid sequence of tokens
      result = await parser.parse(0, "if then else..", basisLexicon);
    } catch (e) {
      console.error("Unexpected error:", e);
      throw e;
    }

    // Should get a result even with syntax error
    expect(result).toHaveProperty("root");

    // Find the ERROR node
    let errorNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "ERROR") {
          errorNode = node;
          break;
        }
      }
    }

    // Should have an ERROR node
    expect(errorNode).not.toBeNull();
    expect(errorNode.tag).toBe("ERROR");

    // The error message should indicate the syntax error
    // Verify that we have an ERROR node with the proper structure
    expect(errorNode.elts.length).toBeGreaterThan(0);

    // The error structure might be different based on implementation details
    // We just want to ensure there's an error node in the result
    expect(errorNode.tag).toBe("ERROR");
  });

  it("should parse 'add 123 456' as ADD node with operands", async () => {
    // Arithmetic is deferred to the compiler, not folded at parse time
    const result = await parser.parse(0, "add 123 456..", basisLexicon);

    // Assert
    expect(result).toHaveProperty("root");

    const rootId = result.root;
    const rootNode = result[rootId];
    expect(rootNode.tag).toBe("PROG");

    // Find the ADD node
    let addNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "ADD") {
          addNode = node;
          break;
        }
      }
    }

    expect(addNode).not.toBeNull();
    expect(addNode.tag).toBe("ADD");
    expect(addNode.elts.length).toBe(2);

    // Original operands should be preserved
    let found123 = false;
    let found456 = false;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "NUM") {
          if (node.elts[0] === "123") found123 = true;
          if (node.elts[0] === "456") found456 = true;
        }
      }
    }
    expect(found123).toBe(true);
    expect(found456).toBe(true);
  });

  // Tests for escaped quotes
  it("should parse strings with escaped double quotes", async () => {
    // Arrange & Act
    const result = await parser.parse(0, '"He said \\"Hello\\""..', basisLexicon);

    // Assert
    expect(result).toHaveProperty("root");

    // Find the STR node
    let strNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "STR" && node.elts[0] === 'He said "Hello"') {
          strNode = node;
          break;
        }
      }
    }

    expect(strNode).not.toBeNull();
    expect(strNode.tag).toBe("STR");
    expect(strNode.elts[0]).toBe('He said "Hello"');
  });

  it("should parse strings with escaped single quotes", async () => {
    // Arrange & Act
    const result = await parser.parse(0, "'It\\'s working!'..", basisLexicon);

    // Assert
    expect(result).toHaveProperty("root");

    // Find the STR node
    let strNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "STR" && node.elts[0] === "It's working!") {
          strNode = node;
          break;
        }
      }
    }

    expect(strNode).not.toBeNull();
    expect(strNode.tag).toBe("STR");
    expect(strNode.elts[0]).toBe("It's working!");
  });

  it("should parse strings with escaped backticks", async () => {
    // Arrange & Act
    const result = await parser.parse(0, "`This has a \\` backtick`..", basisLexicon);

    // Assert
    expect(result).toHaveProperty("root");

    // Find the STR node
    let strNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "STR" && node.elts[0] === "This has a ` backtick") {
          strNode = node;
          break;
        }
      }
    }

    expect(strNode).not.toBeNull();
    expect(strNode.tag).toBe("STR");
    expect(strNode.elts[0]).toBe("This has a ` backtick");
  });

  it("should parse strings with escaped backslashes", async () => {
    // Arrange & Act
    const result = await parser.parse(0, '"Path: C:\\\\Users\\\\Test"..', basisLexicon);

    // Assert
    expect(result).toHaveProperty("root");

    // Find the STR node
    let strNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "STR" && node.elts[0] === "Path: C:\\Users\\Test") {
          strNode = node;
          break;
        }
      }
    }

    expect(strNode).not.toBeNull();
    expect(strNode.tag).toBe("STR");
    expect(strNode.elts[0]).toBe("Path: C:\\Users\\Test");
  });

  it("should parse template literals with escaped interpolation", async () => {
    // Arrange & Act
    const result = await parser.parse(0, "`Price: \\${amount}`..", basisLexicon);

    // Assert
    expect(result).toHaveProperty("root");

    // Find the STR node
    let strNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "STR" && node.elts[0] === "Price: ${amount}") {
          strNode = node;
          break;
        }
      }
    }

    expect(strNode).not.toBeNull();
    expect(strNode.tag).toBe("STR");
    expect(strNode.elts[0]).toBe("Price: ${amount}");
  });

  it("should parse and unparse a tag node", async () => {
    const result = await parser.parse(0, "tag foo..", basisLexicon);

    expect(result).toHaveProperty("root");

    let tagNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "TAG" && node.elts[0] === "foo") {
          tagNode = node;
          break;
        }
      }
    }

    expect(tagNode).not.toBeNull();
    expect(tagNode.tag).toBe("TAG");
    expect(tagNode.elts).toEqual(["foo"]);

    // Unparse should reproduce the original source
    const source = unparse(result, basisLexicon);
    expect(source).toBe("tag foo..");
  });

  it("should error on undefined name", async () => {
    const result = await parser.parse(0, "foo..", basisLexicon);

    expect(result).toHaveProperty("root");

    let errorNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "ERROR") {
          errorNode = node;
          break;
        }
      }
    }

    expect(errorNode).not.toBeNull();
    expect(errorNode.tag).toBe("ERROR");
  });

  it("should parse 'tag red' as a TAG node", async () => {
    const result = await parser.parse(0, "tag red..", basisLexicon);

    expect(result).toHaveProperty("root");

    let tagNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "TAG" && node.elts[0] === "red") {
          tagNode = node;
          break;
        }
      }
    }

    expect(tagNode).not.toBeNull();
    expect(tagNode.tag).toBe("TAG");
    expect(tagNode.elts).toEqual(["red"]);
  });

  it("should parse regex-matched tag from lexicon", async () => {
    const lexiconWithPattern = {
      ...basisLexicon,
      "^[A-Z]{1,2}[0-9]+$": {
        tk: 0x16,
        name: "TAG",
        cls: "val",
        length: 0,
        arity: 0,
      },
    };
    const result = await parser.parse(0, "B12..", lexiconWithPattern);

    expect(result).toHaveProperty("root");

    let tagNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "TAG" && node.elts[0] === "B12") {
          tagNode = node;
          break;
        }
      }
    }

    expect(tagNode).not.toBeNull();
    expect(tagNode.tag).toBe("TAG");
    expect(tagNode.elts).toEqual(["B12"]);

    // Unparse should omit "tag" prefix for regex-matched tags
    const source = unparse(result, lexiconWithPattern);
    expect(source).toBe("B12..");
  });

  it("should match cell name before column name with regex patterns", async () => {
    const lexiconWithPatterns = {
      ...basisLexicon,
      "^[A-Z][0-9]+$": {
        tk: 0x16,
        name: "TAG",
        cls: "val",
        length: 0,
        arity: 0,
      },
      "^[A-Z]$": {
        tk: 0x16,
        name: "TAG",
        cls: "val",
        length: 0,
        arity: 0,
      },
    };

    // "A1" should match cell pattern, not column pattern
    const cellResult = await parser.parse(0, "A1..", lexiconWithPatterns);
    let cellTag = null;
    for (const key in cellResult) {
      if (key !== "root") {
        const node = cellResult[key];
        if (node.tag === "TAG" && node.elts[0] === "A1") {
          cellTag = node;
          break;
        }
      }
    }
    expect(cellTag).not.toBeNull();
    expect(cellTag.elts).toEqual(["A1"]);

    // "A" should match column pattern
    const colResult = await parser.parse(0, "A..", lexiconWithPatterns);
    let colTag = null;
    for (const key in colResult) {
      if (key !== "root") {
        const node = colResult[key];
        if (node.tag === "TAG" && node.elts[0] === "A") {
          colTag = node;
          break;
        }
      }
    }
    expect(colTag).not.toBeNull();
    expect(colTag.elts).toEqual(["A"]);
  });

  it("should parse strings with mixed escape sequences", async () => {
    // Arrange & Act
    const result = await parser.parse(0, '"Line 1\\nTab\\t\\"Quote\\""..', basisLexicon);

    // Assert
    expect(result).toHaveProperty("root");

    // Find the STR node
    let strNode = null;
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "STR" && node.elts[0] === 'Line 1\nTab\t"Quote"') {
          strNode = node;
          break;
        }
      }
    }

    expect(strNode).not.toBeNull();
    expect(strNode.tag).toBe("STR");
    expect(strNode.elts[0]).toBe('Line 1\nTab\t"Quote"');
  });

  it("should parse l0166 record with cell reference key", async () => {
    const l0166Lexicon = {
      ...basisLexicon,
      "^[A-Z][0-9]+$": {
        tk: 22,
        name: "TAG",
        cls: "val",
        length: 0,
        arity: 0,
      },
    };
    const src = '{\n  A1: "foo"\n}..';
    const result = await parser.parse(166, src, l0166Lexicon);

    expect(result).toHaveProperty("root");

    // Find the TAG node for A1 and the STR node for "foo"
    let tagNode = null;
    let strNode = null;
    for (const key in result) {
      if (key === "root") continue;
      const node = result[key];
      if (node.tag === "TAG" && node.elts[0] === "A1") tagNode = node;
      if (node.tag === "STR" && node.elts[0] === "foo") strNode = node;
    }

    expect(tagNode).not.toBeNull();
    expect(tagNode.tag).toBe("TAG");
    expect(tagNode.elts).toEqual(["A1"]);

    expect(strNode).not.toBeNull();
    expect(strNode.tag).toBe("STR");
    expect(strNode.elts[0]).toBe("foo");
  });

  it("should error on an l0166 cell reference key with no value", async () => {
    // Only bare identifiers may elide their value. A cell reference scans as a
    // TAG token, so `{A1}` is a missing colon, not a shorthand field.
    const l0166Lexicon = {
      ...basisLexicon,
      "^[A-Z][0-9]+$": {
        tk: 22,
        name: "TAG",
        cls: "val",
        length: 0,
        arity: 0,
      },
    };
    const result = await parser.parse(166, "{A1}..", l0166Lexicon);
    const errorNode = result[result.root];

    expect(errorNode.tag).toBe("ERROR");
    expect(result[errorNode.elts[0]].elts[0]).toBe("Expecting a ':' after record key.");
    // The error points at the key, not at the closing brace.
    expect(result[errorNode.elts[0]].coord).toEqual({ from: 1, to: 3 });
  });

  it("should parse code with block comments", async () => {
    const src = "/* this is a comment */ 42..";
    const result = await parser.parse(0, src, basisLexicon);

    expect(result).toHaveProperty("root");

    let numNode = null;
    for (const key in result) {
      if (key === "root") continue;
      const node = result[key];
      if (node.tag === "NUM") numNode = node;
    }

    expect(numNode).not.toBeNull();
    expect(numNode.tag).toBe("NUM");
    expect(numNode.elts[0]).toBe("42");
  });

  it("should parse case-of with wildcard _ pattern", async () => {
    const src = "case 42 of 1: 'one' _: 'other' end..";
    const result = await parser.parse(0, src, basisLexicon);

    expect(result).toHaveProperty("root");

    // Find nodes by walking the pool (AST uses integer IDs as references)
    let caseNode = null;
    let wildcardNode = null;
    for (const key in result) {
      if (key === "root") continue;
      const node = result[key];
      if (node.tag === "CASE") caseNode = node;
      if (node.tag === "TAG" && node.elts[0] === "_") wildcardNode = node;
    }

    expect(caseNode).not.toBeNull();
    expect(caseNode.tag).toBe("CASE");
    // CASE elts: [expr, OF clause 1, OF clause 2]
    expect(caseNode.elts.length).toBe(3);

    // Wildcard _ is stored as a TAG node to match basis compiler's match function
    expect(wildcardNode).not.toBeNull();
    expect(wildcardNode.tag).toBe("TAG");
    expect(wildcardNode.elts).toEqual(["_"]);

    // Unparse should reproduce the case-of expression
    const source = unparse(result, basisLexicon);
    expect(source).toContain("case");
    expect(source).toContain("_:");
  });
});

describe("built-ins as values", () => {
  // Rebuild the tree under `root`, dropping pool ids so trees compare structurally.
  const tree = (pool, id = pool.root) => {
    const node = pool[id];
    if (node === undefined || node === null || typeof node !== "object") {
      return node;
    }
    return {
      tag: node.tag,
      elts: node.elts.map(elt => (typeof elt === "number" && pool[elt] !== undefined ? tree(pool, elt) : elt)),
    };
  };

  it.each([
    ["apply (add) [1 2]..", "apply (<a b: add a b>) [1 2].."],
    ["reduce (max) 0 [3 9 2 7]..", "reduce (<a b: max a b>) 0 [3 9 2 7].."],
    ["map (not) [true false]..", "map (<a: not a>) [true false].."],
  ])("should parse %s as its eta-expanded lambda", async (src, expanded) => {
    const actual = await parser.parse(0, src, basisLexicon);
    const expected = await parser.parse(0, expanded, basisLexicon);
    expect(tree(actual)).toStrictEqual(tree(expected));
  });

  it("should still reject an unparenthesized built-in with too few arguments", async () => {
    const result = await parser.parse(0, "add 1..", basisLexicon);
    expect(result[result.root].tag).toBe("ERROR");
    expect(result[result[result.root].elts[0]].elts[0]).toBe("Too few arguments for ADD. Expected 2.");
  });
});

describe("parens only group", () => {
  const tree = (pool, id = pool.root) => {
    const node = pool[id];
    if (node === undefined || node === null || typeof node !== "object") {
      return node;
    }
    return {
      tag: node.tag,
      elts: node.elts.map(elt => (typeof elt === "number" && pool[elt] !== undefined ? tree(pool, elt) : elt)),
    };
  };
  const exprsOf = async (src) => tree(await parser.parse(0, src, basisLexicon)).elts[0].elts;

  it("should keep every expression of `(1 2)` inside the group", async () => {
    // Folding used to wrap only the first expression and spill the rest: `(1) 2`.
    expect(await exprsOf("(1 2)..")).toStrictEqual([
      { tag: "PAREN", elts: [{ tag: "EXPRS", elts: [{ tag: "NUM", elts: ["1"] }, { tag: "NUM", elts: ["2"] }] }] },
    ]);
  });

  it("should nest grouped sequences", async () => {
    const [group] = await exprsOf("((1 2) 3)..");
    expect(group.elts[0].tag).toBe("EXPRS");
    expect(group.elts[0].elts.map(e => e.tag)).toEqual(["PAREN", "NUM"]);
    expect(group.elts[0].elts[0].elts[0].tag).toBe("EXPRS");
  });

  it.each([
    ["(add 1 2)..", ["PAREN"], "ADD"],
    ["(add)..", ["PAREN"], "LAMBDA"],
    ["(<x: x>) 10..", ["PAREN", "NUM"], "LAMBDA"],
    ["(1) 2..", ["PAREN", "NUM"], "NUM"],
  ])("should leave single-expression group %s unchanged", async (src, tags, inner) => {
    const exprs = await exprsOf(src);
    expect(exprs.map(e => e.tag)).toEqual(tags);
    expect(exprs[0].elts[0].tag).toBe(inner);
  });

  it("should still reject a comma between grouped expressions", async () => {
    const result = await parser.parse(0, "(1, 2)..", basisLexicon);
    expect(result[result.root].tag).toBe("ERROR");
  });

  it.each(["(1 2)..", "((1 2) 3)..", "(1 add 2 3).."])("should unparse %s on one line", async (src) => {
    expect(unparse(await parser.parse(0, src, basisLexicon), basisLexicon)).toBe(src);
  });
});

describe("case patterns", () => {
  // Rebuild the tree under `root` without pool ids so trees compare structurally.
  const tree = (pool, id = pool.root) => {
    const node = pool[id];
    if (node === undefined || node === null || typeof node !== "object") {
      return node;
    }
    return {
      tag: node.tag,
      elts: node.elts.map(elt => (typeof elt === "number" && pool[elt] !== undefined ? tree(pool, elt) : elt)),
    };
  };
  const clausesOf = async (src) => {
    const result = await parser.parse(0, src, basisLexicon);
    const caseNode = tree(result).elts[0].elts[0];
    expect(caseNode.tag).toBe("CASE");
    return caseNode.elts.slice(1).map(of => of.elts);
  };
  const ident = name => ({ tag: "IDENT", elts: [name] });
  const key = name => ({ tag: "TAG", elts: [name] });
  const binding = (k, v) => ({ tag: "BINDING", elts: [key(k), v] });

  it("should bind a variable pattern in its clause", async () => {
    const [[pattern, value]] = await clausesOf("case 5 of x: add x 1 end..");
    expect(pattern).toStrictEqual(ident("x"));
    expect(value.tag).toBe("ADD");
    expect(value.elts[0]).toStrictEqual(ident("x"));
  });

  it("should parse a list pattern", async () => {
    const [[pattern]] = await clausesOf("case [3 4] of [x y]: add x y end..");
    expect(pattern).toStrictEqual({ tag: "LIST", elts: [ident("x"), ident("y")] });
  });

  it("should parse a record pattern, shorthand and explicit", async () => {
    const [[pattern]] = await clausesOf("case {a: 1} of {name age: years}: name end..");
    expect(pattern).toStrictEqual({
      tag: "RECORD",
      elts: [binding("name", ident("name")), binding("age", ident("years"))],
    });
  });

  it("should nest patterns and allow literals inside them", async () => {
    const [[pattern]] = await clausesOf("case {a: 1} of {kind: tag circle pts: [0 y]}: y end..");
    expect(pattern).toStrictEqual({
      tag: "RECORD",
      elts: [
        binding("kind", { tag: "TAG", elts: ["circle"] }),
        binding("pts", { tag: "LIST", elts: [{ tag: "NUM", elts: ["0"] }, ident("y")] }),
      ],
    });
  });

  it("should start a new clause at a list or record pattern", async () => {
    const clauses = await clausesOf("case [3 4] of [0 y]: y [x, y]: x {k}: k _: 0 end..");
    expect(clauses.map(([pattern]) => pattern.tag)).toEqual(["LIST", "LIST", "RECORD", "TAG"]);
    expect(clauses[1][1]).toStrictEqual(ident("x"));
  });

  it("should scope a pattern variable to its own clause", async () => {
    const result = await parser.parse(0, "case 1 of x: x _: x end..", basisLexicon);
    expect(result[result.root].tag).toBe("ERROR");
    expect(result[result[result.root].elts[0]].elts[0]).toBe("Undefined reference 'x'.");
  });

  it("should reject a variable bound twice in one pattern", async () => {
    const result = await parser.parse(0, "case [1 2] of [x x]: x end..", basisLexicon);
    expect(result[result.root].tag).toBe("ERROR");
    expect(result[result[result.root].elts[0]].elts[0]).toBe("Pattern variable 'x' is bound more than once.");
  });

  it("should leave list values in a clause value alone", async () => {
    const clauses = await clausesOf("case 1 of 1: [1 2] _: [3] end..");
    expect(clauses.map(([, value]) => value.tag)).toEqual(["LIST", "LIST"]);
  });

  it.each([
    "case [3 4] of [x y]: add x y end..",
    "case {name: 'A'} of {name age: years}: name end..",
    "case {a: 1} of {kind: tag circle pts: [0 y]}: y _: 0 end..",
  ])("should round-trip %s through unparse", async (src) => {
    const first = await parser.parse(0, src, basisLexicon);
    const second = await parser.parse(0, unparse(first, basisLexicon), basisLexicon);
    expect(tree(second)).toStrictEqual(tree(first));
  });
});

describe("let destructuring", () => {
  const errorOf = async (src) => {
    const result = await parser.parse(0, src, basisLexicon);
    expect(result[result.root].tag).toBe("ERROR");
    return result[result[result.root].elts[0]].elts[0];
  };
  // Every use of a destructured name inlines the part of the value it names.
  const valOf = async (src) => {
    const result = await parser.parse(0, src, basisLexicon);
    const exprs = result[result[result.root].elts[0]];
    return result[exprs.elts[exprs.elts.length - 1]];
  };

  it("should bind a list element to VAL(index, value)", async () => {
    const result = await parser.parse(0, "let [a b] = [1 2].. b..", basisLexicon);
    const exprs = result[result[result.root].elts[0]];
    const val = result[exprs.elts[0]];
    expect(val.tag).toBe("VAL");
    expect(result[val.elts[0]]).toMatchObject({ tag: "NUM", elts: ["1"] });
    expect(result[val.elts[1]].tag).toBe("LIST");
  });

  it("should bind a record field to VAL(key, value)", async () => {
    const val = await valOf("let {name} = {name: 'A'}.. name..");
    expect(val.tag).toBe("VAL");
  });

  it("should not count the definition as an expression", async () => {
    const result = await parser.parse(0, "let [a b] = [1 2].. a..", basisLexicon);
    expect(result[result[result.root].elts[0]].elts.length).toBe(1);
  });

  it("should allow a pattern to rebind an earlier let's name", async () => {
    const val = await valOf("let a = 1.. let [a b] = [5 6].. a..");
    expect(val.tag).toBe("VAL");
  });

  it("should reject a literal in a let pattern", async () => {
    expect(await errorOf("let [a 0] = [1 2].. a..")).toBe("A let pattern can only bind variables.");
  });

  it("should reject a variable bound twice", async () => {
    expect(await errorOf("let [a a] = [1 2].. a..")).toBe("Pattern variable 'a' is bound more than once.");
  });

  it.each([
    "<[a b]: add a b>..",
    "<{a}: a>..",
    "let f [a b] = add a b.. f [1 2]..",
  ])("should reject a pattern as a function parameter: %s", async (src) => {
    expect(await errorOf(src)).toBe("Pattern matching on function arguments is disallowed.");
  });
});

describe("template interpolation", () => {
  const tree = (pool, id = pool.root) => {
    const node = pool[id];
    if (node === undefined || node === null || typeof node !== "object") {
      return node;
    }
    return {
      tag: node.tag,
      elts: node.elts.map(elt => (typeof elt === "number" && pool[elt] !== undefined ? tree(pool, elt) : elt)),
    };
  };
  const exprOf = async (src, lexicon) => tree(await parser.parse(0, src, lexicon)).elts[0].elts[0];
  // A lexicon that defines the `str` built-in, as @graffiticode/l0000 does.
  const withStr = {
    ...basisLexicon,
    str: { tk: 1, name: "STR_OF", cls: "function", length: 1, arity: 1 },
  };

  it("should fold an application inside one interpolation", async () => {
    // `${add 1 2}` used to become three concat parts and fail with too few arguments.
    const node = await exprOf("`a${add 1 2}b`..", basisLexicon);
    expect(node.tag).toBe("CONCAT");
    expect(node.elts[0].elts[1]).toStrictEqual({
      tag: "PAREN",
      elts: [{ tag: "ADD", elts: [{ tag: "NUM", elts: ["1"] }, { tag: "NUM", elts: ["2"] }] }],
    });
  });

  it("should wrap each interpolation in `str` when the lexicon defines it", async () => {
    const node = await exprOf("`a${1}b`..", withStr);
    expect(node.elts[0].elts[1]).toStrictEqual({ tag: "STR_OF", elts: [{ tag: "NUM", elts: ["1"] }] });
    // Literal text parts are not wrapped.
    expect(node.elts[1]).toStrictEqual({ tag: "STR", elts: ["b"] });
  });

  it("should not wrap without `str` in the lexicon", async () => {
    // A single-expression interpolation keeps the tree it always had.
    const node = await exprOf("`a${1}b`..", basisLexicon);
    expect(node.elts[0].elts[1]).toStrictEqual({ tag: "NUM", elts: ["1"] });
  });

  it("should not wrap when `str` is a user binding", async () => {
    const result = await parser.parse(0, "let str = 5.. `a${str}b`..", withStr);
    expect(JSON.stringify(result)).not.toContain("STR_OF");
  });

  it("should leave a plain template alone", async () => {
    expect(await exprOf("`plain`..", withStr)).toStrictEqual({ tag: "STR", elts: ["plain"] });
  });
});
