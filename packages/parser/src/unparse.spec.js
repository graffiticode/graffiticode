import { parser } from "./parser.js";
import { unparse } from "./unparse.js";

describe("unparse", () => {
  // Helper function to test round-trip parsing
  async function testRoundTrip(source, lexicon = {}) {
    const ast = await parser.parse(0, source);
    const unparsed = unparse(ast, lexicon);
    return unparsed;
  }

  describe("literals", () => {
    it("should unparse string literals", async () => {
      const source = "'hello, world'..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("'hello, world'..");
    });

    it("should unparse string literals with escaped quotes", async () => {
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

    it("should unparse record with multiple fields", async () => {
      const source = "{x: 10, y: 20}..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("{x: 10, y: 20}..");
    });

    it("should unparse nested records", async () => {
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

    it("should unparse addition", async () => {
      const source = "1 + 2..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("1 + 2..");
    });

    it("should unparse subtraction", async () => {
      const source = "10 - 5..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("10 - 5..");
    });

    it("should unparse multiplication", async () => {
      const source = "3 * 4..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("3 * 4..");
    });

    it("should unparse division", async () => {
      const source = "10 / 2..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("10 / 2..");
    });

    it("should unparse modulo", async () => {
      const source = "10 % 3..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("10 % 3..");
    });

    it("should unparse power", async () => {
      const source = "2 ^ 3..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("2 ^ 3..");
    });

    it("should unparse string concatenation", async () => {
      const source = "'hello' ++ ' world'..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("'hello' ++ ' world'..");
    });

    it("should unparse complex arithmetic expression", async () => {
      const source = "(1 + 2) * 3..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("(1 + 2) * 3..");
    });
  });

  describe("multiple expressions", () => {
    it("should unparse multiple expressions separated by periods", async () => {
      const source = "1.2.3..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("1.2.3..");
    });

    it("should unparse mixed expressions", async () => {
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

    it("should unparse function application", async () => {
      const source = "foo 42..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("foo 42..");
    });

    it("should unparse function with multiple arguments", async () => {
      const source = "foo [1, 2, 3]..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("foo [1, 2, 3]..");
    });

    it("should unparse nested function applications", async () => {
      const source = "foo (bar 42)..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("foo (bar 42)..");
    });
  });

  describe("control flow", () => {
    it("should unparse if-then expression", async () => {
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
    it("should unparse lambda with no parameters", async () => {
      const source = "\\. 42..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("\\. 42..");
    });

    it("should unparse lambda with one parameter", async () => {
      const source = "\\x . x + 1..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("\\x . x + 1..");
    });

    it("should unparse lambda with multiple parameters", async () => {
      const source = "\\x y . x + y..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("\\x y . x + y..");
    });

    it("should unparse lambda application", async () => {
      const source = "(\\x . x + 1) 5..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("(\\x . x + 1) 5..");
    });
  });

  describe("let bindings", () => {
    it("should unparse let with single binding", async () => {
      const source = "let x = 10 in x + 1..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("let x = 10 in x + 1..");
    });

    it("should unparse let with multiple bindings", async () => {
      const source = "let x = 10, y = 20 in x + y..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("let x = 10, y = 20 in x + y..");
    });

    it("should unparse nested let bindings", async () => {
      const source = "let x = 10 in (let y = 20 in x + y)..";
      const unparsed = await testRoundTrip(source);
      expect(unparsed).toBe("let x = 10 in (let y = 20 in x + y)..");
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
});
