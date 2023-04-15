import vm from "vm";
import { getLangAsset } from "./index.js";
import { parse } from "./parse.js";

// commonjs export
const main = {
  parse(src, lexicon) {
    const stream = new parse.StringStream(src);
    const state = {
      cc: parse.program, // top level parsing function
      argc: 0,
      argcStack: [0],
      paramc: 0,
      paramcStack: [0],
      env: [{ name: "global", lexicon }],
      exprc: 0,
      exprcStack: [0],
      nodeStack: [],
      nodeStackStack: [],
      nodePool: ["unused"],
      nodeMap: {},
      nextToken: -1,
      errors: [],
      coords: [],
      inStr: 0,
      quoteCharStack: []
    };
    const next = function () {
      return parse.parse(stream, state);
    };
    let ast;
    while (state.cc !== null && stream.peek()) {
      ast = next();
    }
    if (state.cc) {
      console.log("parse() src=" + src);
      throw new Error("End of program reached.");
    }
    return ast;
  }
};

export const buildParser = ({
  log,
  cache,
  getLangAsset,
  main,
  vm
}) => {
  return {
    async parse(lang, src) {
      if (cache.has(lang)) {
        return main.parse(src, cache.get(lang));
      } else {
        let data = await getLangAsset(lang, "/lexicon.js");
        // TODO Make lexicon JSON.
        if (data instanceof Buffer) {
          data = data.toString();
        }
        if (typeof (data) !== "string") {
          log(`Failed to get usable lexicon for ${lang}`, typeof (data), data);
          throw new Error("unable to use lexicon");
        }
        const lstr = data.substring(data.indexOf("{"));
        let lexicon;
        try {
          lexicon = JSON.parse(lstr);
        } catch (err) {
          if (err instanceof SyntaxError) {
            log(`failed to parse ${lang} lexicon: ${err.message}`);
            const context = { window: { gcexports: {} } };
            vm.createContext(context);
            vm.runInContext(data, context);
            if (typeof (context.window.gcexports.globalLexicon) === "object") {
              lexicon = context.window.gcexports.globalLexicon;
            }
          }
          if (!lexicon) {
            throw new Error("Malformed lexicon");
          }
        }
        cache.set(lang, lexicon);
        return await main.parse(src, lexicon);
      };
    }
  };
};

export const parser = buildParser({
  log: console.log,
  cache: new Map(),
  getLangAsset,
  main,
  vm
});
