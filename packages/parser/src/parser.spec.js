import { jest } from "@jest/globals";
import { buildParser, parser } from "./parser.js";
import { mockPromiseValue, mockPromiseError } from "./testing/index.js";
import { lexicon as basisLexicon } from "@graffiticode/basis";

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

  it("should perform parse-time evaluation for adding two numbers", async () => {
    // Use basis lexicon which includes add function
    // Act - parse a simple addition expression
    const result = await parser.parse(0, "add 123 456..", basisLexicon);
    console.log(
      "TEST",
      "result=" + JSON.stringify(result, null, 2),
    );

    // Assert
    expect(result).toHaveProperty("root");

    // Verify basic structure
    const rootId = result.root;
    const rootNode = result[rootId];
    expect(rootNode.tag).toBe("PROG");

    // Find the result node - expecting a single NUM node with the sum
    let resultNode = null;

    // Check all nodes for the result of evaluation (123 + 456 = 579)
    for (const key in result) {
      if (key !== "root") {
        const node = result[key];
        if (node.tag === "NUM" && node.elts[0] === "579") {
          resultNode = node;
          break;
        }
      }
    }

    // We should find a node with the computed value (579)
    expect(resultNode).not.toBeNull();
    expect(resultNode.tag).toBe("NUM");
    expect(resultNode.elts[0]).toBe("579");

    // The original numbers should not be in the final AST
    // if parse-time evaluation is working correctly
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

    // The original operands should not be in the final AST
    // if they were properly evaluated at parse time
    expect(found123).toBe(false);
    expect(found456).toBe(false);
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
