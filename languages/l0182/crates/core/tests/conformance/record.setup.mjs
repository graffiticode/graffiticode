// SPDX-License-Identifier: MIT
//
// A Vitest setup file used only by generate.mjs: it runs the TypeScript suite as written and
// records every program the suite parses, with the public values it resolved and the survey
// data the suite's fixture source was serving at that moment (null when the suite reads the
// real data/ directory). generate.mjs then compiles each recorded program itself, so the
// expectations come from the same pipeline as every other case.
import { appendFileSync } from "fs";
import { parser } from "@graffiticode/parser";
import { loadSurvey } from "../../../../packages/core/src/source.ts";

const out = process.env.L0182_RECORD;
const parse = parser.parse;

// Some tests write a response to whichever version they drew, so a random draw would make the
// recorded programs differ from run to run.
if (out) Math.random = () => 0;

if (out && !parse.recording) {
  parser.parse = async function (lang, src, lexicon, callbacks) {
    const values = {};
    const recorded = callbacks?.GET_VAL_PUBLIC
      ? {
          ...callbacks,
          GET_VAL_PUBLIC: (name) => (values[name] = callbacks.GET_VAL_PUBLIC(name)),
        }
      : callbacks;
    const ast = await parse.call(this, lang, src, lexicon, recorded);
    let fixture = null;
    try {
      fixture = (await loadSurvey("fixture", {})).data;
    } catch {
      // The real data/ directory, which has no survey called "fixture".
    }
    appendFileSync(out, JSON.stringify({ src, values, fixture }) + "\n");
    return ast;
  };
  parser.parse.recording = true;
}
