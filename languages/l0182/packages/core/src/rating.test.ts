// SPDX-License-Identifier: MIT
/**
 * The rating style: items answered on a scale.
 *
 * As in `survey.test.ts`, every failure is asserted on its message TEXT — the reader is a code
 * generator that retries against it — and the survey is served from a fixture, so a test that
 * varies the survey varies the fixture.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { compile, errorOf } from "./harness.js";
import { setSource } from "./source.js";
import { DEFAULT_RATING_INSTRUCTIONS } from "./survey.js";

/** A small course survey covering every scale form. Reset before each test. */
const COURSE = () => ({
  style: "rating",
  scales: {
    agree: { preset: "agreement-5", optOut: "Not applicable" },
    ease: { min: 1, max: 7 },
  },
  items: [
    { id: "goals", text: "The course met its goals", scale: "agree" },
    { id: "pace", text: "The pace was right", scale: "agree" },
    { id: "portal", text: "Using the portal was", scale: "ease", anchors: ["difficult", "easy"] },
    { id: "nps", text: "Would you recommend it?", scale: "nps", required: false },
  ],
  comment: { prompt: "Anything else?" },
});

let data: any;
const given = (d: any) => {
  data = d;
};

beforeEach(() => {
  given(COURSE());
  setSource(async (id) => ({ instance: `${id}-1`, data }));
});
afterAll(() => setSource());

const survey = (body = "") => `survey [ id "fixture" ${body} ]`;

/** Every required item answered, so a test can vary one thing. */
const ALL = `[item "The course met its goals" rating "Agree"]
             [item "The pace was right" rating "Disagree"]
             [item "Using the portal was" rating 6]`;
const answer = (ratings = ALL, rest = "") => survey(`response [ ratings [ ${ratings} ] ${rest} ]`);

describe("the rating survey record", () => {
  it("compiles its items with their scales resolved inline", async () => {
    const out = await compile(survey());
    expect(out.survey.style).toBe("rating");
    expect(out.survey.instructions).toBe(DEFAULT_RATING_INSTRUCTIONS);
    expect(out.survey.comment).toEqual({ prompt: "Anything else?" });
    const [goals, , portal, nps] = out.survey.items;
    expect(goals).toMatchObject({ id: "goals", required: true });
    expect(goals.scale.name).toBe("agree");
    expect(goals.scale.optOut).toBe("Not applicable");
    expect(goals.scale.points.map((p: any) => p.label)).toEqual([
      "Strongly disagree",
      "Disagree",
      "Neither agree nor disagree",
      "Agree",
      "Strongly agree",
    ]);
    expect(portal.anchors).toEqual(["difficult", "easy"]);
    expect(portal.scale.points.map((p: any) => p.value)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(nps.required).toBe(false);
    expect(nps.scale.points[0]).toEqual({ value: 0, label: "Not at all likely" });
    expect(nps.scale.points[10]).toEqual({ value: 10, label: "Extremely likely" });
  });

  it("falls back on the survey's default scale, and numbers bare-string items by position", async () => {
    given({ style: "rating", scale: "frequency-5", items: ["one", "two"] });
    const out = await compile(survey());
    expect(out.survey.items.map((x: any) => x.id)).toEqual(["q0", "q1"]);
    expect(out.survey.items[1].scale.points[4].label).toBe("Always");
  });

  it("marks a star scale for display without changing its points", async () => {
    given({ style: "rating", items: [{ text: "Overall", scale: "stars-5" }] });
    const { scale } = (await compile(survey())).survey.items[0];
    expect(scale.display).toBe("stars");
    expect(scale.points.map((p: any) => p.value)).toEqual([1, 2, 3, 4, 5]);
  });

  it("emits no response until something answers", async () => {
    expect(Object.keys(await compile(survey()))).toEqual(["survey"]);
  });
});

describe("a rating survey whose data is broken", () => {
  it("refuses data that does not declare its style", async () => {
    given({ items: ["one"] });
    const msg = await errorOf(survey());
    expect(msg).toContain("fixture-1 does not say its `style`");
    expect(msg).toContain('"style": "rating"');
  });

  it("refuses a survey with no items", async () => {
    given({ style: "rating", scale: "nps", items: [] });
    expect(await errorOf(survey())).toContain("fixture-1 holds no items");
  });

  it("refuses an item with no scale and no default", async () => {
    given({ style: "rating", items: ["one"] });
    expect(await errorOf(survey())).toContain("item 1 has no `scale`");
  });

  it("names the presets when a scale names none of them", async () => {
    given({ style: "rating", scale: "agree-5", items: ["one"] });
    const msg = await errorOf(survey());
    expect(msg).toContain('names the scale "agree-5", which is not a preset');
    expect(msg).toContain("agreement-5");
  });

  it("refuses a scale that mixes forms", async () => {
    given({ style: "rating", scale: { preset: "nps", min: 0, max: 10 }, items: ["one"] });
    expect(await errorOf(survey())).toContain("mixes `preset` and `min`");
  });

  it("refuses a scale too long to be a scale", async () => {
    given({ style: "rating", scale: { min: 0, max: 20 }, items: ["one"] });
    expect(await errorOf(survey())).toContain("21 points; a scale has at most 11");
  });

  it("refuses values that do not rise", async () => {
    given({
      style: "rating",
      scale: {
        points: [
          { value: 2, label: "b" },
          { value: 1, label: "a" },
        ],
      },
      items: ["one"],
    });
    expect(await errorOf(survey())).toContain("must rise");
  });

  it("refuses an opt-out that is also a point's label", async () => {
    given({ style: "rating", scale: { points: ["Yes", "No"], optOut: "no" }, items: ["one"] });
    expect(await errorOf(survey())).toContain("also the label of one of its points");
  });

  it("refuses anchors that are not two words", async () => {
    given({ style: "rating", scale: "nps", items: [{ text: "one", anchors: ["only"] }] });
    expect(await errorOf(survey())).toContain("Anchors are two words");
  });

  it("refuses two items asking the same thing", async () => {
    given({ style: "rating", scale: "nps", items: ["same", "same"] });
    expect(await errorOf(survey())).toContain("items 1 and 2 both");
  });
});

describe("the rating response", () => {
  it("resolves items to ids and answers to values, in the survey's order", async () => {
    const out = await compile(
      answer(`[item "Using the portal was" rating 6]
              [item "The pace was right" rating "Disagree"]
              [item "The course met its goals" rating "Agree"]`),
    );
    expect(out.response).toEqual({
      ratings: [
        { item: "goals", value: 4 },
        { item: "pace", value: 2 },
        { item: "portal", value: 6 },
      ],
    });
  });

  it("records the opt-out as an opt-out, never as a value", async () => {
    const out = await compile(
      answer(`[item "The course met its goals" rating "not applicable"]
              [item "The pace was right" rating 3]
              [item "Using the portal was" rating 1]`),
    );
    expect(out.response.ratings[0]).toEqual({ item: "goals", optOut: true });
  });

  it("takes a number as the scale's own value, never a position", async () => {
    // On a 0–10 scale, 9 is 9. Under `choices` a number is a position; here it is the answer.
    const out = await compile(answer(`${ALL} [item "Would you recommend it?" rating 9]`));
    expect(out.response.ratings[3]).toEqual({ item: "nps", value: 9 });
    const zero = await compile(answer(`${ALL} [item "Would you recommend it?" rating 0]`));
    expect(zero.response.ratings[3]).toEqual({ item: "nps", value: 0 });
  });

  it("takes an item's own end words, and a scale's end labels", async () => {
    const out = await compile(
      answer(`[item "The course met its goals" rating 4]
              [item "The pace was right" rating 4]
              [item "Using the portal was" rating "Easy"]
              [item "Would you recommend it?" rating "extremely likely"]`),
    );
    expect(out.response.ratings[2]).toEqual({ item: "portal", value: 7 });
    expect(out.response.ratings[3]).toEqual({ item: "nps", value: 10 });
  });

  it("forgives case and spacing in a label, and a number written in quotes", async () => {
    const out = await compile(
      answer(`[item "the course  met its GOALS" rating "  strongly   agree "]
              [item "The pace was right" rating "2"]
              [item "Using the portal was" rating 4]`),
    );
    expect(out.response.ratings.slice(0, 2)).toEqual([
      { item: "goals", value: 5 },
      { item: "pace", value: 2 },
    ]);
  });

  it("names an item by id or position too", async () => {
    const out = await compile(
      answer(`[item "goals" rating 5] [item 1 rating 5] [item "portal" rating 5]`),
    );
    expect(out.response.ratings.map((r: any) => r.item)).toEqual(["goals", "pace", "portal"]);
  });

  it("leaves an optional item out without complaint", async () => {
    const out = await compile(answer());
    expect(out.response.ratings.map((r: any) => r.item)).toEqual(["goals", "pace", "portal"]);
  });

  it("carries a comment where the survey asks for one", async () => {
    const out = await compile(answer(ALL, `comment "More worked examples, please."`));
    expect(out.response.comment).toBe("More worked examples, please.");
  });

  it("refuses an answer that is not on the scale, and says what the scale takes", async () => {
    const msg = await errorOf(answer(`${ALL} [item "Would you recommend it?" rating 11]`));
    expect(msg).toContain('rates "Would you recommend it?" 11, which is not on its scale');
    expect(msg).toContain("a value from 0 to 10");
    expect(msg).toContain('10 "Extremely likely"');
  });

  it("refuses a label the scale does not have, listing the ones it does", async () => {
    const msg = await errorOf(
      answer(`[item "The course met its goals" rating "Mostly agree"]
              [item "The pace was right" rating 3]
              [item "Using the portal was" rating 1]`),
    );
    expect(msg).toContain('"Mostly agree", which is not an answer on its scale');
    expect(msg).toContain('or by label: 1 "Strongly disagree"');
    expect(msg).toContain('or "Not applicable" to opt out');
  });

  it("refuses an item the survey does not hold, and lists all three ways to name one", async () => {
    const msg = await errorOf(answer(`${ALL} [item "The food was good" rating 3]`));
    expect(msg).toContain('is "The food was good", which is not an item in this survey');
    expect(msg).toContain("by its id (goals, pace, portal, nps)");
  });

  it("refuses the same item twice, whichever notation named it", async () => {
    const msg = await errorOf(answer(`${ALL} [item "goals" rating 1]`));
    expect(msg).toContain('rates "The course met its goals" twice');
  });

  it("refuses a response that leaves out a required item, naming it", async () => {
    const msg = await errorOf(answer(`[item "The course met its goals" rating 4]`));
    expect(msg).toContain("leaves out 2 required items");
    expect(msg).toContain('"The pace was right", "Using the portal was"');
    expect(msg).toContain("opt-out");
  });

  it("refuses an entry missing its rating, with the shape to write", async () => {
    const msg = await errorOf(answer(`[item "The course met its goals"]`));
    expect(msg).toContain("ratings: entry 1 has no `rating`");
    expect(msg).toContain('[item "The course met its goals" rating "Agree"]');
  });

  it("refuses a flat list where each answer needs its own brackets", async () => {
    const msg = await errorOf(survey(`response [ ratings [ item "goals" rating 4 ] ]`));
    expect(msg).toContain("each answer is its own list in brackets");
  });

  it("refuses a comment where the survey asks for none", async () => {
    given({ ...COURSE(), comment: undefined });
    const msg = await errorOf(answer(ALL, `comment "hello"`));
    expect(msg).toContain("`comment` is not asked for by this survey");
  });

  it("refuses an empty comment", async () => {
    expect(await errorOf(answer(ALL, `comment "  "`))).toContain("`comment` is empty");
  });

  it("tells a stray word inside a rating where it belongs", async () => {
    const msg = await errorOf(answer(`[item "goals" rating 4 comment "x"]`));
    expect(msg).toContain("is not an attribute of ratings");
    expect(msg).toContain("`comment` belongs inside `response`");
  });

  it("tells an item written straight on the response where it belongs", async () => {
    const msg = await errorOf(survey(`response [ item "goals" ]`));
    expect(msg).toContain("`item` belongs inside `ratings`");
  });
});

describe("answering one style with the other's words", () => {
  it("tells `choices` on a rating survey what to write instead", async () => {
    const msg = await errorOf(survey(`response [ choices ["The course met its goals"] ]`));
    expect(msg).toContain(
      "`choices` answers a ranked-choice survey, but fixture-1 is a rating survey",
    );
    expect(msg).toContain('ratings [[item "…" rating "…"]');
  });

  it("tells `ratings` on a ranked-choice survey what to write instead", async () => {
    given({ style: "ranked-choice", options: ["a", "b", "c"] });
    const msg = await errorOf(survey(`response [ ratings [[item "a" rating 1]] ]`));
    expect(msg).toContain(
      "`ratings` answers a rating survey, but fixture-1 is a ranked-choice survey",
    );
    expect(msg).toContain('choices ["…" "…"]');
  });
});
