// SPDX-License-Identifier: MIT
/**
 * The activity level: several items delivered together.
 *
 * Back-ported from L0182. What it adds over `item` is the level ABOVE it — `item` groups
 * interactions over one stimulus and scores them together, an activity groups several of those,
 * scored independently, which is what a quiz actually is.
 */
import { test, describe, expect } from "vitest";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "./index.js";
import { scoreActivity } from "../../view/src/scoring/score.js";

/** Distinct from a thrown assertion, so `errorOf` can tell "the parser refused it" from "the harness did". */
class ParseError extends Error {}

async function compile(src: string): Promise<any> {
  const code: any = await parser.parse(180, src.trim().endsWith("..") ? src : `${src}..`, lexicon);
  const perr: any = Object.values(code).find((n: any) => n && n.tag === "ERROR");
  if (perr) throw new ParseError(`parse error: ${JSON.stringify(perr.elts)}`);
  return await new Promise((resolve, reject) =>
    compiler.compile(code, {}, {}, (e: any, v: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) reject(errs);
      else resolve(v);
    }),
  );
}

async function errorOf(src: string): Promise<string> {
  try {
    const val = await compile(src);
    throw new Error(`expected a compile error, got ${JSON.stringify(val)}`);
  } catch (e: any) {
    if (e instanceof ParseError) return e.message;
    if (e instanceof Error) throw e;
    const first = Array.isArray(e) ? e[0] : e;
    return String(first?.message ?? first);
  }
}

const Q = (stem: string) => `choice [ prompt "${stem}" options [ [text "no"] [text "yes" assess [correct]] ] {} ]`;

describe("an activity", () => {
  test("is a list of items, numbered by position", async () => {
    const { activity } = await compile(`items [ ${Q("One?")} ${Q("Two?")} ${Q("Three?")} ] {}`);
    expect(activity.items.map((i: any) => i.id)).toEqual([0, 1, 2]);
    expect(activity.items.map((i: any) => i.interaction.prompt)).toEqual(["One?", "Two?", "Three?"]);
  });

  test("keeps each item's interaction and validation apart, one level up", async () => {
    // The central commitment survives the new level: a graded delivery withholds the key per
    // item, so an activity must not merge them into one blob.
    const { activity } = await compile(`items [ ${Q("One?")} ] {}`);
    expect(activity.items[0].interaction).toBeDefined();
    expect(activity.items[0].validation.points).toBe(1);
    expect(JSON.stringify(activity.items[0].interaction)).not.toContain("correct");
  });

  test("takes a bare interaction and an `item` wrapper side by side", async () => {
    const src = `items [
      ${Q("Bare?")}
      item [ stimulus [ title "T" paragraphs ["p"] ] parts [ ${Q("Wrapped?")} ] {} ]
    ] {}`;
    const { activity } = await compile(src);
    expect(activity.items.map((i: any) => i.interaction.type)).toEqual(["choice", "item"]);
    expect(activity.items[1].interaction.stimulus.title).toBe("T");
  });

  test("defaults to what L0180's delivery already does", async () => {
    // Every item on one screen, nothing sent until the end. A default contradicting the renderer
    // would be a statement the language cannot keep.
    const { activity } = await compile(`items [ ${Q("One?")} ] {}`);
    expect(activity.navigation).toBe("nonlinear");
    expect(activity.submission).toBe("simultaneous");
  });

  test("carries QTI's delivery modes when they are authored", async () => {
    const { activity } = await compile(
      `items [ ${Q("One?")} ] navigation "linear" submission "individual" {}`,
    );
    expect(activity).toMatchObject({ navigation: "linear", submission: "individual" });
  });
});

describe("the activity's settings", () => {
  test("take a closed set of navigation modes", async () => {
    const msg = await errorOf(`items [ ${Q("One?")} ] navigation "backwards" {}`);
    expect(msg).toContain('navigation: "backwards" is not a navigation mode');
    expect(msg).toContain("linear, nonlinear");
  });

  test("take a closed set of submission modes", async () => {
    expect(await errorOf(`items [ ${Q("One?")} ] submission "later" {}`)).toContain(
      "It takes: individual, simultaneous",
    );
  });

  test("are refused twice over", async () => {
    expect(await errorOf(`items [ ${Q("One?")} ] navigation "linear" navigation "nonlinear" {}`)).toContain(
      "navigation: is given twice",
    );
  });

  test("must end in a record", async () => {
    expect(await errorOf(`items [ ${Q("One?")} ] navigation "linear" "oops"`)).toContain(
      "the activity's settings must end in a record",
    );
  });
});

describe("what an activity refuses", () => {
  test("an empty list", async () => {
    expect(await errorOf(`items [] {}`)).toContain("an activity needs at least one item");
  });

  test("an entry that is not an item", async () => {
    expect(await errorOf(`items [ "hello" ] {}`)).toContain("items: entry 1 is not an item");
  });

  test("a missing settings record — and the parser, not the builder, is what says so", async () => {
    // Pinned because it decides where the good message can live: an arity-2 word with nothing
    // after it is a PARSE error, so `items [ … ]` never reaches the Transformer and the
    // "ending in a record" hint below can only fire when something non-record IS written.
    expect(await errorOf(`items [ ${Q("One?")} ]`)).toContain("parse error");
  });

  test("a hottext that never found its stimulus", async () => {
    // `within "stimulus"` emits a `pending` that only `item` can complete. PROG catches one that
    // survives to the top; the activity has to catch one that survives into a member.
    const msg = await errorOf(`items [ hottext [ prompt "Click one." within "stimulus" selections [ [quote "a"] ] {} ] ] {}`);
    expect(msg).toContain('`within "stimulus"` needs the hottext to be a part of an item');
  });
});

describe("misplaced activity settings", () => {
  test("are told they go after the list, not inside an item", async () => {
    const msg = await errorOf(
      `items [ choice [ navigation "linear" prompt "One?" options [ [text "yes" assess [correct]] ] {} ] ] {}`,
    );
    expect(msg).toContain("choice: `navigation` is not an attribute of choice");
    expect(msg).toContain("configures the whole activity, so it goes after the items list");
  });
});

describe("an activity scores item by item", () => {
  // The scorer is imported across the workspace by relative path, as `conformance.test.ts`
  // does — `score.ts` has no imports at all, which is what makes that safe.
  const QUIZ = `items [
    ${Q("One?")}
    ${Q("Two?")}
    ${Q("Three?")}
  ] {}`;

  const key = async (src = QUIZ) => {
    const { activity } = await compile(src);
    return activity;
  };

  test("sums what each item earned", async () => {
    const activity = await key();
    const s = scoreActivity({ activity, response: { "0": ["B"], "1": ["B"], "2": ["A"] } });
    expect(s).toMatchObject({ points: 2, maxPoints: 3, correct: false });
  });

  test("is correct only when every item is", async () => {
    const activity = await key();
    const all = scoreActivity({ activity, response: { "0": ["B"], "1": ["B"], "2": ["B"] } });
    expect(all).toMatchObject({ points: 3, maxPoints: 3, correct: true });
  });

  test("counts an unanswered item as zero rather than skipping it", async () => {
    // The alternative — scoring only what was answered — would report 1/1 on a three-item quiz
    // where two were left blank, which reads as a perfect score.
    const activity = await key();
    const s = scoreActivity({ activity, response: { "0": ["B"] } });
    expect(s).toMatchObject({ points: 1, maxPoints: 3, correct: false });
  });

  test("keeps one item's penalty out of another's total", async () => {
    // `Score.points` is floored per item, so a -1 distractor cannot reach across and subtract
    // from the item beside it. `rawPoints` at this level is the sum of the FLOORED item scores.
    const src = `items [
      choice [ prompt "Costly?" options [ [text "no" assess [correct]] [text "yes" assess [points -5]] ] {} ]
      ${Q("Two?")}
    ] {}`;
    const activity = await key(src);
    const s = scoreActivity({ activity, response: { "0": ["B"], "1": ["B"] } });
    expect(s).toMatchObject({ points: 1, rawPoints: 1, maxPoints: 2 });
  });

  test("stays pending while a written answer is unmarked", async () => {
    const src = `items [
      ${Q("One?")}
      extended-text [ prompt "Explain." rubric [ [points 2 descriptor "Full"] [points 0 descriptor "None"] ] {} ]
    ] {}`;
    const activity = await key(src);
    const s = scoreActivity({ activity, response: { "0": ["B"], "1": "Because." } });
    expect(s.pending).toBe(true);
    expect(s.correct).toBe(false);
    expect(s.points).toBe(1);
  });

  test("scores a multi-part member through the item level below it", async () => {
    const src = `items [
      item [
        scoring "conjunctive"
        parts [ ${Q("A?")} ${Q("B?")} ] {}
      ]
    ] {}`;
    const activity = await key(src);
    // Conjunctive: the right first part with the wrong second earns nothing, and the activity
    // reports what the item said rather than re-deriving it.
    const half = scoreActivity({ activity, response: { "0": { "1": ["B"], "2": ["A"] } } });
    expect(half.points).toBe(0);
    const whole = scoreActivity({ activity, response: { "0": { "1": ["B"], "2": ["B"] } } });
    expect(whole).toMatchObject({ points: 1, correct: true });
  });
});

describe("several questions written without `items`", () => {
  // Both shapes used to compile clean: the bracketed one to an array no renderer reads, the bare
  // one to its last question alone. A generator asked for a five-question quiz wrote the first.
  test("in a list, are told to become an activity", async () => {
    const msg = await errorOf(`[ ${Q("One?")} ${Q("Two?")} ${Q("Three?")} ]`);
    expect(msg).toContain("3 questions side by side");
    expect(msg).toContain("items [ … ] {}");
  });

  test("side by side, are refused rather than keeping only the last", async () => {
    const msg = await errorOf(`${Q("One?")} ${Q("Two?")}`);
    expect(msg).toContain("2 questions side by side");
    expect(msg).toContain("items [ … ] {}");
  });

  test("do not catch a single question or an activity", async () => {
    await expect(compile(Q("One?"))).resolves.toHaveProperty("interaction");
    await expect(compile(`items [ ${Q("One?")} ${Q("Two?")} ] {}`)).resolves.toHaveProperty("activity");
  });
});
