// SPDX-License-Identifier: MIT
// Every worked program in the spec `.md` files must COMPILE CLEAN — no errors and no compiler
// warnings. These blocks are what the generator imitates, so a doc example that trips a warning
// teaches the very pattern the compiler flags (they had drifted into thin distractor pools, length
// giveaways, missing task-models, an above-grade passage, and one that did not compile at all).
//
// Skeletons with `...` / `…` placeholders are illustrative syntax, not programs, and are skipped.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
// @ts-expect-error — sibling repo, plain JS, no types
import { parser } from "../../../../graffiticode/packages/parser/src/index.js";
import { lexicon, compiler } from "../dist/index.js";

async function compile(src: string): Promise<{ errors: any[]; data: any }> {
  const ast = await parser.parse("0175", src, lexicon);
  return new Promise((resolve) =>
    compiler.compile(ast, {}, {}, (err: any, data: any) =>
      resolve({ errors: Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [], data })),
  );
}

const specDir = join(dirname(fileURLToPath(import.meta.url)), "..", "spec");

// (file, index-within-file, code) for every fenced block that is a complete L0175 program.
const examples: Array<[string, number, string]> = [];
for (const file of readdirSync(specDir).filter((f) => f.endsWith(".md")).sort()) {
  const md = readFileSync(join(specDir, file), "utf-8");
  let n = 0;
  for (const m of md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    const code = m[1];
    const isProgram = code.trimStart().startsWith("target c1-t") && code.includes("{}..");
    const isSkeleton = code.includes("...") || code.includes("…");
    if (isProgram && !isSkeleton) examples.push([file, n++, code]);
  }
}

describe("spec doc examples compile clean", () => {
  it("finds the worked programs (guards the extractor itself against silently matching none)", () => {
    expect(examples.length).toBeGreaterThanOrEqual(8);
    // every target with a worked example should appear
    const targets = new Set(examples.map(([, , c]) => c.match(/target (c1-t\d+)/)![1]));
    expect(targets).toContain("c1-t4");
    expect(targets).toContain("c1-t2");
    expect(targets).toContain("c1-t1");
  });

  for (const [file, n, code] of examples) {
    it(`${file} program #${n} compiles with no errors and no warnings`, async () => {
      const { errors, data } = await compile(code);
      expect(errors.map((e: any) => e.message ?? String(e))).toEqual([]);
      const items = data == null ? [] : data.kind === "items" ? data.items : [data];
      const warnings = items.flatMap((i: any) => i?.warnings ?? []);
      expect(warnings).toEqual([]);
    });
  }
});
