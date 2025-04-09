import { buildParser } from "./parser.js";
import { mockPromiseValue } from "./testing/index.js";

describe("parse operations", () => {
  const log = jest.fn();

  it("should parse 'apply (<a b: add a b>) [10 20]'", async () => {
    // Arrange
    const cache = new Map();
    const getLangAsset = mockPromiseValue("{}");
    const main = {
      parse: mockPromiseValue({
        1: {
          elts: ["a"],
          tag: "IDENT"
        },
        2: {
          elts: ["b"],
          tag: "IDENT"
        },
        3: {
          elts: [1, 2],
          tag: "ADD"
        },
        4: {
          elts: [3],
          tag: "EXPRS"
        },
        5: {
          elts: [1, 2],
          tag: "LIST"
        },
        6: {
          elts: [5, 4],
          tag: "LAMBDA"
        },
        7: {
          elts: ["10"],
          tag: "NUM"
        },
        8: {
          elts: ["20"],
          tag: "NUM"
        },
        9: {
          elts: [7, 8],
          tag: "LIST"
        },
        10: {
          elts: [6, 9],
          tag: "APPLY"
        },
        11: {
          elts: [10],
          tag: "EXPRS"
        },
        12: {
          elts: [11],
          tag: "PROG"
        },
        root: 12
      })
    };
    const parser = buildParser({ log, cache, getLangAsset, main });
    const lang = "0002";
    const src = "apply (<a b: add a b>) [10 20]..";

    // Act
    const result = await parser.parse(lang, src);

    // Assert
    expect(result).toHaveProperty("root", 12);
    expect(result[10].tag).toBe("APPLY");
    expect(result[10].elts).toEqual([6, 9]);
    expect(result[6].tag).toBe("LAMBDA");
    expect(result[9].tag).toBe("LIST");
  });

  it("should parse 'hello, world!'", async () => {
    // Arrange
    const cache = new Map();
    const getLangAsset = mockPromiseValue("{}");
    const main = {
      parse: mockPromiseValue({
        1: {
          elts: [
            "hello, world"
          ],
          tag: "STR"
        },
        2: {
          elts: [
            1
          ],
          tag: "EXPRS"
        },
        3: {
          elts: [
            2
          ],
          tag: "PROG"
        },
        root: 3
      })
    };
    const parser = buildParser({ log, cache, getLangAsset, main });
    const lang = "0002";
    const src = "'hello, world'..";

    // Act
    const result = await parser.parse(lang, src);

    // Assert
    expect(result).toHaveProperty("root", 3);
    expect(result[1].tag).toBe("STR");
    expect(result[1].elts).toEqual(["hello, world"]);
  });
});
