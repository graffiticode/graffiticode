// SPDX-License-Identifier: MIT
/**
 * The projection the renderer draws from.
 *
 * There is no DOM in this suite and there should not be: `vitest.config.ts` pulls in no jsdom,
 * which is what keeps a published component's dev tree free of a rendering library. So the
 * logic that can be wrong without looking wrong lives here, where it can be tested, and the
 * component stays a projection of it.
 */
import { describe, expect, it } from "vitest";
import {
  answerText,
  boundsLabel,
  isRating,
  resolveChoices,
  resolveRatings,
  scaleEnds,
} from "./survey";
import type { RankedSurvey, RatedItem, RatingSurvey } from "./survey";

const survey = (over: Partial<RankedSurvey> = {}): RankedSurvey => ({
  id: "civic-priorities",
  instance: "civic-priorities-7",
  // The compiler guarantees this field, so the fixture carries it too — the view is a
  // projection of the compiled record and must not be typed more loosely than one.
  instructions: "Below is a list of options. Please choose the ones that matter most to you.",
  options: [
    { id: "o0", text: "clean air and water" },
    { id: "o1", text: "affordable housing" },
    { id: "o2", text: "invest in public transit" },
  ],
  minChoices: 0,
  maxChoices: 3,
  ...over,
});

describe("resolveChoices", () => {
  it("returns the chosen options in the order the response put them, not the set's order", () => {
    const { chosen } = resolveChoices(survey(), { choices: ["o2", "o0"] });
    expect(chosen.map((i) => i.id)).toEqual(["o2", "o0"]);
    expect(chosen.map((i) => i.text)).toEqual(["invest in public transit", "clean air and water"]);
  });

  it("reports which ids the selection was chosen from, for dimming them in the set", () => {
    const { chosenIds } = resolveChoices(survey(), { choices: ["o2", "o0"] });
    expect([...chosenIds].sort()).toEqual(["o0", "o2"]);
  });

  it("names an id that matches nothing rather than dropping it", () => {
    // Dropping it would render a shorter ranking than the one actually recorded — wrong in the
    // way that looks right. The compiler refuses these, so they only arrive on a record built
    // outside it.
    const { chosen, unknown } = resolveChoices(survey(), { choices: ["o0", "gone", "o1"] });
    expect(chosen.map((i) => i.id)).toEqual(["o0", "o1"]);
    expect(unknown).toEqual(["gone"]);
  });

  it("resolves against the service's own ids when the set carried them", () => {
    const s = survey({
      options: [
        { id: "a3", text: "one" },
        { id: "b7", text: "two" },
      ],
    });
    const { chosen, unknown } = resolveChoices(s, { choices: ["b7"] });
    expect(chosen).toEqual([{ id: "b7", text: "two" }]);
    expect(unknown).toEqual([]);
  });

  it("is empty for a survey nothing has answered", () => {
    const { chosen, unknown, chosenIds } = resolveChoices(survey(), undefined);
    expect(chosen).toEqual([]);
    expect(unknown).toEqual([]);
    expect(chosenIds.size).toBe(0);
  });

  it("is empty for a response that contributed an option and chose nothing", () => {
    const { chosen } = resolveChoices(survey(), { choices: [], writeIn: "ranked-choice voting" });
    expect(chosen).toEqual([]);
  });

  it("survives a survey that has not compiled", () => {
    expect(resolveChoices(undefined, { choices: ["o0"] })).toEqual({
      chosen: [],
      unknown: ["o0"],
      chosenIds: new Set(),
    });
  });
});

describe("boundsLabel", () => {
  it("states an exact count when the bounds are equal", () => {
    expect(boundsLabel(survey({ minChoices: 2, maxChoices: 2 }))).toBe("Choose 2 of 3");
  });

  it("says there is no ceiling when max-choices is the whole set", () => {
    expect(boundsLabel(survey({ minChoices: 0, maxChoices: 3 }))).toBe("Choose any of 3");
  });

  it("states a ceiling alone when there is no floor", () => {
    expect(boundsLabel(survey({ minChoices: 0, maxChoices: 2 }))).toBe("Choose up to 2 of 3");
  });

  it("states a range when both bounds bite", () => {
    expect(boundsLabel(survey({ minChoices: 1, maxChoices: 2 }))).toBe("Choose 1–2 of 3");
  });
});

const agree: RatedItem["scale"] = {
  name: "agree",
  points: [
    { value: 1, label: "Strongly disagree" },
    { value: 2, label: "Disagree" },
    { value: 3, label: "Neither agree nor disagree" },
    { value: 4, label: "Agree" },
    { value: 5, label: "Strongly agree" },
  ],
  optOut: "Not applicable",
};

const rating = (): RatingSurvey => ({
  id: "course-feedback",
  instance: "course-feedback-1",
  style: "rating",
  instructions: "Please answer each of the following on the scale beside it.",
  items: [
    { id: "goals", text: "The course met its goals", scale: agree, required: true },
    {
      id: "portal",
      text: "Using the portal was",
      scale: { points: [1, 2, 3, 4, 5, 6, 7].map((value) => ({ value })) },
      required: true,
      anchors: ["difficult", "easy"],
    },
    {
      id: "nps",
      text: "Would you recommend it?",
      scale: {
        name: "nps",
        points: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => ({
          value,
          ...(value === 0 ? { label: "Not at all likely" } : {}),
          ...(value === 10 ? { label: "Extremely likely" } : {}),
        })),
      },
      required: false,
    },
  ],
});

describe("isRating", () => {
  it("tells the two styles apart, treating a record with no style as ranked choice", () => {
    expect(isRating(rating())).toBe(true);
    expect(isRating(survey())).toBe(false);
  });
});

describe("resolveRatings", () => {
  it("lines answers up with every item, in the survey's order, leaving gaps unanswered", () => {
    const { rows, answered } = resolveRatings(rating(), {
      ratings: [
        { item: "nps", value: 9 },
        { item: "goals", optOut: true },
      ],
    });
    expect(rows.map((r) => r.item.id)).toEqual(["goals", "portal", "nps"]);
    expect(rows.map((r) => r.answer)).toEqual([
      { item: "goals", optOut: true },
      undefined,
      { item: "nps", value: 9 },
    ]);
    expect(answered).toBe(2);
  });

  it("shows every item unanswered when there is no response", () => {
    const { rows, answered } = resolveRatings(rating(), undefined);
    expect(rows.every((r) => !r.answer)).toBe(true);
    expect(answered).toBe(0);
  });

  it("names a rating it cannot place rather than dropping it", () => {
    // The compiler refuses all three, so they only arrive on a record assembled outside it.
    const { unknown, answered } = resolveRatings(rating(), {
      ratings: [
        { item: "gone", value: 3 },
        { item: "portal", value: 12 },
        { item: "nps", optOut: true },
      ],
    });
    expect(unknown).toHaveLength(3);
    expect(answered).toBe(0);
  });
});

describe("scaleEnds", () => {
  it("prefers the item's own anchors — a semantic differential", () => {
    expect(scaleEnds(rating().items[1])).toEqual(["difficult", "easy"]);
  });

  it("falls back on the scale's end labels", () => {
    expect(scaleEnds(rating().items[2])).toEqual(["Not at all likely", "Extremely likely"]);
    expect(scaleEnds(rating().items[0])).toEqual(["Strongly disagree", "Strongly agree"]);
  });
});

describe("answerText", () => {
  it("reads an answer as its label, its value, or the opt-out's words", () => {
    const [goals, portal] = rating().items;
    expect(answerText(goals, { item: "goals", value: 4 })).toBe("Agree");
    expect(answerText(portal, { item: "portal", value: 6 })).toBe("6");
    expect(answerText(goals, { item: "goals", optOut: true })).toBe("Not applicable");
  });
});
