// SPDX-License-Identifier: MIT
/**
 * The choice interaction, end to end: source -> {interaction, validation}.
 *
 * Assertions are on COMPILED OUTPUT, never on source shape. The surface syntax is allowed to
 * change; what the renderer and the scorer consume is the contract.
 *
 * Error cases assert on the MESSAGE TEXT, not merely that something failed. The generator is
 * an LLM that reads these messages and retries, so a message that stops naming the legal set
 * or where a misplaced word belongs is a regression even though the program still fails.
 */
import { test, describe, expect } from "vitest";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon, optionLabel } from "./index.js";

async function compile(src: string): Promise<any> {
  const code: any = await parser.parse(180, src.trim().endsWith("..") ? src : `${src}..`, lexicon);
  const perr: any = Object.values(code).find((n: any) => n && n.tag === "ERROR");
  if (perr) throw new Error(`parse error: ${JSON.stringify(perr.elts)}`);
  return await new Promise((resolve, reject) =>
    compiler.compile(code, {}, {}, (e: any, v: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) reject(errs);
      else resolve(v);
    }),
  );
}

/** The first error message, however the compiler chose to shape it. */
async function errorOf(src: string): Promise<string> {
  try {
    const val = await compile(src);
    throw new Error(`expected a compile error, got ${JSON.stringify(val)}`);
  } catch (e: any) {
    if (e instanceof Error) throw e;
    const first = Array.isArray(e) ? e[0] : e;
    return String(first?.message ?? first);
  }
}

const BASIC = `
choice [
  prompt "What is 2 + 2?"
  options [
    [ text "3" ]
    [ text "4" assess [ correct points 2 ] ]
    [ text "5" assess [ points -1 ] ]
  ] {}
]..
`;

describe("interaction", () => {
  test("carries the stem, the options, and nothing about the answer", async () => {
    // `shuffle` is false here for a reason worth naming: 3, 4, 5 is an ascending numeric list,
    // and a list whose order is already information keeps it. Every other item shuffles.
    const { interaction } = await compile(BASIC);
    expect(interaction).toEqual({
      type: "choice",
      prompt: "What is 2 + 2?",
      minChoices: 0,
      maxChoices: 1,
      shuffle: false,
      options: [
        { id: "A", text: "3" },
        { id: "B", text: "4" },
        { id: "C", text: "5" },
      ],
    });
    // The answer key must not leak into the half that ships to the browser.
    expect(JSON.stringify(interaction)).not.toContain("correct");
    expect(JSON.stringify(interaction)).not.toContain("points");
  });

  test("ids derive as A, B, C and are overridable one at a time", async () => {
    const { interaction } = await compile(`
      choice [ options [ [ text "a" ] [ id "zz" text "b" ] [ text "c" ] ] {} ]
    `);
    expect(interaction.options.map((o: any) => o.id)).toEqual(["A", "zz", "C"]);
  });

  test("optionLabel runs past Z", () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(optionLabel)).toEqual([
      "A", "B", "Z", "AA", "AB", "AZ", "BA",
    ]);
  });

  test("a prompt is optional", async () => {
    const { interaction } = await compile(`choice [ options [ [ text "a" ] ] {} ]`);
    expect(interaction.prompt).toBeUndefined();
  });
});

describe("validation", () => {
  test("keys by option id, and points sums only the correct options", async () => {
    const { validation } = await compile(BASIC);
    expect(validation).toEqual({
      points: 2,
      responseProcessing: "map_response",
      cardinality: "single",
      baseType: "identifier",
      mapping: { B: { correct: true, points: 2 }, C: { points: -1 } },
    });
  });

  test("`correct` with no points is worth 1", async () => {
    const { validation } = await compile(`
      choice [ options [ [ text "a" ] [ text "b" assess [ correct ] ] ] {} ]
    `);
    expect(validation).toEqual({
      responseProcessing: "map_response",
      cardinality: "single",
      baseType: "identifier",
      points: 1,
      mapping: { B: { correct: true, points: 1 } },
    });
  });

  test("a penalty cannot move the ceiling", async () => {
    const { validation } = await compile(`
      choice [
        options [
          [ text "a" assess [ correct points 3 ] ]
          [ text "b" assess [ points -5 ] ]
          [ text "c" assess [ points -5 ] ]
        ] {}
      ]
    `);
    expect(validation.points).toBe(3);
  });

  test("attribute order inside assess does not matter", async () => {
    const a = await compile(`choice [ options [ [ text "x" assess [ correct points 2 ] ] ] {} ]`);
    const b = await compile(`choice [ options [ [ text "x" assess [ points 2 correct ] ] ] {} ]`);
    expect(a.validation).toEqual(b.validation);
  });

  test("an item with no assess anywhere is unscored rather than an error", async () => {
    const { validation } = await compile(`choice [ options [ [ text "a" ] [ text "b" ] ] {} ]`);
    expect(validation).toEqual({
      responseProcessing: "map_response",
      cardinality: "single",
      baseType: "identifier",
      points: 0,
      mapping: {},
    });
  });

  test("multi-select sums every correct option", async () => {
    const { interaction, validation } = await compile(`
      choice [
        prompt "Select the primes"
        max-choices 3
        options [
          [ text "2" assess [ correct ] ]
          [ text "4" ]
          [ text "5" assess [ correct points 2 ] ]
        ] {}
      ]
    `);
    expect(interaction.maxChoices).toBe(3);
    expect(validation.points).toBe(3);
  });
});

describe("errors name the fix, not just the fault", () => {
  test("assess that asserts nothing", async () => {
    const msg = await errorOf(`choice [ options [ [ text "a" assess [] ] ] {} ]`);
    expect(msg).toContain("assess must say what it asserts");
    expect(msg).toContain("`correct`, `points`, or `rationale`");
  });

  test("assessed options but none correct", async () => {
    const msg = await errorOf(`choice [ options [ [ text "a" assess [ points -1 ] ] ] {} ]`);
    expect(msg).toContain("no option is marked `correct`");
  });

  test("`correct` written on the option instead of inside assess says where it goes", async () => {
    const msg = await errorOf(`choice [ options [ [ text "a" correct ] ] {} ]`);
    expect(msg).toContain("is not an attribute of option");
    expect(msg).toContain("It takes: id, text, assess");
    expect(msg).toContain("belongs inside `assess`");
  });

  test("an option attribute written on choice lists the legal set", async () => {
    const msg = await errorOf(`choice [ text "oops" options [ [ text "a" ] ] {} ]`);
    expect(msg).toContain("is not an attribute of choice");
    expect(msg).toContain(
      "prompt, shuffle, min-choices, max-choices, response-processing, upper-bound, options",
    );
  });

  test("more correct options than max-choices allows", async () => {
    const msg = await errorOf(`
      choice [ options [ [ text "a" assess [ correct ] ] [ text "b" assess [ correct ] ] ] {} ]
    `);
    expect(msg).toContain("2 options are marked `correct` but max-choices is 1");
    expect(msg).toContain("Raise `max-choices`");
  });

  test("duplicate ids", async () => {
    const msg = await errorOf(`choice [ options [ [ id "x" text "a" ] [ id "x" text "b" ] ] {} ]`);
    expect(msg).toContain('two options share the id "x"');
  });

  test("an empty option list", async () => {
    const msg = await errorOf(`choice [ prompt "?" options [] {} ]`);
    expect(msg).toContain("needs at least one option");
  });

  test("a repeated attribute is refused rather than silently overwritten", async () => {
    const msg = await errorOf(`choice [ options [ [ text "a" text "b" ] ] {} ]`);
    expect(msg).toContain("is given twice");
  });

  test("a wrongly typed value names the word and what it wanted", async () => {
    expect(await errorOf(`choice [ prompt 42 options [ [ text "a" ] ] {} ]`)).toContain(
      "prompt: expected a string",
    );
    expect(
      await errorOf(`choice [ options [ [ text "a" assess [ correct points "two" ] ] ] {} ]`),
    ).toContain("points: expected a number");
    expect(await errorOf(`choice [ shuffle "yes" options [ [ text "a" ] ] {} ]`)).toContain(
      "shuffle: expected true or false",
    );
  });
});

describe("response-processing: the two QTI templates", () => {
  const EXACT = `
    choice [
      prompt "Choose the two sentences that belong in a summary."
      response-processing "match-correct"
      min-choices 2
      max-choices 2
      options [
        [ text "Bees live together in colonies." assess [ correct ] ]
        [ text "Every bee does a job." assess [ correct ] ]
        [ text "Some bees are yellow and black." ]
        [ text "A hive can be kept in a box." ]
      ] {}
    ]
  `;

  test("defaults to map-response, so nothing already authored changes", async () => {
    const { validation } = await compile(BASIC);
    expect(validation.responseProcessing).toBe("map_response");
  });

  test("match-correct carries the correct set and NO mapping", async () => {
    // The two are alternatives in QTI and stay alternatives here: per-option points have no
    // meaning under an all-or-nothing template, so the field is absent rather than ignored.
    const { validation } = await compile(EXACT);
    expect(validation).toEqual({
      responseProcessing: "match_correct",
      cardinality: "multiple",
      baseType: "identifier",
      points: 1,
      correctResponse: ["A", "B"],
    });
    expect(validation.mapping).toBeUndefined();
  });

  test("the correct set is still absent from the half that ships to the browser", async () => {
    const { interaction } = await compile(EXACT);
    expect(JSON.stringify(interaction)).not.toContain("correct");
  });

  test("cardinality and baseType ride in the key, as QTI's response declaration does", async () => {
    // Both are derived, not authored: max-choices already says the cardinality and the
    // interaction type says the base type. They sit in `validation` because that half IS the
    // response declaration, and splitting the two across the halves would be the odd choice.
    const single = await compile(BASIC);
    expect(single.validation).toMatchObject({ cardinality: "single", baseType: "identifier" });
    expect(single.interaction.cardinality).toBeUndefined();
    const multi = await compile(EXACT);
    expect(multi.validation.cardinality).toBe("multiple");
  });

  test("per-option points under match-correct is refused, not ignored", async () => {
    const msg = await errorOf(EXACT.replace("[ correct ]", "[ correct points 2 ]"));
    expect(msg).toContain("`points` is not meaningful under");
    expect(msg).toContain('response-processing "match-correct"');
    expect(msg).toContain('response-processing "map-response"');
  });

  test("match-correct with nothing marked correct names the fix", async () => {
    const msg = await errorOf(`
      choice [ response-processing "match-correct" options [ [ text "a" ] [ text "b" ] ] {} ]
    `);
    expect(msg).toContain("scores against the correct set");
    expect(msg).toContain("assess [correct]");
  });

  test("an unknown template names the legal set", async () => {
    const msg = await errorOf(`
      choice [ response-processing "exact" options [ [ text "a" assess [ correct ] ] ] {} ]
    `);
    expect(msg).toContain("is not a response-processing mode");
    expect(msg).toContain("map-response, match-correct");
  });
});

describe("rationale", () => {
  const WITH_RATIONALE = `
    choice [
      prompt "What can the reader conclude about Mara?"
      options [
        [ text "She is absorbed by the tide pool." assess [ correct ] ]
        [ text "She is angry at her brother."
          assess [ rationale "Not turning around shows absorption, not anger." ] ]
      ] {}
    ]
  `;

  test("rides in validation, keyed by option id", async () => {
    const { validation } = await compile(WITH_RATIONALE);
    expect(validation.feedback).toEqual({
      B: "Not turning around shows absorption, not anger.",
    });
  });

  test("never reaches interaction — a graded delivery withholds it", async () => {
    const { interaction } = await compile(WITH_RATIONALE);
    expect(JSON.stringify(interaction)).not.toContain("absorption");
  });

  test("asserts nothing about scoring on its own", async () => {
    const { validation } = await compile(WITH_RATIONALE);
    // B carries a rationale but no points, so it is not in the mapping and not in the ceiling.
    expect(validation.mapping).toEqual({ A: { correct: true, points: 1 } });
    expect(validation.points).toBe(1);
  });

  test("works under match-correct too, where there is no mapping to hang it on", async () => {
    const { validation } = await compile(`
      choice [
        response-processing "match-correct"
        max-choices 2
        options [
          [ text "a" assess [ correct ] ]
          [ text "b" assess [ correct ] ]
          [ text "c" assess [ rationale "Off topic." ] ]
        ] {}
      ]
    `);
    expect(validation.correctResponse).toEqual(["A", "B"]);
    expect(validation.feedback).toEqual({ C: "Off topic." });
  });

  test("is absent entirely when nothing carries one", async () => {
    const { validation } = await compile(BASIC);
    expect(validation.feedback).toBeUndefined();
  });
});

describe("the response round trip", () => {
  test("a fresh compile wins over a stale one carried in data", async () => {
    // The View merges each compile result back into the model, so `data` arrives holding the
    // PREVIOUS interaction. If that shadowed the new one the item would never change again.
    const code: any = await parser.parse(180, BASIC, lexicon);
    const stale = { interaction: { type: "choice", prompt: "STALE", options: [] }, response: ["B"] };
    const val: any = await new Promise((resolve, reject) =>
      compiler.compile(code, stale, {}, (e: any, v: any) => {
        const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
        if (errs.length) reject(errs);
        else resolve(v);
      }),
    );
    expect(val.interaction.prompt).toBe("What is 2 + 2?");
    // ...while the learner's own response survives untouched.
    expect(val.response).toEqual(["B"]);
  });
});

describe("presentation is randomized unless the order means something", () => {
  test("an ordinary list shuffles, with no `shuffle` written anywhere", async () => {
    const { interaction } = await compile(`
      choice [
        prompt "Which planet is closest to the Sun?"
        options [ [ text "Mercury" assess [ correct ] ] [ text "Venus" ] [ text "Mars" ] ] {}
      ]`);
    expect(interaction.shuffle).toBe(true);
  });

  test("`shuffle false` keeps the authored order", async () => {
    const { interaction } = await compile(`
      choice [
        shuffle false
        options [ [ text "Mercury" assess [ correct ] ] [ text "Venus" ] ] {}
      ]`);
    expect(interaction.shuffle).toBe(false);
  });

  test("numbers in sequence keep theirs, and the author can override that", async () => {
    const ordered = await compile(`
      choice [ options [ [ text "2" ] [ text "4" assess [ correct ] ] [ text "8" ] ] {} ]`);
    expect(ordered.interaction.shuffle).toBe(false);
    // What the author wrote always wins, in either direction.
    const forced = await compile(`
      choice [ shuffle true options [ [ text "2" ] [ text "4" assess [ correct ] ] [ text "8" ] ] {} ]`);
    expect(forced.interaction.shuffle).toBe(true);
  });

  test("numbers OUT of sequence are evidence nobody chose an order", async () => {
    const { interaction } = await compile(`
      choice [ options [ [ text "9" ] [ text "2" assess [ correct ] ] [ text "11" ] ] {} ]`);
    expect(interaction.shuffle).toBe(true);
  });

  test("true/false keeps its conventional order", async () => {
    const { interaction } = await compile(`
      choice [
        prompt "The Pacific is the largest ocean."
        options [ [ text "True" assess [ correct ] ] [ text "False" ] ] {}
      ]`);
    expect(interaction.shuffle).toBe(false);
  });

  test("an anchored option is marked, and the rest still shuffles around it", async () => {
    const { interaction } = await compile(`
      choice [
        prompt "Which of these are mammals?"
        options [
          [ text "Whale" ]
          [ text "Shark" ]
          [ text "All of the above" assess [ correct ] ]
        ] {}
      ]`);
    expect(interaction.shuffle).toBe(true);
    expect(interaction.options).toEqual([
      { id: "A", text: "Whale" },
      { id: "B", text: "Shark" },
      { id: "C", text: "All of the above", anchored: true },
    ]);
  });

  test("the ordered-list rule reads the options that are NOT anchored", async () => {
    // 2, 4, 8 is still an ordered numeric list with "None of the above" on the end.
    const { interaction } = await compile(`
      choice [
        options [
          [ text "2" ] [ text "4" assess [ correct ] ] [ text "8" ]
          [ text "None of the above" ]
        ] {}
      ]`);
    expect(interaction.shuffle).toBe(false);
    expect(interaction.options[3].anchored).toBe(true);
  });

  test("nothing about anchoring reaches `validation`", async () => {
    const { validation } = await compile(`
      choice [
        options [ [ text "Whale" assess [ correct ] ] [ text "All of the above" ] ] {}
      ]`);
    expect(JSON.stringify(validation)).not.toContain("anchored");
  });
});
