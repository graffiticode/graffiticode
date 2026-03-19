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
    expect(main.parse).toHaveBeenCalledWith(src, providedLexicon);
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
    expect(main.parse).toHaveBeenCalledWith(src, lexicon);
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
    expect(main.parse).toHaveBeenCalledWith(src, lexicon);
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
    expect(main.parse).toHaveBeenCalledWith(src, lexicon);
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
});
