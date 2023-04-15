import { jest } from "@jest/globals";
import { parser, buildParser } from "./parser.js";
import { mockPromiseValue, mockPromiseError } from "../testing/index.js";

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
  it.skip("should parse 'hello, world!'", async () => {
    const lang = "0";
    const src = "'hello, world'..";
    const ast = {
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
    };
    await expect(parser.parse(lang, src)).resolves.toStrictEqual(ast);
  });
  it.skip("should parse error", async () => {
    const lang = "0";
    const src = "'hello, world'";
    await expect(parser.parse(lang, src)).rejects.toThrow("End of program reached");
  });
  // it("should parse error", async () => {
  //   const lang = "0";
  //   const src = "'hello, world..";
  //   const ast = {};
  //   await expect(parser.parse(lang, src)).rejects.toThrow("End of program reached");
  // });
});
