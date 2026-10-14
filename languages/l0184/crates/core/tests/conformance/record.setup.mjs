// SPDX-License-Identifier: MIT
//
// A vitest setup file, used only by generate.mjs: while the TypeScript suite runs, it records
// every program the suite compiles, with the data it compiles it against, one JSON line per
// compile, to the file named by L0184_RECORD. Most of the suite builds its programs with
// template helpers, so reading them out of the test sources would miss them.
import { appendFileSync } from "fs";
import { parser } from "@graffiticode/parser";
import { Compiler } from "@graffiticode/l0000";

const out = process.env.L0184_RECORD;
let last;

const parse = parser.parse;
parser.parse = function (lang, src, ...rest) {
  last = src;
  return parse.call(this, lang, src, ...rest);
};

const compile = Compiler.prototype.compile;
Compiler.prototype.compile = function (code, data, ...rest) {
  if (out && last !== undefined) {
    appendFileSync(out, JSON.stringify({ src: last, data: data ?? {} }) + "\n");
  }
  last = undefined;
  return compile.call(this, code, data, ...rest);
};
