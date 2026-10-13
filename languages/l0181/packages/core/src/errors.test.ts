// SPDX-License-Identifier: MIT
/**
 * What a malformed deck says.
 *
 * L0159 had no validation at all: a bad deck compiled clean and threw inside the renderer, so
 * the author saw a blank card rather than a sentence naming the pair that was wrong. These
 * assert the sentence, because an LLM reads it and retries.
 */
import { test, describe, expect } from "vitest";
import { errorOf } from "./testing.js";

describe("the deck", () => {
  test("a non-list deck names the form it wanted", async () => {
    const msg = await errorOf('cards "hola" {}');
    expect(msg).toMatch(/^cards: expected a list of pairs/);
    expect(msg).toContain('cards [["hola" "hello"] ["adiós" "goodbye"]] {}');
  });

  test("an empty deck says so", async () => {
    expect(await errorOf("cards [] {}")).toMatch(/the deck is empty/);
  });

  test("a short pair names the pair and the count", async () => {
    expect(await errorOf('cards [["a" "b"] ["c"]] {}')).toBe(
      "cards: pair 2 has 1 element; a card needs exactly two — a front and a back.",
    );
  });

  test("a long pair names the pair and the count", async () => {
    expect(await errorOf('cards [["a" "b" "c"]] {}')).toBe(
      "cards: pair 1 has 3 elements; a card needs exactly two — a front and a back.",
    );
  });

  test("a non-string side names which side", async () => {
    expect(await errorOf('cards [["a" 3]] {}')).toBe(
      "cards: pair 1: both sides must be strings, but its back is 3.",
    );
    expect(await errorOf('cards [[3 "a"]] {}')).toBe(
      "cards: pair 1: both sides must be strings, but its front is 3.",
    );
  });

  test("a pair that is not a list at all", async () => {
    expect(await errorOf('cards ["a"] {}')).toBe(
      'cards: pair 1 is "a", not a ["front" "back"] pair.',
    );
  });
});

describe("attributes", () => {
  test("theme rejects a string, and shows it as written", async () => {
    expect(await errorOf('cards [["a" "b"]] theme "dark" {}')).toBe(
      'theme: expected the tag DARK or LIGHT. Got "dark".',
    );
  });

  test("theme rejects a number", async () => {
    expect(await errorOf('cards [["a" "b"]] theme 3 {}')).toMatch(
      /^theme: expected the tag DARK or LIGHT\. Got 3\./,
    );
  });

  test("title rejects a non-string", async () => {
    expect(await errorOf('cards [["a" "b"]] title 3 {}')).toMatch(
      /^title: expected a string, e\.g\. title "Spanish Vocab"\./,
    );
  });

  test("an error nested inside the chain still surfaces", async () => {
    // Each word holds the REST of the program in its second argument, so a Checker that walks
    // only the first argument drops every rule below it.
    expect(await errorOf('cards [["a" "b"]] theme LIGHT instructions "hi" theme 3 {}')).toMatch(
      /^theme: expected the tag DARK or LIGHT/,
    );
  });

  test("instructions rejects a non-string", async () => {
    expect(await errorOf('cards [["a" "b"]] instructions 3 {}')).toMatch(
      /^instructions: expected a string/,
    );
  });
});
