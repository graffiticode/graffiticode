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

export const buildParser = ({ main }) => {
  return {
    async parse(lang, src, lexicon) {
      // Lexicon is now required
      if (!lexicon) {
        throw new Error("Lexicon is required for parsing");
      }
      return await main.parse(src, lexicon);
    }
  };
};

export const parser = buildParser({
  main
});

// Add unparse as a property of parser
parser.unparse = unparse;

// Add reformat function that parses and unparses code
parser.reformat = async function(lang, src, lexicon, options = {}) {
  if (!lexicon) {
    throw new Error("Lexicon is required for reformatting");
  }
  const ast = await this.parse(lang, src, lexicon);
  return unparse(ast, lexicon, options);
};
