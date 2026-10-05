// SPDX-License-Identifier: MIT
// Unit tests for the verifyExample GATE (src/verify-example.ts): it accepts a correctly-labeled
// example and REJECTS a mislabeled one — including the case that compiles clean but is the wrong
// item type for the intended task model (the drift a human refiner can miss).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
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

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "examples");
const seed = readFileSync(join(dir, "c1-t9-tm3-ebsr.gc"), "utf-8"); // composes as c1-t9 / ebsr / tm3

describe("verifyExample gate", () => {
  it("accepts the example when the expectation matches what it composes", async () => {
    const { errors, data } = await compile(seed);
    const r = verifyExample({
      errors, data,
      expect: { target: "c1-t9", taskModel: "tm3", itemType: "ebsr", dimension: "central-idea", standard: "ri-2" },
    });
    expect(r.blocking).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.facets.taskModels).toContain("3");
  });

  it("rejects a mislabeled example even though it compiles clean (wrong item type / task model)", async () => {
    const { errors, data } = await compile(seed);
    // Same clean program, but labeled as if it were the tm4 hot-text sibling.
    const r = verifyExample({
      errors, data,
      expect: { target: "c1-t9", taskModel: "tm4", itemType: "hot-text", dimension: "central-idea" },
    });
    expect(r.ok).toBe(false);
    expect(r.blocking.join("\n")).toMatch(/item type: expected exactly \[hot-text\]/);
    expect(r.blocking.join("\n")).toMatch(/task model: expected tm4/);
  });

  it("rejects an internally inconsistent expectation (tm3 is ebsr, not hot-text, in c1-t9)", async () => {
    const { errors, data } = await compile(seed);
    const r = verifyExample({
      errors, data,
      expect: { target: "c1-t9", taskModel: "tm3", itemType: "hot-text" },
    });
    expect(r.ok).toBe(false);
    expect(r.blocking.join("\n")).toMatch(/expectation is inconsistent: tm3 is 'ebsr' for c1-t9/);
  });

  it("rejects an unknown target", async () => {
    const { errors, data } = await compile(seed);
    const r = verifyExample({ errors, data, expect: { target: "c1-t99" } });
    expect(r.ok).toBe(false);
    expect(r.blocking.join("\n")).toMatch(/unknown expected target 'c1-t99'/);
  });
});
