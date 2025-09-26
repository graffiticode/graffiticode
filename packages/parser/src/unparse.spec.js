import { parser } from "./parser.js";
import { unparse } from "./unparse.js";
import { lexicon as basisLexicon } from "@graffiticode/basis";

describe("unparse", () => {
  // Helper function to test round-trip parsing
  async function testRoundTrip(source, dialectLexicon = {}, options = { compact: true }) {
    // Merge basis lexicon with dialect lexicon for parsing
    const lexicon = { ...basisLexicon, ...dialectLexicon };
    const ast = await parser.parse(0, source, lexicon);
    const unparsed = unparse(ast, dialectLexicon, options);
    return unparsed;
  }

  describe("literals", () => {
    it("should unparse string literals", async () => {
      const source = "'hello, world'..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe('"hello, world"..');
    });

    it.skip("should unparse string literals with escaped quotes", async () => {
      // Parser doesn't handle escaped quotes properly yet
      const source = "'it\\'s working'..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("'it\\'s working'..");
    });

    it("should unparse numeric literals", async () => {
      const source = "42..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("42..");
    });

    it("should unparse negative numbers", async () => {
      const source = "-42..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("-42..");
    });

    it("should unparse decimal numbers", async () => {
      const source = "3.14159..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("3.14159..");
    });

    it("should unparse boolean true", async () => {
      const source = "true..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("true..");
    });

    it("should unparse boolean false", async () => {
      const source = "false..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("false..");
    });

    it("should unparse null", async () => {
      const source = "null..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("null..");
    });
  });

  describe("data structures", () => {
    it("should unparse empty list", async () => {
      const source = "[]..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("[]..");
    });

    it("should unparse list with single element", async () => {
      const source = "[42]..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("[42]..");
    });

    it("should unparse list with multiple elements", async () => {
      const source = "[1, 2, 3]..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("[1, 2, 3]..");
    });

    it("should unparse nested lists", async () => {
      const source = "[[1, 2], [3, 4]]..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("[[1, 2], [3, 4]]..");
    });

    it("should unparse empty record", async () => {
      const source = "{}..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("{}..");
    });

    it("should unparse record with single field", async () => {
      const source = "{x: 10}..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("{x: 10}..");
    });

    it.skip("should unparse record with multiple fields", async () => {
      const source = "{x: 10, y: 20}..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("{x: 10, y: 20}..");
    });

    it.skip("should unparse nested records", async () => {
      const source = "{a: {b: 1}, c: 2}..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("{a: {b: 1}, c: 2}..");
    });
  });

  describe("expressions", () => {
    it("should unparse parenthesized expression", async () => {
      const source = "(42)..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("(42)..");
    });

    it.skip("should unparse addition", async () => {
      const source = "add 1 2..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("add 1 2..");
    });

    it.skip("should unparse subtraction", async () => {
      const source = "sub 10 5..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("sub 10 5..");
    });

    it.skip("should unparse multiplication", async () => {
      const source = "mul 3 4..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("mul 3 4..");
    });

    it.skip("should unparse division", async () => {
      const source = "div 10 2..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("div 10 2..");
    });

    it.skip("should unparse modulo", async () => {
      const source = "mod 10 3..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("mod 10 3..");
    });

    it.skip("should unparse power", async () => {
      const source = "pow 2 3..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("pow 2 3..");
    });

    it.skip("should unparse string concatenation", async () => {
      const source = "concat 'hello' ' world'..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("concat 'hello' ' world'..");
    });

    it.skip("should unparse complex arithmetic expression", async () => {
      const source = "mul (add 1 2) 3..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("mul (add 1 2) 3..");
    });
  });

  describe("multiple expressions", () => {
    it("should unparse multiple expressions separated by periods", async () => {
      const source = "1.2.3..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("1.2.3..");
    });

    it.skip("should unparse mixed expressions", async () => {
      const source = "'hello'.[1, 2].{x: 10}..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("'hello'.[1, 2].{x: 10}..");
    });
  });

  describe("identifiers and function calls", () => {
    it("should unparse identifier", async () => {
      const source = "foo..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("foo..");
    });

    it.skip("should unparse function application", async () => {
      const source = "foo 42..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("foo 42..");
    });

    it.skip("should unparse function with multiple arguments", async () => {
      const source = "foo [1, 2, 3]..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("foo [1, 2, 3]..");
    });

    it.skip("should unparse nested function applications", async () => {
      const source = "foo (bar 42)..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("foo (bar 42)..");
    });
  });

  describe("control flow", () => {
    it.skip("should unparse if-then expression", async () => {
      const source = "if true then 1..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("if true then 1..");
    });

    it("should unparse if-then-else expression", async () => {
      const source = "if true then 1 else 2..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("if true then 1 else 2..");
    });

    it("should unparse nested if expressions", async () => {
      const source = "if true then (if false then 1 else 2) else 3..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("if true then (if false then 1 else 2) else 3..");
    });
  });

  describe("lambda expressions", () => {
    it.skip("should unparse lambda with no parameters", async () => {
      const source = "\\. 42..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("\\. 42..");
    });

    it.skip("should unparse lambda with one parameter", async () => {
      const source = "\\x . add x 1..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("\\x . add x 1..");
    });

    it.skip("should unparse lambda with multiple parameters", async () => {
      const source = "\\x y . add x y..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("\\x y . add x y..");
    });

    it.skip("should unparse lambda application", async () => {
      const source = "(\\x . add x 1) 5..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("(\\x . add x 1) 5..");
    });
  });

  describe("let bindings", () => {
    it.skip("should unparse let with single binding", async () => {
      const source = "let x = 10 in add x 1..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("let x = 10 in add x 1..");
    });

    it.skip("should unparse let with multiple bindings", async () => {
      const source = "let x = 10, y = 20 in add x y..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("let x = 10, y = 20 in add x y..");
    });

    it.skip("should unparse nested let bindings", async () => {
      const source = "let x = 10 in (let y = 20 in add x y)..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("let x = 10 in (let y = 20 in add x y)..");
    });
  });

  describe("edge cases", () => {
    it("should handle empty program", async () => {
      const source = "..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("..");
    });

    it("should handle null AST", () => {
      const unparsed = unparse(null);
      expect(unparsed).toBe("");
    });

    it("should handle AST without root", () => {
      const unparsed = unparse({});
      expect(unparsed).toBe("");
    });
  });

  describe("parser.reformat", () => {
    it("should reformat simple expressions", async () => {
      const source = "42..";
      const reformatted = await parser.reformat(0, source, basisLexicon);
      expect(reformatted).toBe("42..");
    });

    it("should reformat and pretty print lists", async () => {
      const source = "[1,2,3]..";
      const reformatted = await parser.reformat(0, source, basisLexicon);
      expect(reformatted).toContain("[\n");
      expect(reformatted).toContain("  1");
      expect(reformatted).toContain("  2");
      expect(reformatted).toContain("  3");
      expect(reformatted).toContain("\n]");
    });

    it("should reformat with provided lexicon", async () => {
      const lexicon = {
        "test": {
          "tk": 1,
          "name": "TEST",
          "cls": "function",
          "length": 1,
          "arity": 1,
        }
      };
      const source = "test 42..";
      const reformatted = await parser.reformat(0, source, lexicon);
      expect(reformatted).toBe("test 42..");
    });

    it("should reformat multiple expressions", async () => {
      const source = "'hello'.[1, 2].{x: 10}..";
      const reformatted = await parser.reformat(0, source, basisLexicon);
      expect(reformatted).toContain('"hello"');
      expect(reformatted).toContain("[\n  1");
      expect(reformatted).toContain("{\n  x: 10");
      expect(reformatted).toContain("..");
    });

    it("should support compact option", async () => {
      const source = "[1, 2, 3]..";
      const reformatted = await parser.reformat(0, source, basisLexicon, { compact: true });
      expect(reformatted).toBe("[1, 2, 3]..");
    });

    it("should support custom indent size", async () => {
      const source = "[1, 2]..";
      const reformatted = await parser.reformat(0, source, basisLexicon, { indentSize: 4 });
      expect(reformatted).toContain("    1"); // 4 spaces
      expect(reformatted).toContain("    2"); // 4 spaces
    });

    it("should preserve escaped quotes in strings", async () => {
      const source = '"\\\"hello\\\""..'
      const reformatted = await parser.reformat(0, source, basisLexicon, { compact: true });
      expect(reformatted).toBe('"\\\"hello\\\""..'); // Should produce identical program
    });
  });
});
