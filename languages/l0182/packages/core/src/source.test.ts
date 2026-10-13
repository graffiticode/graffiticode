// SPDX-License-Identifier: MIT
/**
 * Taking a survey draws one of its versions.
 *
 * These run against the real `data/` directory, because the thing under test is the lookup —
 * a stub source would test the stub. Read paths are relative to `packages/core`, which is the
 * cwd the workspace test script sets.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { readdirSync } from "fs";
import { loadSurvey, resetDraws } from "./source.js";
import { compile, errorOf } from "./harness.js";

/** The survey with several versions; the draw has nothing to do without one. */
const MANY = "civic-priorities";
const versions = readdirSync("data").filter((f) => f.startsWith(`${MANY}-`)).length;

beforeEach(() => resetDraws());

describe("finding a survey", () => {
  test("a survey id draws one of its versions", async () => {
    const { instance, data } = await loadSurvey(MANY, {});
    expect(instance).toMatch(new RegExp(`^${MANY}-\\d+$`));
    expect(data.options.length).toBeGreaterThan(1);
  });

  test("an id naming a version takes that version, and marks nothing", async () => {
    expect((await loadSurvey(`${MANY}-7`, {})).instance).toBe(`${MANY}-7`);
    // Nothing was marked, so a draw can still reach every version including that one.
    const drawn = new Set<string>();
    for (let i = 0; i < versions; i++) drawn.add((await loadSurvey(MANY, {})).instance);
    expect(drawn.size).toBe(versions);
  });

  test("a survey brings its own words and bounds, not just a list", async () => {
    const { data } = await loadSurvey("school-1", {});
    expect(data.title).toBeTypeOf("string");
    expect(data.instructions.length).toBeGreaterThan(20);
    expect(data.maxChoices).toBeGreaterThan(0);
    expect(data.options.length).toBeGreaterThan(1);
  });

  test("an unknown id names the surveys there are", async () => {
    const msg = await loadSurvey("no-such-survey", {}).catch((e) => e.message);
    expect(msg).toContain('there is no survey with id "no-such-survey"');
    expect(msg).toContain(MANY);
  });

  test("a prefix of a survey id is not that survey", async () => {
    // `civic` must not match `civic-priorities-3`: a version is `<id>-<n>`, nothing looser.
    await expect(loadSurvey("civic", {})).rejects.toThrow("there is no survey");
  });

  test("an id that looks like a path is refused before any read", async () => {
    for (const bad of ["../spec/spec", "/etc/passwd", "civic-priorities/../..", "-leading"]) {
      await expect(loadSurvey(bad, {})).rejects.toThrow("is not a survey id");
    }
  });
});

describe("drawing without replacement", () => {
  test("every version is taken before any is taken twice", async () => {
    const seen: string[] = [];
    for (let i = 0; i < versions; i++) seen.push((await loadSurvey(MANY, {})).instance);
    expect(new Set(seen).size, seen.join(" ")).toBe(versions);

    // Exhausted, the marks clear and the cycle starts again.
    const next = await loadSurvey(MANY, {});
    expect(seen).toContain(next.instance);
  });

  test("resetting the state starts the cycle over", async () => {
    for (let i = 0; i < versions - 1; i++) await loadSurvey(MANY, {});
    resetDraws();
    const seen = new Set<string>();
    for (let i = 0; i < versions; i++) seen.add((await loadSurvey(MANY, {})).instance);
    expect(seen.size).toBe(versions);
  });

  test("a session keeps the version it was given", async () => {
    const first = await loadSurvey(MANY, { sessionId: "s1" });
    for (let i = 0; i < 5; i++) {
      expect((await loadSurvey(MANY, { sessionId: "s1" })).instance).toBe(first.instance);
    }
    // And it is still the same one when the program comes back carrying a response.
    expect((await loadSurvey(MANY, { sessionId: "s1" })).instance).toBe(first.instance);
  });

  test("different sessions are drawn separately", async () => {
    const a = await loadSurvey(MANY, { sessionId: "a" });
    const b = await loadSurvey(MANY, { sessionId: "b" });
    expect(b.instance).not.toBe(a.instance);
  });

  test("a session that was never seen is drawn for, not refused", async () => {
    // A first turn can arrive with its answer already written — "answer the civic-priorities
    // survey with …" reaches the compiler as one program — and a brand-new session is
    // indistinguishable from one this process has forgotten. Refusing either would break the
    // first case to guard the second, so both draw.
    const first = await loadSurvey(MANY, { sessionId: "unseen" });
    expect(first.instance).toMatch(new RegExp(`^${MANY}-\\d+$`));
    expect((await loadSurvey(MANY, { sessionId: "unseen" })).instance).toBe(first.instance);
  });

  test("a version named outright is what makes an answer immune to a lost memory", async () => {
    // The escape hatch for the case above: `instance` is in the compiled survey, and writing it
    // as the id takes that version whatever this process remembers.
    resetDraws();
    expect((await loadSurvey(`${MANY}-3`, { sessionId: "whatever" })).instance).toBe(`${MANY}-3`);
  });
});

describe("taking a survey in a program", () => {
  test("the options are compiled in, and the version is recorded", async () => {
    const out = await compile(`survey [ id "${MANY}" session-id get-val-public "itemId" ]`, {
      itemId: "item-1",
    });
    expect(out.survey.id).toBe(MANY);
    expect(out.survey.sessionId).toBe("item-1");
    expect(out.survey.instance).toMatch(new RegExp(`^${MANY}-\\d+$`));
    expect(out.survey.options.length).toBeGreaterThan(1);
    expect(out.survey.title).toBeTypeOf("string");
    expect(out.response).toBeUndefined();
  });

  test("answering keeps the version the session was shown", async () => {
    const shown = await compile(`survey [ id "${MANY}" session-id get-val-public "itemId" ]`, {
      itemId: "item-2",
    });
    const answered = await compile(
      `survey [ id "${MANY}" session-id get-val-public "itemId"
         response [ choices [${JSON.stringify(shown.survey.options[0].text)}] ] ]`,
      { itemId: "item-2" },
    );
    expect(answered.survey.instance).toBe(shown.survey.instance);
    expect(answered.response.choices).toEqual([shown.survey.options[0].id]);
  });

  test("an unresolved itemId is no session at all", async () => {
    // Parsed with nothing to resolve, `get-val-public` folds to "". Recording that as a session
    // would hand every such compile one shared survey.
    const out = await compile(`survey [ id "${MANY}" session-id get-val-public "itemId" ]`);
    expect(out.survey.sessionId).toBeUndefined();
  });

  test("a program without `id` is told what to write", async () => {
    const msg = await errorOf('survey [ session-id get-val-public "itemId" ]', { itemId: "x" });
    expect(msg).toContain("needs `id`");
    expect(msg).toContain('id "civic-priorities"');
  });

  test("the words that used to build a survey in code are gone", async () => {
    // They are out of the lexicon, not merely rejected by `survey`, so a program that writes one
    // never reaches the compiler. A survey cannot be authored here at all — that is the point.
    for (const gone of [
      'ideas ["a" "b"]',
      'options ["a" "b"]',
      'title "t"',
      'instructions "i"',
      "min-choices 1",
      "max-choices 2",
      'name "civic-priorities"',
      'fetch "https://example.org/options.json"',
    ]) {
      const msg = await errorOf(`survey [ id "${MANY}" ${gone} ]`);
      expect(msg, gone).toContain("parse error");
    }
  });
});
