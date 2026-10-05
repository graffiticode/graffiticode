// SPDX-License-Identifier: MIT
// Corpus check: every paired RAG example in spec/examples/ must pass the verifyExample GATE — it
// compiles clean AND its composed design signature matches its declared expectation. This runs the
// gate over the whole store on each test run, guarding both bootstrapped and hand-refined examples.
// Advisory compiler warnings are logged, not failed (a human judges those).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
// @ts-expect-error — sibling repo, plain JS, no types
import { parser } from "../../../../graffiticode/packages/parser/src/index.js";
import { lexicon, compiler, verifyExample } from "../dist/index.js";

async function compile(src: string): Promise<{ errors: any[]; data: any }> {
  const ast = await parser.parse("0175", src, lexicon);
  return new Promise((resolve) =>
    compiler.compile(ast, {}, {}, (err: any, data: any) =>
      resolve({ errors: Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [], data })),
  );
}

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "examples");
const gcFiles = existsSync(examplesDir)
  ? readdirSync(examplesDir).filter((f) => f.endsWith(".gc"))
  : [];

describe("RAG example corpus (spec/examples/*.gc)", () => {
  if (gcFiles.length === 0) {
    it("has no examples yet (nothing to verify)", () => expect(gcFiles).toEqual([]));
    return;
  }

  for (const file of gcFiles) {
    it(`${file} passes the verify gate`, async () => {
      const base = file.replace(/\.gc$/, "");
      const code = readFileSync(join(examplesDir, file), "utf-8");
      const expectPath = join(examplesDir, `${base}.expect.json`);
      expect(existsSync(expectPath), `${base}.expect.json is missing`).toBe(true);
      const { expect: expectation } = JSON.parse(readFileSync(expectPath, "utf-8"));

      const { errors, data } = await compile(code);
      const result = verifyExample({ errors, data, code, expect: expectation });

      if (result.advisory.length) {
        console.warn(`[corpus] ${file} advisory:\n  - ${result.advisory.join("\n  - ")}`);
      }
      expect(result.blocking, `${file} blocking failures:\n${result.blocking.join("\n")}`).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }
});
