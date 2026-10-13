// SPDX-License-Identifier: MIT
/**
 * `isAnswered` decides when a result may be shown, at both the item and the activity level.
 *
 * The cases that matter are the interactions whose response is a container that exists from
 * the first click: a half-filled sentence and a half-finished pairing are SHORT, not absent, so
 * "the key is present" would call them done and show a verdict on an unfinished answer.
 */
import { test, describe, expect } from "vitest";
import { isAnswered } from "./answered.js";

const CHOICE = { type: "choice", id: "1" };

describe("the simple cases", () => {
  test("a choice is answered once something is selected", () => {
    expect(isAnswered(CHOICE, [])).toBe(false);
    expect(isAnswered(CHOICE, ["A"])).toBe(true);
    expect(isAnswered(CHOICE, undefined)).toBe(false);
  });

  test("whitespace is not a written response", () => {
    const written = { type: "extended-text" };
    expect(isAnswered(written, "   \n ")).toBe(false);
    expect(isAnswered(written, "Because.")).toBe(true);
  });

  test("nothing at all is not answered", () => {
    expect(isAnswered(null, ["A"])).toBe(false);
  });
});

describe("the interactions that answer with a container", () => {
  const sentence = {
    type: "text-entry",
    segments: [{ text: "The " }, { blank: "a" }, { text: " orbits the " }, { blank: "b" }],
  };

  test("a text-entry needs every blank filled", () => {
    expect(isAnswered(sentence, { a: "Moon" })).toBe(false);
    expect(isAnswered(sentence, { a: "Moon", b: "  " })).toBe(false);
    expect(isAnswered(sentence, { a: "Moon", b: "Earth" })).toBe(true);
  });

  test("an inline-choice needs every menu picked", () => {
    const menus = { type: "inline-choice", segments: [{ choice: "a" }, { choice: "b" }] };
    expect(isAnswered(menus, { a: ["A"] })).toBe(false);
    expect(isAnswered(menus, { a: ["A"], b: ["B"] })).toBe(true);
  });

  test("a pairing needs one pair per item", () => {
    const match = { type: "match", items: [{ id: "i1" }, { id: "i2" }] };
    expect(isAnswered(match, ["i1 t1"])).toBe(false);
    expect(isAnswered(match, ["i1 t1", "i2 t2"])).toBe(true);
  });

  test("a gap-match needs every gap filled", () => {
    const gaps = { type: "gap-match", segments: [{ text: "The " }, { gap: "g1" }, { gap: "g2" }] };
    expect(isAnswered(gaps, ["g1 t1"])).toBe(false);
    expect(isAnswered(gaps, ["g1 t1", "g2 t2"])).toBe(true);
  });
});

describe("an item", () => {
  const item = { type: "item", parts: [{ ...CHOICE, id: "1" }, { type: "choice", id: "2" }] };

  test("is answered when every part is", () => {
    expect(isAnswered(item, { "1": ["A"] })).toBe(false);
    expect(isAnswered(item, { "1": ["A"], "2": ["B"] })).toBe(true);
  });

  test("with no parts is not answered", () => {
    expect(isAnswered({ type: "item", parts: [] }, {})).toBe(false);
  });
});
