import vm from "vm";
import { getLangAsset } from "../../api/src/lang/index.js";
import { parse } from "./parse.js";
import { unparse } from "./unparse.js";

// commonjs export
const main = {
  parse(src, lexicon) {
    const stream = new parse.StringStream(src);
    const state = {
      cc: parse.program, // top level parsig function
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
    async parse(lang, src, lexicon = null) {
      // If lexicon is provided, use it directly
      if (lexicon) {
        return await main.parse(src, lexicon);
      }

      // Otherwise, load from cache or remote
      if (!cache.has(lang)) {
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
        let loadedLexicon;
        try {
          loadedLexicon = JSON.parse(lstr);
        } catch (err) {
          if (err instanceof SyntaxError) {
            log(`failed to parse ${lang} lexicon: ${err.message}`);
            const context = { window: { gcexports: {} } };
            vm.createContext(context);
            vm.runInContext(data, context);
            if (typeof (context.window.gcexports.globalLexicon) === "object") {
              loadedLexicon = context.window.gcexports.globalLexicon;
            }
          }
          if (!loadedLexicon) {
            throw new Error("Malformed lexicon");
          }
        }
        cache.set(lang, loadedLexicon);
      };
      const cachedLexicon = cache.get(lang);
      return await main.parse(src, cachedLexicon);
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

// Add unparse as a property of parser
parser.unparse = unparse;

// Add reformat function that parses and unparses code
parser.reformat = async function(lang, src, lexicon, options = {}) {
  const ast = await this.parse(lang, src, lexicon);
  return unparse(ast, lexicon, options);
};
