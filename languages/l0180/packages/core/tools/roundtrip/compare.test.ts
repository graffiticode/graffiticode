// SPDX-License-Identifier: MIT
/**
 * The round-trip harness, gated offline.
 *
 * `conformance.test.ts` compiles programs a person wrote for shapes a person chose. This runs
 * the same question over REAL L0175 items — five of them, compiled by L0175's own compiler and
 * committed as fixtures — and checks two things at once: that a faithful L0180 program scores
 * every L0175 type identically, and that the harness NOTICES when one does not.
 *
 * The second half is what makes the first half worth anything. A comparison that cannot fail is
 * not a comparison, and the three ways a hand-off actually goes wrong — additive scoring where
 * L0175 is all-or-nothing, per-option credit on an exact-set part, and an option quietly
 * dropped — are each provoked here and each expected to be caught.
 *
 * The fixtures are checked in so this needs neither the sibling repo nor a network. Regenerate
 * them with `npx tsx packages/core/tools/roundtrip/run.ts fixtures` when L0175's output changes.
 */
import { test, describe, expect } from "vitest";
import { EXAMPLES, compileL0180, loadFixture } from "./examples.js";
import { readSourceItem } from "./source.js";
import { compare, battery, readTarget } from "./compare.js";
import { port } from "./port.js";

const fixture = loadFixture;

describe("the fixtures are the five L0175 delivered shapes", () => {
  test("every type in L0175's SCORING map has an example", () => {
    const types = EXAMPLES.map((n) => readSourceItem(fixture(n)).type).sort();
    expect(types).toEqual(
      ["ebsr", "hot-text", "multi-select", "multiple-choice", "short-text"].sort(),
    );
  });

  test("each one carries a key, so a comparison has something to compare", () => {
    for (const name of EXAMPLES) {
      const src = readSourceItem(fixture(name));
      if (src.handScored) {
        expect(src.points, name).toBeGreaterThan(0);
        continue;
      }
      for (const p of src.parts) {
        expect(p.options.length, `${name} part ${p.label}`).toBeGreaterThan(1);
        expect(p.options.filter((o) => o.correct).length, `${name} part ${p.label}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("a faithful port scores the way L0175 says", () => {
  for (const name of EXAMPLES) {
    test(`${name} round-trips`, async () => {
      const compiled = fixture(name);
      const src = readSourceItem(compiled);
      const program = port(src, compiled);
      const report = compare(src, await compileL0180(program));
      expect(report.problems, `${name}: ${report.problems.join("; ")}`).toEqual([]);
      const failed = report.cases.filter((c) => !c.ok);
      expect(
        failed.map((c) => `${c.name}: expected ${c.expected.points}, got ${c.actual.points}`),
      ).toEqual([]);
      expect(report.aligned.matched).toBe(report.aligned.total);
      expect(report.ok).toBe(true);
    });
  }
});

describe("the battery is mostly near-misses, because that is where the models differ", () => {
  test("an exact-set part is probed with a subset and a superset", () => {
    const src = readSourceItem(fixture("c1-t9-tm2-multiselect"));
    const names = battery(src).map((c) => c.name);
    expect(names.some((n) => n.startsWith("all but one"))).toBe(true);
    expect(names.some((n) => n.startsWith("the key plus a distractor"))).toBe(true);
  });

  test("a two-part item is probed with each part answered alone", () => {
    const src = readSourceItem(fixture("c1-t4-tm1-ebsr"));
    const names = battery(src).map((c) => c.name);
    expect(names).toContain("only part A answered");
    expect(names).toContain("only part B answered");
  });

  test("a written response is probed once, and expects pending rather than zero", () => {
    const src = readSourceItem(fixture("c1-t9-tm5-shorttext"));
    const cases = battery(src);
    expect(cases).toHaveLength(1);
    expect(cases[0].expected).toMatchObject({ pending: true, correct: false });
  });
});

describe("the harness catches the ways a hand-off goes wrong", () => {
  const ebsr = () => {
    const compiled = fixture("c1-t4-tm1-ebsr");
    return { compiled, src: readSourceItem(compiled) };
  };

  test("an EBSR delivered additively is caught — it is out of 2 and pays for half", async () => {
    const { compiled, src } = ebsr();
    const additive = port(src, compiled)
      .replace(/\n\s*scoring "conjunctive"/, "")
      .replace(/\n\s*points 1/, "");
    const report = compare(src, await compileL0180(additive));
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toContain("worth 2 point(s); L0175 says 1");
    // The failure that matters is not the ceiling but the credit: a right claim with the wrong
    // evidence earns a point here and nothing in L0175.
    const half = report.cases.find((c) => c.name === "only part A answered");
    expect(half?.ok).toBe(false);
    expect(half?.actual.points).toBe(1);
  });

  test("per-option credit on an exact-set part is caught", async () => {
    const compiled = fixture("c1-t9-tm2-multiselect");
    const src = readSourceItem(compiled);
    const perOption = port(src, compiled).replace(/\n\s*response-processing "match-correct"/, "");
    const report = compare(src, await compileL0180(perOption));
    expect(report.ok).toBe(false);
    const subset = report.cases.find((c) => c.name.startsWith("all but one"));
    expect(subset?.ok).toBe(false);
    expect(subset?.actual.points).toBe(1);
  });

  test("a dropped option is caught as content loss, not as a passing comparison", async () => {
    const compiled = fixture("c1-t8-tm1-multiplechoice");
    const src = readSourceItem(compiled);
    const dropped = port(src, compiled).split("\n").filter((l) => !/Tall stone arches/.test(l)).join("\n");
    const report = compare(src, await compileL0180(dropped));
    expect(report.ok).toBe(false);
    expect(report.aligned.matched).toBe(report.aligned.total - 1);
    expect(report.problems.join(" ")).toContain("no delivered option reads like");
  });

  test("a dropped passage is caught, even though every response still scores right", async () => {
    const compiled = fixture("c1-t8-tm1-multiplechoice");
    const src = readSourceItem(compiled);
    // The options and the key are untouched; only the passage the question is about is gone.
    const noPassage = port(src, compiled).replace(/ {2}stimulus \[[\s\S]*?\n {2}\]\n/, "");
    const report = compare(src, await compileL0180(noPassage));
    expect(report.cases.every((c) => c.ok), "scoring is unaffected").toBe(true);
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toContain("the passage lost 8 of 8 lines");
  });

  test("a short-text delivered as an auto-scored blank is caught", async () => {
    const compiled = fixture("c1-t9-tm5-shorttext");
    const src = readSourceItem(compiled);
    const asBlank = `
      item [
        parts [
          text-entry [
            prompt ${JSON.stringify(src.stems[0])}
            text "The narrator changes because {{b1}}."
            blanks [ [ id "b1" responses [ [ response "she notices something" assess [ correct ] ] ] {} ] ] {}
          ]
        ] {}
      ]..`;
    const report = compare(src, await compileL0180(asBlank));
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toContain("hand-scored");
  });
});

describe("reading the delivered item", () => {
  test("a bare interaction is one unkeyed part; an item's parts are keyed", async () => {
    const bare = await compileL0180(`choice [ options [ [ text "a" assess [ correct ] ] ] {} ]`);
    expect(readTarget(bare).parts).toMatchObject([{ key: null, type: "choice" }]);
    const item = await compileL0180(
      `item [ parts [ choice [ options [ [ text "a" assess [ correct ] ] ] {} ] ] {} ]`,
    );
    expect(readTarget(item)).toMatchObject({ isItem: true, parts: [{ key: "1" }] });
  });

  test("a hottext's options are its selectable units, not every unit", async () => {
    const item = await compileL0180(`
      hottext [
        text "The aqueduct carried water across the valley."
        granularity "word"
        selections [ [ quote "aqueduct" assess [ correct ] ] ] {}
      ]`);
    const [part] = readTarget(item).parts;
    expect(part.type).toBe("hottext");
    expect(part.options.length).toBeGreaterThan(0);
    expect(part.options.every((o) => o.text)).toBe(true);
  });
});
