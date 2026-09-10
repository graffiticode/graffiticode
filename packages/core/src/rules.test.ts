// SPDX-License-Identifier: MIT
/**
 * The port's acceptance test.
 *
 * L0014 is a port of L120, the language that compiled every rule set TransLaTeX
 * ships. There is no way to test a port like that against intent — the original
 * host is gone and its author's expectations with it. What there IS, is the
 * exact output the original produced: `@graffiticode/translatex/src/rules.js`,
 * still shipping, still byte-identical to the `data.txt` recovered from
 * `artcompiler-translatex-0.15.0.tgz`.
 *
 * So the test is identity. Reconstruct that rule set as L0014 source, compile
 * it, and require the result to equal the original exactly. Anything less —
 * "compiles without error", "looks right" — would pass on a port that quietly
 * reorders rules, drops the array wrap, or eats a backslash, and every one of
 * those is a silent mis-translation downstream rather than a failure.
 *
 * Key ORDER is part of the comparison, not incidental. translatex's `match()`
 * filters patterns in `Object.keys` order and takes the first hit, so the order
 * rules are written in IS their precedence.
 */
import { test, expect, describe } from "vitest";
import { readFileSync } from "node:fs";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "./index.js";
import { toSource } from "./pretty.js";

async function compileSrc(src: string) {
  const code = await parser.parse(14, src, lexicon);
  return await new Promise<any>((res, rej) =>
    compiler.compile(code, {}, {}, (e: any, v: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) rej(errs);
      else res(v);
    }));
}

describe("the language surface", () => {
  test("words, types and rules compile into one options record", async () => {
    const out = await compileSrc(`
      words { "\\\\alpha": "\\\\alpha" }
      types { "signedExpr": ["-?", "+?"] }
      rules { "?+?": "%1+%2" }
      tests []
      ..`);
    expect(out.options.words).toEqual({ "\\alpha": "\\alpha" });
    expect(out.options.types).toEqual({ signedExpr: ["-?", "+?"] });
    expect(out.options.rules).toEqual({ "?+?": ["%1+%2"] });
  });

  test("a bare rule expansion is wrapped in a list, a list is left alone", async () => {
    // Transcribed from L120's rules(). Every shipping rule set has the wrapped
    // shape, so getting this wrong would break all of them at once.
    const out = await compileSrc(`rules { "?": "%1", "??": ["%1%2"] } tests []..`);
    expect(out.options.rules).toEqual({ "?": ["%1"], "??": ["%1%2"] });
  });

  test("options always carry an empty data record", async () => {
    // A vestige of the old host that every recovered rule set has. Emitting it
    // is what keeps the round-trip byte-identical.
    const out = await compileSrc(`rules { "?": "%1" } tests []..`);
    expect(out.options.data).toEqual({});
  });

  test("rule order is preserved, because order is precedence", async () => {
    const out = await compileSrc(
      `rules { "?+?": "a", "?*?": "b", "?": "c", "??": "d" } tests []..`);
    expect(Object.keys(out.options.rules)).toEqual(["?+?", "?*?", "?", "??"]);
  });

  test("statements may appear in any order — unlike L120, tests need not be last", async () => {
    const out = await compileSrc(`tests [] rules { "?": "%1" } words { "a": "b" }..`);
    expect(out.options.rules).toEqual({ "?": ["%1"] });
    expect(out.options.words).toEqual({ a: "b" });
  });
});

describe("the corpus", () => {
  test("a test scores 1 when the translation matches and -1 when it does not", async () => {
    const out = await compileSrc(
      `rules { "?+?": "%1 plus %2", "?": "%1" } tests [["1+2", "1 plus 2"], ["1+2", "nope"]]..`);
    expect(out.tests[0]).toMatchObject({ score: 1, source: "1+2", actual: "1 plus 2" });
    expect(out.tests[1]).toMatchObject({ score: -1, expected: "nope" });
  });

  test("an empty expectation captures what the rule set does today", async () => {
    // How the original corpus was written: every one of its LaTeX cases has ""
    // on the right, so the compiled `actual` is the baseline.
    const out = await compileSrc(`rules { "?+?": "%1+%2", "?": "%1" } tests [["1+2", ""]]..`);
    expect(out.tests[0].actual).toBe("1+2");
    expect(out.tests[0].score).toBe(-1);
  });
});

describe("round trip against the shipping rule set", () => {
  // The rule set translatex ships today. Read from the installed package rather
  // than copied here, so this test tracks the real artifact.
  const shipped = JSON.parse(readFileSync(
    new URL("./fixtures/latex-to-latex.json", import.meta.url), "utf-8"));

  test("the fixture is the rule set translatex actually ships", async () => {
    const { rules } = await import("@graffiticode/translatex/src/rules.js" as any);
    expect(rules.words).toEqual(shipped.words);
    expect(rules.types).toEqual(shipped.types);
    expect(rules.rules).toEqual(shipped.rules);
    expect(Object.keys(rules.rules)).toEqual(Object.keys(shipped.rules));
  });

  test("compiling the reconstructed source reproduces it exactly", async () => {
    const src = toSource({ options: shipped, tests: [] });
    const out = await compileSrc(src);
    expect(out.options.words).toEqual(shipped.words);
    expect(out.options.types).toEqual(shipped.types);
    expect(out.options.rules).toEqual(shipped.rules);
  });

  test("rule order survives the round trip", async () => {
    const src = toSource({ options: shipped, tests: [] });
    const out = await compileSrc(src);
    expect(Object.keys(out.options.rules)).toEqual(Object.keys(shipped.rules));
    expect(Object.keys(out.options.words)).toEqual(Object.keys(shipped.words));
  });

  test("the COMMITTED source file reproduces it — this is the deliverable", async () => {
    // The generated-in-memory checks above prove toSource is correct. This one
    // proves the artifact we actually keep is correct, which is a different
    // claim: spec/latex-to-latex.gc is hand-editable from here on, and this is
    // what stops an edit silently changing the rule set.
    const src = readFileSync(new URL("../spec/latex-to-latex.gc", import.meta.url), "utf-8");
    const out = await compileSrc(src);
    expect(out.options.words).toEqual(shipped.words);
    expect(out.options.types).toEqual(shipped.types);
    expect(out.options.rules).toEqual(shipped.rules);
    expect(Object.keys(out.options.rules)).toEqual(Object.keys(shipped.rules));
  });

  test("every backslash survives — the escaping hazard the old surface had", async () => {
    // "\times" through the modern parser is TAB + "imes". Doubling in toSource
    // is what prevents it, and these are the patterns that would catch it.
    const src = toSource({ options: shipped, tests: [] });
    const out = await compileSrc(src);
    for (const key of Object.keys(shipped.words)) {
      expect(out.options.words[key], `word ${JSON.stringify(key)}`).toBe(shipped.words[key]);
    }
    expect(JSON.stringify(out.options.rules)).not.toMatch(/[\t\n\r]/);
  });
});
