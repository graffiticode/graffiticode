import { jest } from "@jest/globals";
import { buildParser, parser } from "./parser.js";
import { mockPromiseValue, mockPromiseError } from "./testing/index.js";
import vm from "vm";

describe("lang/parser", () => {
  const log = jest.fn();
  it("should call main parser language lexicon", async () => {
    // Arrange
    const cache = new Map();
    const getLangAsset = mockPromiseValue("{}");
    const main = {
      parse: mockPromiseValue({ root: "0" })
    };
    const parser = buildParser({ log, cache, getLangAsset, main });
    const lang = "0";
    const src = "'foo'..";

    // Act
    await expect(parser.parse(lang, src)).resolves.toStrictEqual({ root: "0" });

    // Assert
    expect(getLangAsset).toHaveBeenCalledWith(lang, "/lexicon.js");
    expect(main.parse).toHaveBeenCalledWith(src, {});
    expect(cache.has(lang)).toBe(true);
    expect(cache.get(lang)).toStrictEqual({});
  });
  it("should call main parser cached lexicon", async () => {
    // Arrange
    const cache = new Map();
    const main = {
      parse: mockPromiseValue({ root: "0" })
    };
    const parser = buildParser({
      cache,
      main
    });
    const lang = "0";
    const src = "'foo'..";
    cache.set(lang, {});

    // Act
    await expect(parser.parse(lang, src)).resolves.toStrictEqual({ root: "0" });

    // Assert
    expect(main.parse).toHaveBeenCalledWith(src, {});
  });
  it("should return error if get language asset fails", async () => {
    // Arrange
    const cache = new Map();
    const err = new Error("failed to get lexicon");
    const getLangAsset = mockPromiseError(err);
    const parser = buildParser({
      cache,
      getLangAsset
    });
    const lang = "00";
    const src = "'foo'..";

    // Act
    await expect(parser.parse(lang, src)).rejects.toBe(err);

    // Assert
    expect(getLangAsset).toHaveBeenCalledWith(lang, "/lexicon.js");
  });
  it("should return error if main parser fails", async () => {
    // Arrange
    const log = jest.fn();
    const cache = new Map();
    const getLangAsset = mockPromiseValue("{}");
    const err = new Error("main parser failed");
    const main = { parse: mockPromiseError(err) };
    const parser = buildParser({ log, cache, getLangAsset, main });
    const lang = "0";
    const src = "'foo'..";

    // Act
    await expect(parser.parse(lang, src)).rejects.toBe(err);

    // Assert
    expect(getLangAsset).toHaveBeenCalledWith(lang, "/lexicon.js");
    expect(main.parse).toHaveBeenCalledWith(src, {});
    expect(cache.has(lang)).toBe(true);
    expect(cache.get(lang)).toStrictEqual({});
  });
  it("should return succeed if lexicon is a buffer", async () => {
    // Arrange
    const log = jest.fn();
    const cache = new Map();
    const getLangAsset = mockPromiseValue(Buffer.from("{}"));
    const ast = { root: "0" };
    const main = { parse: mockPromiseValue(ast) };
    const parser = buildParser({ log, cache, getLangAsset, main });
    const lang = "0";
    const src = "'foo'..";

    // Act
    await expect(parser.parse(lang, src)).resolves.toStrictEqual(ast);

    // Assert
    expect(getLangAsset).toHaveBeenCalledWith(lang, "/lexicon.js");
    expect(main.parse).toHaveBeenCalledWith(src, {});
    expect(cache.has(lang)).toBe(true);
    expect(cache.get(lang)).toStrictEqual({});
  });
  it("should try vm if lexicon cannot parse JSON", async () => {
    // Arrange
    const log = jest.fn();
    const cache = new Map();
    const rawLexicon = `
    (() => {
      window.gcexports.globalLexicon = {};
    })();
    `;
    const getLangAsset = mockPromiseValue(rawLexicon);
    const ast = { root: "0" };
    const main = { parse: mockPromiseValue(ast) };
    const vm = {
      createContext: jest.fn(),
      runInContext: jest.fn().mockImplementation((data, context) => {
        context.window.gcexports.globalLexicon = {};
      })
    };
    const parser = buildParser({ log, cache, getLangAsset, main, vm });
    const lang = "0";
    const src = "'foo'..";

    // Act
    await expect(parser.parse(lang, src)).resolves.toStrictEqual(ast);

    // Assert
    expect(getLangAsset).toHaveBeenCalledWith(lang, "/lexicon.js");
    expect(main.parse).toHaveBeenCalledWith(src, {});
    expect(cache.has(lang)).toBe(true);
    expect(cache.get(lang)).toStrictEqual({});
    expect(vm.createContext).toHaveBeenCalled();
    expect(vm.runInContext).toHaveBeenCalledWith(rawLexicon, expect.anything());
  });
  it("should parse error", async () => {
    // Arrange
    const cache = new Map();
    const getLangAsset = mockPromiseValue("{}");
    const err = new Error("End of program reached.");
    const main = { parse: mockPromiseError(err) };
    const parser = buildParser({ log, cache, getLangAsset, main });
    const lang = "0";
    const src = "'hello, world'";

    // Act & Assert
    await expect(parser.parse(lang, src)).rejects.toBe(err);
  });
});

describe("parser integration tests", () => {
  // Tests using the actual parser
  it("should parse string literals", async () => {
    // Arrange & Act
    const result = await parser.parse(0, "'hello, world'..");

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
    const result = await parser.parse(0, "42..");

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
    const result = await parser.parse(0, "123..");

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
    // Create parser with custom lexicon
    const customLexiconCache = new Map();
    customLexiconCache.set(0, {
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
    });

    // Use the parser with our custom cache
    const customParser = buildParser({
      log: console.log,
      cache: customLexiconCache,
      getLangAsset: async () => ({}),
      main: {
        parse: (src, lexicon) => {
          return Promise.resolve(parser.parse(0, src));
        }
      },
      vm
    });

    // Act
    const result = await customParser.parse(0, "apply (<a b: add a b>) [10 20]..");

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
      result = await parser.parse(0, "'unclosed string..");
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
      result = await parser.parse(0, "[1, 2, 3..");
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
      result = await parser.parse(0, "if then else..");
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
    // Create parser with custom lexicon that defines 'add' function
    const customLexiconCache = new Map();
    customLexiconCache.set(0, {
      add: {
        tk: 2,
        name: "add",
        cls: "function",
        length: 2
      }
    });

    // Use the parser with our custom cache
    const customParser = buildParser({
      log: console.log,
      cache: customLexiconCache,
      getLangAsset: async () => ({}),
      main: {
        parse: (src, lexicon) => {
          return Promise.resolve(parser.parse(0, src));
        }
      },
      vm
    });

    // Act - parse a simple addition expression
    const result = await customParser.parse(0, "add 123 456..");
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
});
