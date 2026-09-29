// SPDX-License-Identifier: MIT
/**
 * The survey record and the response to it.
 *
 * Every assertion about a failure asserts on the message TEXT, not merely that compilation
 * failed. The reader of these messages is a code-generating model that will retry against
 * them, so a message that stops naming the fix is a regression even when the program still
 * errors.
 *
 * The survey's data is served from a fixture rather than from `data/`, because what is under
 * test here is the assembly and the rules — `source.test.ts` is where the lookup itself is
 * tested. A program can no longer write a set of options at all, so a test that varies the set
 * varies the fixture instead.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { compile, errorOf } from "./harness.js";
import { setSource } from "./source.js";
import { DEFAULT_INSTRUCTIONS } from "./survey.js";

const THREE = ["protect voting rights", "universal healthcare system", "affordable housing"];

/** What the fixture survey holds. Reset before each test; `given` changes it. */
let data: any;

/** Install this survey's data: a bare list of options, or the whole envelope. */
const given = (d: any) => {
  data = Array.isArray(d)
    ? { style: "ranked-choice", options: d }
    : { style: "ranked-choice", ...d };
};

beforeEach(() => {
  given(THREE);
  setSource(async (id) => ({ instance: `${id}-1`, data }));
});
afterAll(() => setSource());

/** A program taking the fixture survey. */
const survey = (body = "") => `survey [ id "fixture" ${body} ]`;

describe("the survey record", () => {
  it("compiles the options of the survey it names, numbering them by position", async () => {
    const out = await compile(survey());
    expect(out).toEqual({
      survey: {
        id: "fixture",
        instance: "fixture-1",
        style: "ranked-choice",
        // Always present — see "instructions are guaranteed, not optional".
        instructions: DEFAULT_INSTRUCTIONS,
        options: [
          { id: "o0", text: "protect voting rights" },
          { id: "o1", text: "universal healthcare system" },
          { id: "o2", text: "affordable housing" },
        ],
        minChoices: 1,
        maxChoices: 2,
      },
    });
  });

  it("records the session that took it", async () => {
    const out = await compile(`survey [ id "fixture" session-id get-val-public "itemId" ]`, {
      itemId: "7gMeEzUYkHqm3PDRrI8i",
    });
    expect(out.survey.sessionId).toBe("7gMeEzUYkHqm3PDRrI8i");
  });

  it("carries the survey's title", async () => {
    given({ title: "Civic Priorities", options: THREE });
    expect((await compile(survey())).survey.title).toBe("Civic Priorities");
  });

  it("emits no response until something answers", async () => {
    const out = await compile(survey());
    expect(out.response).toBeUndefined();
    expect(Object.keys(out)).toEqual(["survey"]);
  });

  it("keeps an option's own id, so a selection means something to the service it came from", async () => {
    given([
      { id: "a3", text: "clean air and water" },
      { id: "b7", text: "affordable housing" },
    ]);
    expect((await compile(survey())).survey.options).toEqual([
      { id: "a3", text: "clean air and water" },
      { id: "b7", text: "affordable housing" },
    ]);
  });

  it("mixes bare strings and records in one set", async () => {
    given(["clean air and water", { id: "b7", text: "affordable housing" }]);
    expect((await compile(survey())).survey.options).toEqual([
      { id: "o0", text: "clean air and water" },
      { id: "b7", text: "affordable housing" },
    ]);
  });
});

describe("a survey whose data is broken", () => {
  // None of these can be caused or fixed by the program, so every message names the file rather
  // than telling whoever wrote `id "…"` to fix something that is not theirs.
  it("refuses a survey holding no options", async () => {
    given({ options: [] });
    expect(await errorOf(survey())).toContain("fixture-1 holds no options");
  });

  it("refuses a set of one, because there is nothing to choose between", async () => {
    given(["only this"]);
    const msg = await errorOf(survey());
    expect(msg).toContain("fixture-1 has only one option");
    expect(msg).toContain("at least two");
  });

  it("refuses a duplicated option, naming both positions", async () => {
    given(["same", "other", "same"]);
    const msg = await errorOf(survey());
    expect(msg).toContain("options 1 and 3");
    expect(msg).toContain("splits the choice");
  });

  it("refuses two options sharing an id, because a selection naming it is ambiguous", async () => {
    given([
      { id: "x", text: "one" },
      { id: "x", text: "two" },
    ]);
    const msg = await errorOf(survey());
    expect(msg).toContain("sharing the id");
    expect(msg).toContain("ambiguous");
  });

  it("names the entry that is not an option at all", async () => {
    given(["fine", 7]);
    expect(await errorOf(survey())).toContain("fixture-1, option 2 is 7");
  });

  it("requires text on a record option", async () => {
    given(["fine", { id: "x" }]);
    expect(await errorOf(survey())).toContain("option 2 has no `text`");
  });
});

describe("the bounds a response must satisfy", () => {
  it("defaults to choosing 1 to 5", async () => {
    given(["a", "b", "c", "d", "e", "f", "g"]);
    const out = await compile(survey());
    expect(out.survey.minChoices).toBe(1);
    expect(out.survey.maxChoices).toBe(5);
  });

  it("never lets the DEFAULT ceiling reach the whole set", async () => {
    // Choosing everything is not choosing. The survey said nothing either, so this has to
    // compile rather than fail on a number nobody wrote.
    expect((await compile(survey())).survey.maxChoices).toBe(2);
    given(["a", "b"]);
    expect((await compile(survey())).survey.maxChoices).toBe(1);
  });

  it("lets a STATED ceiling take the whole set, because that is a claim not a default", async () => {
    given({ options: THREE, maxChoices: 3 });
    expect((await compile(survey())).survey.maxChoices).toBe(3);
  });

  it("refuses a ceiling larger than the set, and says why it cannot be met", async () => {
    given({ options: THREE, maxChoices: 9 });
    const msg = await errorOf(survey());
    expect(msg).toContain("fixture-1 allows 9 choices but holds 3 options");
    expect(msg).toContain("never enough options");
  });

  it("refuses a floor above the ceiling", async () => {
    given({ options: THREE, minChoices: 3, maxChoices: 2 });
    const msg = await errorOf(survey());
    expect(msg).toContain("at least 3 and at most 2");
    expect(msg).toContain("no selection can satisfy both");
  });

  it("refuses a fractional bound", async () => {
    given({ options: THREE, maxChoices: 1.5 });
    expect(await errorOf(survey())).toContain("whole number");
  });
});

describe("the response", () => {
  it("lifts out of the survey's list to the top level of the record", async () => {
    const out = await compile(survey(`response [ choices ["o2" "o0"] ]`));
    expect(out.response).toEqual({ choices: ["o2", "o0"] });
    expect(out.survey.response).toBeUndefined();
  });

  it("keeps the selection in the order written, because the order is the ranking", async () => {
    given({ options: THREE, maxChoices: 3 });
    const out = await compile(survey(`response [ choices ["o2" "o0" "o1"] ]`));
    expect(out.response.choices).toEqual(["o2", "o0", "o1"]);
  });

  it("carries one new option alongside the selection", async () => {
    const out = await compile(
      survey(`response [ choices ["o0"] write-in "ranked-choice voting" ]`),
    );
    expect(out.response).toEqual({ choices: ["o0"], writeIn: "ranked-choice voting" });
  });

  it("allows a contributed option with nothing selected, when the floor is lowered", async () => {
    // The floor defaults to 1, so contributing without choosing is something a survey has to
    // permit rather than the other way round.
    given({ options: THREE, minChoices: 0 });
    const out = await compile(survey(`response [ write-in "ranked-choice voting" ]`));
    expect(out.response).toEqual({ choices: [], writeIn: "ranked-choice voting" });
  });

  it("refuses a response that chooses nothing under the default floor", async () => {
    expect(await errorOf(survey(`response [ write-in "ranked-choice voting" ]`))).toContain(
      "`minChoices` is 1",
    );
  });

  it("refuses a name that matches nothing, and lists all three ways to name an option", async () => {
    const msg = await errorOf(survey(`response [ choices ["o9"] ]`));
    expect(msg).toContain('entry 1 is "o9"');
    expect(msg).toContain("not an option in this survey");
    expect(msg).toContain("by its exact text");
    expect(msg).toContain("by its id (o0, o1, o2)");
    expect(msg).toContain("position counting from 0");
  });

  it("refuses the same id twice", async () => {
    const msg = await errorOf(survey(`response [ choices ["o0" "o0"] ]`));
    expect(msg).toContain('names "o0" twice');
    expect(msg).toContain("one place in the order");
  });

  it("refuses a selection under the survey's floor", async () => {
    given({ options: THREE, minChoices: 2 });
    const msg = await errorOf(survey(`response [ choices ["o0"] ]`));
    expect(msg).toContain("`minChoices` is 2");
    expect(msg).toContain("Choose more options");
  });

  it("refuses a selection over the survey's ceiling", async () => {
    given({ options: THREE, maxChoices: 1 });
    const msg = await errorOf(survey(`response [ choices ["o0" "o1"] ]`));
    expect(msg).toContain("`maxChoices` is 1");
    expect(msg).toContain("Choose fewer options");
  });

  it("refuses a new option that is already in the set, and points at the existing one", async () => {
    given({ options: THREE, minChoices: 0 });
    const msg = await errorOf(survey(`response [ write-in "affordable housing" ]`));
    expect(msg).toContain('repeats "affordable housing"');
    expect(msg).toContain("choose the existing one instead");
  });

  it("catches a repeat that differs only in case", async () => {
    given({ options: THREE, minChoices: 0 });
    expect(await errorOf(survey(`response [ write-in "Affordable Housing" ]`))).toContain(
      "repeats",
    );
  });

  it("refuses an empty response", async () => {
    expect(await errorOf(survey(`response [] `))).toContain("response: is empty");
  });

  it("refuses an empty new option rather than storing a blank one", async () => {
    expect(await errorOf(survey(`response [ choices ["o0"] write-in "  " ]`))).toContain(
      "`write-in` is empty",
    );
  });
});

describe("selecting by text", () => {
  // The only notation available to whoever answers: the set lives in the survey's data, so a
  // person or a generator writing the response has never seen an id or a position. Without this
  // the generator guesses, and a guess that lands in range compiles clean and records the wrong
  // options — which is exactly what shipped before this existed.
  it("resolves an option's text to its id", async () => {
    const out = await compile(
      survey(`response [ choices ["affordable housing" "protect voting rights"] ]`),
    );
    expect(out.response.choices).toEqual(["o2", "o0"]);
  });

  it("is forgiving about case and surrounding space, but not about the words", async () => {
    const out = await compile(survey(`response [ choices ["  Affordable Housing "] ]`));
    expect(out.response.choices).toEqual(["o2"]);
    expect(await errorOf(survey(`response [ choices ["affordable house"] ]`))).toContain(
      "not an option in this survey",
    );
  });

  it("collapses runs of whitespace, so a reflowed line still matches", async () => {
    const out = await compile(survey(`response [ choices ["universal    healthcare\n  system"] ]`));
    expect(out.response.choices).toEqual(["o1"]);
  });

  it("mixes text with ids and positions in one selection", async () => {
    given({
      options: [
        { id: "a3", text: "one" },
        { id: "b7", text: "two" },
        { id: "c1", text: "three" },
      ],
      maxChoices: 3,
    });
    const out = await compile(survey(`response [ choices ["three" "a3" 1] ]`));
    expect(out.response.choices).toEqual(["c1", "a3", "b7"]);
  });

  it("prefers an id over text when a string could be read as either", async () => {
    // An id is the canonical key. A set whose id reads as another option's text has bigger
    // problems, but the rule has to be stated somewhere, so it is stated here.
    given([
      { id: "housing", text: "transit" },
      { id: "b7", text: "housing" },
    ]);
    const out = await compile(survey(`response [ choices ["housing"] ]`));
    expect(out.response.choices).toEqual(["housing"]);
  });

  it("catches the same option named once by text and once by id", async () => {
    const msg = await errorOf(survey(`response [ choices ["affordable housing" "o2"] ]`));
    expect(msg).toContain('names "o2" twice');
  });

  it("refuses text that two options share once case is folded", async () => {
    given([
      { id: "a3", text: "Housing" },
      { id: "b7", text: "housing" },
    ]);
    const msg = await errorOf(survey(`response [ choices ["housing"] ]`));
    expect(msg).toContain("the text of more than one option");
    expect(msg).toContain("Name the option's id instead");
  });
});

describe("selecting by position", () => {
  // The language derives `o0`, `o1`, … for a set that carried no ids, so writing "o2" to mean
  // the third option is ceremony over a number it invented itself. Positions are 0-based for
  // exactly that reason — they ARE the number in the derived id.
  it("resolves positions to the ids the set was given", async () => {
    const out = await compile(survey(`response [ choices [2 0] ]`));
    expect(out.response.choices).toEqual(["o2", "o0"]);
  });

  it("keeps the compiled record on ids, so the input form changes nothing downstream", async () => {
    const byPosition = await compile(survey(`response [ choices [2 0] ]`));
    const byId = await compile(survey(`response [ choices ["o2" "o0"] ]`));
    expect(byPosition).toEqual(byId);
  });

  it("accepts position 0, which is the first option and not a missing one", async () => {
    expect((await compile(survey(`response [ choices [0] ]`))).response.choices).toEqual(["o0"]);
  });

  it("allows the two notations side by side", async () => {
    const out = await compile(survey(`response [ choices [2 "o1"] ]`));
    expect(out.response.choices).toEqual(["o2", "o1"]);
  });

  it("catches the same option named once by id and once by position", async () => {
    expect(await errorOf(survey(`response [ choices ["o0" 0] ]`))).toContain('names "o0" twice');
  });

  it("refuses a position past the end, and says where counting starts", async () => {
    const msg = await errorOf(survey(`response [ choices [3] ]`));
    expect(msg).toContain("the position 3, but this survey has 3 options");
    expect(msg).toContain("Positions count from 0, so the last one is 2");
  });

  it("refuses a negative position", async () => {
    expect(await errorOf(survey(`response [ choices [-1] ]`))).toContain("the position -1");
  });

  it("resolves a position against a set that carries the service's own ids", async () => {
    given([
      { id: "a3", text: "one" },
      { id: "b7", text: "two" },
    ]);
    expect((await compile(survey(`response [ choices [1] ]`))).response.choices).toEqual(["b7"]);
  });

  it("resolves a position against a set where only some options carry ids", async () => {
    given({ options: [{ id: "a3", text: "one" }, "two"], maxChoices: 2 });
    const out = await compile(survey(`response [ choices [1 0] ]`));
    expect(out.response.choices).toEqual(["o1", "a3"]);
  });

  it("tells a numeric id apart from a position by its notation", async () => {
    // The one case where the two could collide: ids that look like numbers. A string is always an
    // id and a number is always a position, so `["1"]` and `[1]` name different options here.
    given([
      { id: "1", text: "one" },
      { id: "2", text: "two" },
    ]);
    expect((await compile(survey(`response [ choices ["1"] ]`))).response.choices).toEqual(["1"]);
    expect((await compile(survey(`response [ choices [1] ]`))).response.choices).toEqual(["2"]);
  });

  it("refuses a fractional position", async () => {
    const msg = await errorOf(survey(`response [ choices [1.5] ]`));
    expect(msg).toContain("must be an option's id");
    expect(msg).toContain("its position as a whole number");
  });

  it("refuses an entry that is neither an id nor a position", async () => {
    expect(await errorOf(survey(`response [ choices [true] ]`))).toContain("entry 1 is true");
  });
});

describe("misplaced words", () => {
  it("tells a selection written on the survey where it belongs", async () => {
    const msg = await errorOf(survey(`choices ["o0"]`));
    expect(msg).toContain("is not an attribute of survey");
    expect(msg).toContain("`choices` belongs inside `response`");
  });

  it("tells a contributed option written on the survey where it belongs", async () => {
    const msg = await errorOf(survey(`write-in "something new"`));
    expect(msg).toContain("is not an attribute of survey");
    expect(msg).toContain("`write-in` belongs inside `response`");
  });

  it("tells an id written inside the response where it belongs", async () => {
    const msg = await errorOf(survey(`response [ choices ["o0"] id "other" ]`));
    expect(msg).toContain("is not an attribute of response");
    expect(msg).toContain("`id` belongs inside `survey`");
  });

  it("refuses the same attribute twice", async () => {
    expect(await errorOf(`survey [ id "fixture" id "other" ]`)).toContain("`id` is given twice");
  });

  it("names the expected type when a value is the wrong one", async () => {
    expect(await errorOf(`survey [ id 7 ]`)).toContain('id: expected a string in "quotes", got 7');
  });
});

describe("instructions are guaranteed, not optional", () => {
  // The compiler's one promise about the words a participant reads: a survey that reached the
  // output has instructions. Whether they are good is the survey's problem; whether they EXIST
  // is the compiler's, because a page with no explanation is the failure this prevents.
  it("substitutes a generic line when the survey's data carries none", async () => {
    expect((await compile(survey())).survey.instructions).toBe(DEFAULT_INSTRUCTIONS);
  });

  it("keeps what the survey says", async () => {
    given({ instructions: "Pick what matters to you.", options: THREE });
    expect((await compile(survey())).survey.instructions).toBe("Pick what matters to you.");
  });

  it("the fallback claims nothing about how many may be chosen", async () => {
    // The bounds line is rendered from minChoices/maxChoices directly beneath the instructions,
    // so a fallback naming a count would contradict it as soon as the bounds change.
    expect(DEFAULT_INSTRUCTIONS).not.toMatch(/\b(\d+|one|two|three|four|five)\b/i);
  });
});
