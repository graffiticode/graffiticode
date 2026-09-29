// SPDX-License-Identifier: MIT
/**
 * The segmentation and quote-matching module, tested without the compiler.
 *
 * It is a separate module precisely so it can be exercised like this — the same functions run
 * from HOTTEXT and from ITEM, and a bug in either path is a bug here.
 */
import { test, describe, expect } from "vitest";
import { norm, resolveSelections, sentenceUnits, splitSentences, wordUnits } from "./hottext.js";

describe("splitSentences", () => {
  test("splits on sentence punctuation", () => {
    expect(splitSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
  });

  test("an honorific does not end a sentence", () => {
    // A bare [.!?] split makes "Mr." its own clickable unit, which is the bug the abbreviation
    // list exists to prevent.
    expect(splitSentences("Mr. Ruiz never learned who had fixed his porch.")).toEqual([
      "Mr. Ruiz never learned who had fixed his porch.",
    ]);
    expect(splitSentences("She waited for Dr. Alvarez. He was late.")).toEqual([
      "She waited for Dr. Alvarez.",
      "He was late.",
    ]);
  });

  test("initials and dotted pairs hold together", () => {
    expect(splitSentences("She met J. Alvarez at noon.")).toHaveLength(1);
    expect(splitSentences("The bell rang at 9 a.m. sharp.")).toHaveLength(1);
  });

  test("closing punctuation stays with its sentence", () => {
    expect(splitSentences('"Stop!" she called. He ran.')).toEqual(['"Stop!" she called.', "He ran."]);
  });

  test("an unterminated tail is kept, not dropped", () => {
    // L0175's regex keeps only runs ending in .!?, so a final sentence with no full stop is lost
    // silently. It is real text the candidate can see, so it has to be selectable.
    expect(splitSentences("She left. Then nothing more")).toEqual(["She left.", "Then nothing more"]);
  });

  test("empty text has no sentences", () => {
    expect(splitSentences("   ")).toEqual([]);
  });
});

describe("sentenceUnits", () => {
  test("addresses sentences as <paragraphId>.<n>, matching L0175's line references", () => {
    const units = sentenceUnits([
      { id: "p1", text: "One. Two." },
      { id: "p2", text: "Three." },
    ]);
    expect(units.map((u) => u.id)).toEqual(["p1.1", "p1.2", "p2.1"]);
    expect(units.every((u) => u.selectable)).toBe(true);
  });
});

describe("wordUnits", () => {
  test("strips punctuation into pre/post so the core word is the click target", () => {
    const units = wordUnits('The "aqueduct," he said.');
    expect(units.map((u) => u.text)).toEqual(["The", "aqueduct", "he", "said"]);
    const aqueduct = units[1];
    expect(aqueduct).toMatchObject({ id: "w2", pre: '"', post: ',"' });
  });

  test("nothing is selectable until a selection names it", () => {
    expect(wordUnits("The aqueduct carried water.").every((u) => !u.selectable)).toBe(true);
  });

  test("a token that is all punctuation survives as itself", () => {
    const units = wordUnits("Wait — stop.");
    expect(units.map((u) => u.text)).toEqual(["Wait", "—", "stop"]);
  });
});

describe("resolveSelections", () => {
  const passage = () =>
    sentenceUnits([
      { id: "p1", text: "Mara crouched at the edge of the tide pool." },
      { id: "p2", text: "Her brother called twice. She did not turn around." },
    ]);

  test("an exact quote resolves to its unit", () => {
    const r = resolveSelections(passage(), [{ quote: "She did not turn around.", assess: { correct: true } }], "hottext");
    expect(r.correctIds).toEqual(["p2.2"]);
    expect(r.mapping).toEqual({ "p2.2": { correct: true, points: 1 } });
  });

  test("case and punctuation do not have to match", () => {
    const r = resolveSelections(passage(), [{ quote: "she did not turn around", assess: { correct: true } }], "hottext");
    expect(r.correctIds).toEqual(["p2.2"]);
  });

  test("a quote naming only part of a sentence still resolves", () => {
    const r = resolveSelections(passage(), [{ quote: "crouched at the edge", assess: { correct: true } }], "hottext");
    expect(r.correctIds).toEqual(["p1.1"]);
  });

  test("a rationale rides alongside without scoring anything", () => {
    const r = resolveSelections(
      passage(),
      [
        { quote: "She did not turn around.", assess: { correct: true } },
        { quote: "Her brother called twice.", assess: { rationale: "That is what she ignores." } },
      ],
      "hottext",
    );
    expect(r.feedback).toEqual({ "p2.1": "That is what she ignores." });
    expect(r.mapping).toEqual({ "p2.2": { correct: true, points: 1 } });
  });

  test("a quote that matches nothing names the closest text", () => {
    const msg = (() => {
      try {
        resolveSelections(passage(), [{ quote: "She did not turn round." }], "hottext");
      } catch (e: any) {
        return String(e.message);
      }
      return "";
    })();
    expect(msg).toContain("does not appear in the text");
    expect(msg).toContain("She did not turn around.");
  });

  test("a quote that matches two places is ambiguous, not a silent pick", () => {
    const units = sentenceUnits([{ id: "p1", text: "She ran. She ran." }]);
    expect(() => resolveSelections(units, [{ quote: "She ran." }], "hottext")).toThrow(/matches 2 places/);
  });

  test("two selections cannot name the same place", () => {
    expect(() =>
      resolveSelections(
        passage(),
        [{ quote: "She did not turn around." }, { quote: "did not turn around" }],
        "hottext",
      ),
    ).toThrow(/same text as selection 1/);
  });

  test("a selection needs a quote", () => {
    expect(() => resolveSelections(passage(), [{ assess: { correct: true } }], "hottext")).toThrow(
      /needs a `quote`/,
    );
  });

  test("naming a word marks it selectable", () => {
    const units = wordUnits("The aqueduct carried water.");
    const r = resolveSelections(units, [{ quote: "aqueduct", assess: { correct: true } }], "hottext");
    expect(units.find((u) => u.text === "aqueduct")?.selectable).toBe(true);
    expect(units.find((u) => u.text === "water")?.selectable).toBe(false);
    expect(r.correctIds).toEqual(["w2"]);
  });
});

describe("norm", () => {
  test("collapses case, punctuation and spacing", () => {
    expect(norm('  "She DID not — turn around!"  ')).toBe("she did not turn around");
  });
});
