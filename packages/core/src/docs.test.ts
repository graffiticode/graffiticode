// SPDX-License-Identifier: MIT
/**
 * The published surface is tested, not decorative — the same rule the sibling
 * dialects follow. These docs are LLM input as well as human input, so a wrong
 * example is reproduced verbatim into generated programs.
 *
 * The check is that every fenced program COMPILES, not merely parses. Parsing
 * is a weak gate here: `//` is not a comment but lexes as two division
 * operators, and a mis-escaped `"\times"` is a perfectly valid string — both
 * parse clean and fail later.
 */
import { test, expect, describe } from "vitest";
import { readFileSync } from "node:fs";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon, deprecatedWords } from "./index.js";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf-8");

async function compileSrc(src: string) {
  const code = await parser.parse(14, src, lexicon);
  return await new Promise<any>((res, rej) =>
    compiler.compile(code, {}, {}, (e: any, v: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) rej(errs);
      else res(v);
    }));
}

/** Fenced blocks that look like programs — i.e. that end in the `..` terminator. */
function programs(md: string): string[] {
  return [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
    .map((m) => m[1].trim())
    .filter((s) => s.endsWith(".."));
}

const SPEC_FILES = ["../spec/spec.md", "../spec/instructions.md", "../spec/usage-guide.md"];

describe("spec programs compile", () => {
  for (const file of SPEC_FILES) {
    const src = read(file);
    programs(src).forEach((program, i) => {
      test(`${file} program ${i + 1}`, async () => {
        await expect(compileSrc(program)).resolves.toBeTruthy();
      });
    });
  }

  test("the starter template compiles", async () => {
    const out = await compileSrc(read("../spec/template.gc"));
    expect(out.options).toBeTruthy();
    expect(out.tests).toHaveLength(1);
  });

  test("at least one program was actually found", () => {
    // Guards against the fence-matching regex silently matching nothing, which
    // would make every test above pass vacuously.
    const found = SPEC_FILES.reduce((n, f) => n + programs(read(f)).length, 0);
    expect(found).toBeGreaterThan(0);
  });
});

describe("docs stay in step with the language", () => {
  test("every word in spec.md's tables exists in the lexicon", () => {
    const documented = [...read("../spec/spec.md").matchAll(/^\| `([a-z][a-z-]+)`/gm)]
      .map((m) => m[1]);
    expect(documented.length).toBeGreaterThan(0);
    const unknown = documented.filter((w) => !(w in lexicon));
    expect(unknown, `documented but not in the lexicon: ${unknown.join(", ")}`).toEqual([]);
  });

  test("no retired word is advertised in a code span", () => {
    // RHS/NoParens/EndRoot were L120's context alternates and are not ported.
    // Documenting one would teach a generator to write a program that cannot
    // compile.
    for (const file of SPEC_FILES) {
      const spans = [...read(file).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      for (const word of deprecatedWords) {
        expect(spans, `${file} advertises retired word ${word}`).not.toContain(word);
      }
    }
  });

  test("usage-guide.md has the Overview that language-info's authoring_guide is built from", () => {
    const guide = read("../spec/usage-guide.md");
    const overview = guide.split(/^## /m).find((s) => s.startsWith("Overview"));
    expect(overview, "usage-guide.md must have an ## Overview section").toBeTruthy();
    expect(overview!.length).toBeGreaterThan(100);
  });

  test("examples.md numbering is coherent", () => {
    const md = read("../spec/examples.md");
    const nums = [...md.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(nums).toEqual(nums.map((_, i) => i + 1));
    const stated = md.match(/^(\d+) example prompts/m);
    expect(stated, "header must state the prompt count").toBeTruthy();
    expect(Number(stated![1])).toBe(nums.length);
  });
});
