// SPDX-License-Identifier: MIT
// Tests for the per-target task-model guard (src/compiler.ts validateOutcome + src/targets.ts).
// Task-model numbers are PER-TARGET and collide across targets (tm3 = short-text in c1-t4/t11,
// ebsr in c1-t9, hot-text in c1-t1/t8/t10), so the compiler resolves an authored `task-model` against
// the program's target. This is the deterministic guard against the "c1-t9 tm3 EBSR drifts to
// hot-text/short-text" generation failure.
import { describe, it, expect } from "vitest";
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

const messages = (errors: any[]): string => errors.map((e) => e.message || String(e)).join("\n");

// One outcome carrying the given attributes, on a minimal c1-t9 program. Other validation gaps
// (thin claim pool, missing stem-b) are irrelevant — the tests match only task-model messages.
const t9 = (outcomeAttrs: string) => `target c1-t9 passage "P" type informational lines [
    "Honeybees coordinate to keep the hive alive."
    "Each bee has a role that supports the whole."
  ] claims [
    claim id "c1" status supported dimension central-idea text "Honeybees survive through coordinated roles." {}
  ]
  evidence []
  outcomes [ outcome id "q1" ${outcomeAttrs} dimension central-idea focus "c1" stem "Determine the main idea." {} ] {}..`;

describe("task-model resolution (per-target)", () => {
  it("c1-t9 tm3 resolves to ebsr — a matching `type ebsr` is accepted", async () => {
    const { errors } = await compile(t9(`task-model tm3 type ebsr stem-b "Which detail best supports it?"`));
    expect(messages(errors)).not.toMatch(/task model/i);
  });

  it("c1-t9 tm3 with `type short-text` is a hard mismatch (the drift the guard catches)", async () => {
    const { errors } = await compile(t9(`task-model tm3 type short-text`));
    expect(messages(errors)).toMatch(/task model 'tm3' is ebsr for target c1-t9, but type is 'short-text'/);
  });

  it("c1-t9 tm3 with no `type` infers ebsr (no empty-type error)", async () => {
    const { errors } = await compile(t9(`task-model tm3 stem-b "Which detail best supports it?"`));
    const m = messages(errors);
    expect(m).not.toMatch(/task model/i);
    expect(m).not.toMatch(/invalid type ''/); // proves o.type was set to the resolved item type
  });

  it("an unknown task model for a target is rejected with the allowed map", async () => {
    // c1-t8 only offers tm1..tm3 (MC / MS / Hot-Text), so tm5 is invalid there.
    const src = `target c1-t8 passage "P" type informational lines [ "A." "B." ]
      claims [ claim id "c1" status supported dimension supporting-evidence text "X." {} ]
      evidence []
      outcomes [ outcome id "q1" task-model tm5 dimension supporting-evidence focus "c1" stem "S" {} ] {}..`;
    const { errors } = await compile(src);
    expect(messages(errors)).toMatch(/task model 'tm5' is not available for target c1-t8/);
  });

  it("c1-t4 tm3 resolves to short-text (the SAME number, a DIFFERENT type than c1-t9)", async () => {
    const src = `target c1-t4 passage "P" type literary lines [ "A." "B." ]
      claims [ claim id "c1" status supported dimension character subject "Mara" text "X." {} ]
      evidence []
      outcomes [ outcome id "q1" task-model tm3 type short-text dimension character focus "c1" stem "Explain." {} ] {}..`;
    const { errors } = await compile(src);
    expect(messages(errors)).not.toMatch(/task model/i);
  });
});
