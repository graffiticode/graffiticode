// SPDX-License-Identifier: MIT
/**
 * The scorer's contract. No DOM anywhere — if these ever need jsdom, the scorer has picked up
 * a browser dependency it must not have.
 */
import { test, describe, expect } from "vitest";
import {
  correctIds,
  scoreChoice,
  scoreHuman,
  scoreInlineChoice,
  scoreInteraction,
  scoreOrder,
  scorePairs,
  scoreTextEntry,
  selectedIds,
  type Validation,
} from "./score.js";

/** The validation half of the compiled example in core's choice.test.ts. */
const VALIDATION: Validation = {
  points: 2,
  mapping: { B: { correct: true, points: 2 }, C: { points: -1 } },
};

describe("scoreChoice", () => {
  test("the right answer earns exactly the ceiling", () => {
    const s = scoreChoice({ response: ["B"], validation: VALIDATION });
    expect(s.points).toBe(2);
    expect(s.maxPoints).toBe(2);
    expect(s.correct).toBe(true);
  });

  test("an unassessed distractor earns nothing and costs nothing", () => {
    const s = scoreChoice({ response: ["A"], validation: VALIDATION });
    expect(s).toMatchObject({ points: 0, rawPoints: 0, correct: false });
  });

  test("a penalty option subtracts", () => {
    const s = scoreChoice({ response: ["C"], validation: { points: 5, mapping: VALIDATION.mapping } });
    expect(s.rawPoints).toBe(-1);
  });

  test("the item score is floored at zero, and the raw sum is still reported", () => {
    const s = scoreChoice({ response: ["C"], validation: VALIDATION });
    expect(s.rawPoints).toBe(-1);
    expect(s.points).toBe(0);
  });

  test("no response scores zero rather than throwing", () => {
    for (const r of [undefined, null, [], ""]) {
      expect(scoreChoice({ response: r, validation: VALIDATION }).points).toBe(0);
    }
  });

  test("the ceiling is unreachable by any response other than the correct set", () => {
    const multi: Validation = {
      points: 3,
      mapping: { A: { correct: true, points: 1 }, C: { correct: true, points: 2 }, D: { points: -1 } },
    };
    const everything = scoreChoice({ response: ["A", "C", "D"], validation: multi });
    expect(everything.points).toBeLessThan(multi.points);
    const exact = scoreChoice({ response: ["A", "C"], validation: multi });
    expect(exact.points).toBe(3);
    expect(exact.correct).toBe(true);
  });

  test("reports every keyed option, selected or not", () => {
    const s = scoreChoice({ response: ["B"], validation: VALIDATION });
    expect(s.options).toEqual({
      B: { selected: true, points: 2, correct: true },
      C: { selected: false, points: -1, correct: false },
    });
  });

  test("an unscored item is never `correct` — there is nothing to earn", () => {
    const s = scoreChoice({ response: ["A"], validation: { points: 0, mapping: {} } });
    expect(s).toMatchObject({ points: 0, maxPoints: 0, correct: false });
  });

  test("survives a malformed or absent validation", () => {
    expect(scoreChoice({ response: ["B"], validation: null }).points).toBe(0);
    expect(scoreChoice({ response: ["B"], validation: undefined }).maxPoints).toBe(0);
    expect(scoreChoice({ response: ["Z"], validation: VALIDATION }).points).toBe(0);
  });
});

describe("scoreChoice under match_correct", () => {
  /** "Choose the two sentences that belong in a summary" — L0175's multi-select shape. */
  const EXACT: Validation = {
    responseProcessing: "match_correct",
    points: 1,
    correctResponse: ["A", "B"],
  };

  test("exactly the correct set earns the point", () => {
    const s = scoreChoice({ response: ["A", "B"], validation: EXACT });
    expect(s).toMatchObject({ points: 1, maxPoints: 1, correct: true });
  });

  test("order does not matter", () => {
    expect(scoreChoice({ response: ["B", "A"], validation: EXACT }).correct).toBe(true);
  });

  test("a SUBSET earns nothing — this is the whole point of the template", () => {
    // Under map_response this same response would have earned half. Naming the template is
    // what makes the difference visible instead of silent.
    const s = scoreChoice({ response: ["A"], validation: EXACT });
    expect(s).toMatchObject({ points: 0, correct: false });
  });

  test("a SUPERSET earns nothing either", () => {
    const s = scoreChoice({ response: ["A", "B", "C"], validation: EXACT });
    expect(s).toMatchObject({ points: 0, correct: false });
  });

  test("an empty response earns nothing", () => {
    expect(scoreChoice({ response: [], validation: EXACT }).correct).toBe(false);
  });

  test("reports per-option outcomes over the correct set and whatever was picked", () => {
    const s = scoreChoice({ response: ["A", "C"], validation: EXACT });
    expect(s.options).toEqual({
      A: { selected: true, points: 0, correct: true },
      B: { selected: false, points: 0, correct: true },
      C: { selected: true, points: 0, correct: false },
    });
  });

  test("an empty correct set can never be satisfied", () => {
    const s = scoreChoice({
      response: [],
      validation: { responseProcessing: "match_correct", points: 1, correctResponse: [] },
    });
    expect(s.correct).toBe(false);
  });
});

describe("scoreChoice under an upper bound", () => {
  /** Four valid sentences, click any three — L0175's hot-text shape. */
  const SUPERSET: Validation = {
    responseProcessing: "map_response",
    points: 3,
    upperBound: 3,
    mapping: {
      a: { correct: true, points: 1 },
      b: { correct: true, points: 1 },
      c: { correct: true, points: 1 },
      d: { correct: true, points: 1 },
    },
  };

  test("any three of the four reach the ceiling", () => {
    expect(scoreChoice({ response: ["a", "b", "c"], validation: SUPERSET })).toMatchObject({
      points: 3,
      maxPoints: 3,
      correct: true,
    });
    expect(scoreChoice({ response: ["b", "c", "d"], validation: SUPERSET }).correct).toBe(true);
  });

  test("the bound caps a fourth pick rather than paying for it", () => {
    const s = scoreChoice({ response: ["a", "b", "c", "d"], validation: SUPERSET });
    expect(s.points).toBe(3);
    expect(s.rawPoints).toBe(4); // the unclamped sum is still reported
  });

  test("too few still falls short", () => {
    expect(scoreChoice({ response: ["a", "b"], validation: SUPERSET })).toMatchObject({
      points: 2,
      correct: false,
    });
  });
});

describe("correctIds", () => {
  test("reads either template, so the renderer and the scorer cannot disagree", () => {
    expect(correctIds(VALIDATION)).toEqual(["B"]);
    expect(
      correctIds({ responseProcessing: "match_correct", points: 1, correctResponse: ["A", "B"] }),
    ).toEqual(["A", "B"]);
  });

  test("is empty for an unscored item or a missing key", () => {
    expect(correctIds({ points: 0, mapping: {} })).toEqual([]);
    expect(correctIds(null)).toEqual([]);
  });
});

describe("scoreTextEntry", () => {
  const TWO: Validation = {
    responseProcessing: "map_response",
    cardinality: "single",
    baseType: "string",
    points: 2,
    mapping: {
      france: {
        points: 1,
        caseSensitive: false,
        responses: [
          { response: "Paris", correct: true, points: 1 },
          { response: "Lyon", points: 0, rationale: "The largest city after Paris." },
        ],
      },
      italy: {
        points: 1,
        caseSensitive: false,
        responses: [
          { response: "Rome", correct: true, points: 1 },
          { response: "Roma", correct: true, points: 1 },
        ],
      },
    },
  };

  test("both right earns the ceiling", () => {
    const s = scoreTextEntry({ response: { france: "Paris", italy: "Roma" }, validation: TWO });
    expect(s).toMatchObject({ points: 2, maxPoints: 2, correct: true });
  });

  test("one right is partial credit, which is what map_response means", () => {
    const s = scoreTextEntry({ response: { france: "Paris", italy: "Milan" }, validation: TWO });
    expect(s).toMatchObject({ points: 1, correct: false });
    expect(s.options).toMatchObject({
      france: { selected: true, correct: true },
      italy: { selected: true, correct: false },
    });
  });

  test("case is ignored by default", () => {
    expect(scoreTextEntry({ response: { france: "paris", italy: "ROME" }, validation: TWO }).points).toBe(2);
  });

  test("case matters when the entry says so", () => {
    const strict: Validation = {
      responseProcessing: "map_response",
      baseType: "string",
      points: 1,
      mapping: {
        a: { points: 1, caseSensitive: true, responses: [{ response: "NASA", correct: true, points: 1 }] },
      },
    };
    expect(scoreTextEntry({ response: { a: "NASA" }, validation: strict }).points).toBe(1);
    expect(scoreTextEntry({ response: { a: "nasa" }, validation: strict }).points).toBe(0);
  });

  test("surrounding and repeated whitespace never costs a mark", () => {
    const s = scoreTextEntry({ response: { france: "  Paris ", italy: "Roma" }, validation: TWO });
    expect(s.points).toBe(2);
    const spaced: Validation = {
      responseProcessing: "map_response",
      baseType: "string",
      points: 1,
      mapping: {
        a: {
          points: 1,
          caseSensitive: false,
          responses: [{ response: "Cape Canaveral", correct: true, points: 1 }],
        },
      },
    };
    expect(scoreTextEntry({ response: { a: "Cape   Canaveral" }, validation: spaced }).points).toBe(1);
  });

  test("punctuation still counts, unlike the compiler's quote matching", () => {
    // hottext's matcher strips all punctuation so a quote can find its sentence. Here the typed
    // string IS the answer, so "cant" must not pass for "can't".
    const v: Validation = {
      responseProcessing: "map_response",
      baseType: "string",
      points: 1,
      mapping: {
        a: { points: 1, caseSensitive: false, responses: [{ response: "can't", correct: true, points: 1 }] },
      },
    };
    expect(scoreTextEntry({ response: { a: "cant" }, validation: v }).points).toBe(0);
    expect(scoreTextEntry({ response: { a: "can't" }, validation: v }).points).toBe(1);
  });

  test("blank, missing and stale responses earn nothing and throw nothing", () => {
    expect(scoreTextEntry({ response: { france: "  " }, validation: TWO }).points).toBe(0);
    expect(scoreTextEntry({ response: {}, validation: TWO }).points).toBe(0);
    expect(scoreTextEntry({ response: null, validation: TWO }).points).toBe(0);
    expect(scoreTextEntry({ response: { gone: "Paris" }, validation: TWO }).points).toBe(0);
  });

  test("a recognized wrong answer earns its points and reports its rationale", () => {
    const s = scoreTextEntry({ response: { france: "Lyon", italy: "Rome" }, validation: TWO });
    expect(s.points).toBe(1);
    expect(s.options?.france).toMatchObject({
      selected: true,
      correct: false,
      points: 0,
      rationale: "The largest city after Paris.",
    });
  });

  test("an unanticipated answer earns nothing and carries no rationale", () => {
    const s = scoreTextEntry({ response: { france: "Berlin", italy: "Rome" }, validation: TWO });
    expect(s.options?.france).toMatchObject({ selected: true, correct: false, points: 0 });
    expect(s.options?.france.rationale).toBeUndefined();
  });

  test("a near-miss earns its partial credit", () => {
    const partial: Validation = {
      responseProcessing: "map_response",
      baseType: "string",
      points: 2,
      mapping: {
        a: {
          points: 2,
          caseSensitive: false,
          responses: [
            { response: "Paris", correct: true, points: 2 },
            { response: "Paris France", points: 1 },
          ],
        },
      },
    };
    expect(scoreTextEntry({ response: { a: "Paris France" }, validation: partial })).toMatchObject({
      points: 1,
      correct: false,
    });
  });

  test("a penalty subtracts, and the item floors at zero", () => {
    const penal: Validation = {
      responseProcessing: "map_response",
      baseType: "string",
      points: 1,
      mapping: {
        a: {
          points: 1,
          caseSensitive: false,
          responses: [
            { response: "Paris", correct: true, points: 1 },
            { response: "London", points: -1 },
          ],
        },
      },
    };
    const s = scoreTextEntry({ response: { a: "London" }, validation: penal });
    expect(s.rawPoints).toBe(-1);
    expect(s.points).toBe(0);
  });

  test("under match_correct every blank must be right", () => {
    // Nothing emits this today — text-entry always compiles to map_response — but the template
    // is honoured rather than silently ignored, so a hand-built key cannot mean one thing and
    // score as another.
    const exact: Validation = { ...TWO, responseProcessing: "match_correct", points: 1 };
    expect(scoreTextEntry({ response: { france: "Paris", italy: "Rome" }, validation: exact })).toMatchObject({
      points: 1,
      correct: true,
    });
    expect(scoreTextEntry({ response: { france: "Paris" }, validation: exact })).toMatchObject({
      points: 0,
      correct: false,
    });
  });
});

describe("selectedIds", () => {
  test("accepts a bare string, since single-select reports one id", () => {
    expect(selectedIds("B")).toEqual(["B"]);
  });

  test("de-duplicates and drops non-strings", () => {
    expect(selectedIds(["B", "B", 3, null, "C"])).toEqual(["B", "C"]);
  });
});

describe("scoreTextEntry over numbers", () => {
  const half: Validation = {
    responseProcessing: "map_response",
    cardinality: "single",
    points: 1,
    mapping: {
      a: {
        baseType: "float",
        points: 1,
        responses: [{ response: "0.5", correct: true, points: 1 }],
      },
    },
  };

  test("every way of writing the same number earns the point", () => {
    // This is the whole reason for the feature: string comparison marked all but the first
    // of these wrong, and no enumeration of spellings could have covered them.
    for (const typed of ["0.5", "0.50", ".5", "+0.5", " 0.5 ", "1/2", "2/4", "0.500000"]) {
      expect(scoreTextEntry({ response: { a: typed }, validation: half }).points, typed).toBe(1);
    }
  });

  test("a different number does not", () => {
    for (const typed of ["0.6", "5", "0.05", "-0.5"]) {
      expect(scoreTextEntry({ response: { a: typed }, validation: half }).points, typed).toBe(0);
    }
  });

  test("something that is not a number earns nothing and throws nothing", () => {
    for (const typed of ["half", "1/0", "x", "5 cm", "  "]) {
      expect(scoreTextEntry({ response: { a: typed }, validation: half }).points, typed).toBe(0);
    }
  });

  test("a tolerance widens it, and only as far as it says", () => {
    const loose: Validation = {
      ...half,
      mapping: { a: { ...half.mapping!.a, tolerance: 0.01 } },
    };
    expect(scoreTextEntry({ response: { a: "0.51" }, validation: loose }).points).toBe(1);
    expect(scoreTextEntry({ response: { a: "0.49" }, validation: loose }).points).toBe(1);
    expect(scoreTextEntry({ response: { a: "0.52" }, validation: loose }).points).toBe(0);
    // The same answer against a tighter tolerance.
    const tight: Validation = { ...half, mapping: { a: { ...half.mapping!.a, tolerance: 0.001 } } };
    expect(scoreTextEntry({ response: { a: "0.51" }, validation: tight }).points).toBe(0);
  });

  test("a recognized wrong number still explains itself", () => {
    const explained: Validation = {
      responseProcessing: "map_response",
      points: 2,
      mapping: {
        a: {
          baseType: "float",
          points: 2,
          responses: [
            { response: "0.5", correct: true, points: 2 },
            { response: "2", points: 0, rationale: "That is one divided by a half, not a half." },
          ],
        },
      },
    };
    const s = scoreTextEntry({ response: { a: "2.0" }, validation: explained });
    expect(s.points).toBe(0);
    expect(s.options?.a.rationale).toContain("not a half");
  });

  test("a numeric blank and a text blank score side by side", () => {
    const mixed: Validation = {
      responseProcessing: "map_response",
      points: 2,
      mapping: {
        half: { baseType: "float", points: 1, responses: [{ response: "0.5", correct: true, points: 1 }] },
        city: {
          baseType: "string",
          caseSensitive: false,
          points: 1,
          responses: [{ response: "Paris", correct: true, points: 1 }],
        },
      },
    };
    const s = scoreTextEntry({ response: { half: "1/2", city: "paris" }, validation: mixed });
    expect(s).toMatchObject({ points: 2, correct: true });
  });
});

describe("scoreTextEntry when the form is part of the question", () => {
  const asFraction: Validation = {
    responseProcessing: "map_response",
    cardinality: "single",
    points: 1,
    mapping: {
      a: {
        baseType: "float",
        points: 1,
        inputFormats: ["fraction"],
        responses: [{ response: "0.5", correct: true, points: 1 }],
      },
    },
  };
  const at = (typed: string) => scoreTextEntry({ response: { a: typed }, validation: asFraction });

  test("the wanted form earns the point", () => {
    for (const typed of ["1/2", "2/4", " 3/6 "]) expect(at(typed).points, typed).toBe(1);
  });

  test("the right value in another form earns nothing", () => {
    for (const typed of ["0.5", "0.50", ".5", "5e-1"]) expect(at(typed).points, typed).toBe(0);
  });

  test("and is reported as a form problem, not as a wrong answer", () => {
    // The difference matters to whoever reads the outcome: this candidate did the arithmetic.
    // Folding it into a bare zero would tell them, and any report built on this, otherwise.
    const out = at("0.5");
    expect(out.options.a.wrongFormat).toEqual(["fraction"]);
    expect(out.options.a.correct).toBe(false);
  });

  test("a genuinely wrong value is still just wrong, in any form", () => {
    for (const typed of ["1/3", "0.6"]) {
      expect(scoreTextEntry({ response: { a: typed }, validation: asFraction }).options.a.wrongFormat, typed)
        .toBeUndefined();
    }
  });

  test("more than one form may be accepted", () => {
    const either: Validation = {
      ...asFraction,
      mapping: { a: { ...asFraction.mapping!.a, inputFormats: ["decimal", "scientific"] } },
    };
    for (const typed of ["0.5", "5e-1"]) {
      expect(scoreTextEntry({ response: { a: typed }, validation: either }).points, typed).toBe(1);
    }
    expect(scoreTextEntry({ response: { a: "1/2" }, validation: either }).options.a.wrongFormat)
      .toEqual(["decimal", "scientific"]);
  });

  test("no inputFormats means every form, which is what the default compiles to", () => {
    const any: Validation = {
      ...asFraction,
      mapping: { a: { baseType: "float", points: 1, responses: asFraction.mapping!.a.responses } },
    };
    for (const typed of ["0.5", "1/2", "5e-1"]) {
      expect(scoreTextEntry({ response: { a: typed }, validation: any }).points, typed).toBe(1);
    }
  });

  test("the form is checked against the value, not against the tolerance", () => {
    // A tolerance still widens which values count; it has nothing to say about how they are
    // written, and the two must not quietly interact.
    const near: Validation = {
      ...asFraction,
      mapping: { a: { ...asFraction.mapping!.a, tolerance: 0.01 } },
    };
    expect(scoreTextEntry({ response: { a: "50/99" }, validation: near }).points).toBe(1);
    expect(scoreTextEntry({ response: { a: "0.505" }, validation: near }).options.a.wrongFormat)
      .toEqual(["fraction"]);
  });
});

describe("scoreHuman", () => {
  const WRITTEN: Validation = {
    responseProcessing: "human",
    points: 2,
    rubric: [
      { points: 2, descriptor: "Full." },
      { points: 0, descriptor: "None." },
    ],
  };

  test("reports the points as available, not as earned", () => {
    const s = scoreHuman({ validation: WRITTEN });
    expect(s).toMatchObject({ points: 0, maxPoints: 2, correct: false, pending: true });
  });

  test("an unscored item is a different thing entirely", () => {
    // Both earn nothing. Only one of them has anything to earn, and `pending` is the difference.
    const unscored = scoreChoice({ response: [], validation: { points: 0, mapping: {} } });
    expect(unscored.pending).toBeUndefined();
    expect(unscored.maxPoints).toBe(0);
    expect(scoreHuman({ validation: WRITTEN }).maxPoints).toBe(2);
  });
});

describe("scoreInlineChoice", () => {
  /** The validation half of the two-dropdown example in core's inlinechoice.test.ts. */
  const TWO: Validation = {
    responseProcessing: "map_response",
    cardinality: "single",
    points: 2,
    mapping: {
      in: {
        baseType: "identifier",
        points: 1,
        options: {
          A: { correct: true, points: 1 },
          B: { points: 0, rationale: "Oxygen is what plants release." },
        },
      },
      out: {
        baseType: "identifier",
        points: 1,
        options: { A: { correct: true, points: 1 }, B: { points: -1 } },
      },
    },
  };

  test("both right earns the ceiling", () => {
    const s = scoreInlineChoice({ response: { in: ["A"], out: ["A"] }, validation: TWO });
    expect(s).toMatchObject({ points: 2, maxPoints: 2, correct: true });
  });

  test("one right, one wrong is partial credit — the reason a hole is its own variable", () => {
    const s = scoreInlineChoice({ response: { in: ["A"], out: ["B"] }, validation: TWO });
    expect(s).toMatchObject({ points: 0, rawPoints: 0, maxPoints: 2, correct: false });
    // The penalty is real, and it lands on the hole that earned it.
    expect(s.options?.out).toMatchObject({ selected: true, points: -1, correct: false });
    expect(s.options?.in).toMatchObject({ selected: true, points: 1, correct: true });
  });

  test("an unanswered dropdown is not a wrong one", () => {
    const s = scoreInlineChoice({ response: { in: ["A"] }, validation: TWO });
    expect(s).toMatchObject({ points: 1, correct: false });
    expect(s.options?.out).toMatchObject({ selected: false, points: 0, correct: false });
  });

  test("a rationale comes back only for the option actually chosen", () => {
    const wrong = scoreInlineChoice({ response: { in: ["B"], out: ["A"] }, validation: TWO });
    expect(wrong.options?.in.rationale).toContain("Oxygen is what plants release");
    const right = scoreInlineChoice({ response: { in: ["A"], out: ["A"] }, validation: TWO });
    expect(right.options?.in.rationale).toBeUndefined();
  });

  test("a bare id is accepted, the way a single-select UI reports one", () => {
    const s = scoreInlineChoice({ response: { in: "A", out: "A" }, validation: TWO });
    expect(s).toMatchObject({ points: 2, correct: true });
  });

  test("only the first selection in a dropdown can count", () => {
    // A single-select menu should never report two, but a key that scored both would be paying
    // twice for one hole.
    const s = scoreInlineChoice({ response: { in: ["A", "B"], out: ["A"] }, validation: TWO });
    expect(s).toMatchObject({ points: 2, correct: true });
  });

  test("an empty response scores zero without throwing", () => {
    expect(scoreInlineChoice({ response: undefined, validation: TWO })).toMatchObject({
      points: 0,
      correct: false,
      maxPoints: 2,
    });
  });

  test("the points floor holds when penalties outweigh what was earned", () => {
    const s = scoreInlineChoice({ response: { out: ["B"] }, validation: TWO });
    expect(s).toMatchObject({ points: 0, rawPoints: -1 });
  });

  test("scoreInteraction dispatches to it structurally, not on a declared field", () => {
    // Nothing in the key says "inline-choice": the interaction type does, and the scorer never
    // sees it. What it sees is a mapping entry carrying a menu of its own.
    const s = scoreInteraction({
      interaction: { type: "inline-choice" },
      validation: TWO,
      response: { in: ["A"], out: ["A"] },
    });
    expect(s).toMatchObject({ points: 2, correct: true });
  });

  test("a choice key is still scored as a choice", () => {
    const s = scoreInteraction({
      interaction: { type: "choice" },
      validation: VALIDATION,
      response: ["B"],
    });
    expect(s).toMatchObject({ points: 2, correct: true });
  });
});

describe("scoreOrder", () => {
  /** The validation half of the water-cycle example in core's order.test.ts. */
  const CYCLE: Validation = {
    responseProcessing: "match_correct",
    cardinality: "ordered",
    baseType: "identifier",
    points: 1,
    correctResponse: ["B", "A", "D", "C"],
  };

  test("the right sequence earns the point", () => {
    expect(scoreOrder({ response: ["B", "A", "D", "C"], validation: CYCLE })).toMatchObject({
      points: 1,
      maxPoints: 1,
      correct: true,
    });
  });

  test("one pair swapped earns nothing — a sequence is not most of the way right", () => {
    expect(scoreOrder({ response: ["B", "A", "C", "D"], validation: CYCLE })).toMatchObject({
      points: 0,
      correct: false,
    });
  });

  test("the same elements in another order are a different answer", () => {
    // The whole difference from scoreChoice under the same template, where these are equal.
    const backwards = scoreOrder({ response: ["C", "D", "A", "B"], validation: CYCLE });
    expect(backwards.correct).toBe(false);
    expect(scoreChoice({ response: ["C", "D", "A", "B"], validation: CYCLE }).correct).toBe(true);
  });

  test("an incomplete sequence earns nothing", () => {
    expect(scoreOrder({ response: ["B", "A"], validation: CYCLE })).toMatchObject({
      points: 0,
      correct: false,
    });
  });

  test("per element, `correct` says whether it is standing in its own place", () => {
    const s = scoreOrder({ response: ["B", "A", "C", "D"], validation: CYCLE });
    expect(s.options?.B).toMatchObject({ correct: true, selected: true });
    expect(s.options?.A).toMatchObject({ correct: true });
    expect(s.options?.D).toMatchObject({ correct: false });
    expect(s.options?.C).toMatchObject({ correct: false });
  });

  test("an empty response scores zero without throwing", () => {
    expect(scoreOrder({ response: undefined, validation: CYCLE })).toMatchObject({
      points: 0,
      correct: false,
      maxPoints: 1,
    });
  });

  test("scoreInteraction dispatches on cardinality, which is where QTI puts it", () => {
    expect(
      scoreInteraction({
        interaction: { type: "order" },
        validation: CYCLE,
        response: ["B", "A", "D", "C"],
      }),
    ).toMatchObject({ points: 1, correct: true });
    // Without the ordered cardinality it would be scored as a set, and this would pass.
    expect(
      scoreInteraction({
        interaction: { type: "order" },
        validation: CYCLE,
        response: ["C", "D", "A", "B"],
      }),
    ).toMatchObject({ points: 0, correct: false });
  });
});

describe("scoreOrder when two elements read the same", () => {
  /** "the cat sat on the mat" — A and E both read "the", per core's order.test.ts. */
  const SENTENCE: Validation = {
    responseProcessing: "match_correct",
    cardinality: "ordered",
    baseType: "identifier",
    points: 1,
    correctResponse: ["A", "B", "C", "D", "E", "F"],
    interchangeable: [["A", "E"]],
  };

  test("the key itself is correct, as ever", () => {
    expect(scoreOrder({ response: ["A", "B", "C", "D", "E", "F"], validation: SENTENCE })).toMatchObject({
      points: 1,
      correct: true,
    });
  });

  test("the two identical words the other way round is the same sentence, and scores", () => {
    // The whole point: this builds "the cat sat on the mat" exactly, and used to earn zero.
    expect(scoreOrder({ response: ["E", "B", "C", "D", "A", "F"], validation: SENTENCE })).toMatchObject({
      points: 1,
      correct: true,
    });
  });

  test("a genuinely wrong order still earns nothing", () => {
    expect(scoreOrder({ response: ["B", "A", "C", "D", "E", "F"], validation: SENTENCE })).toMatchObject({
      points: 0,
      correct: false,
    });
    // "the cat sat the on mat" — swapping two words that do NOT read alike.
    expect(scoreOrder({ response: ["A", "B", "C", "E", "D", "F"], validation: SENTENCE })).toMatchObject({
      points: 0,
      correct: false,
    });
  });

  test("per element, a twin standing in its sibling's place is marked right", () => {
    const s = scoreOrder({ response: ["E", "B", "C", "D", "A", "F"], validation: SENTENCE });
    expect(s.options?.A.correct).toBe(true);
    expect(s.options?.E.correct).toBe(true);
  });

  test("a key with no interchangeable groups compares ids exactly, as before", () => {
    const strict: Validation = { ...SENTENCE, interchangeable: undefined };
    expect(scoreOrder({ response: ["E", "B", "C", "D", "A", "F"], validation: strict })).toMatchObject({
      correct: false,
    });
  });
});

describe("scorePairs", () => {
  /** The validation half of the country/capital match in core's match.test.ts. */
  const CAPITALS: Validation = {
    responseProcessing: "map_response",
    cardinality: "multiple",
    baseType: "directedPair",
    points: 2,
    mapping: {
      "A paris": { correct: true, points: 1 },
      "B tokyo": { correct: true, points: 1 },
    },
  };

  test("every pairing right earns the ceiling", () => {
    expect(scorePairs({ response: ["A paris", "B tokyo"], validation: CAPITALS })).toMatchObject({
      points: 2,
      maxPoints: 2,
      correct: true,
    });
  });

  test("the right pairings PLUS a wrong one is not correct, though the points reach the top", () => {
    // The hole this function exists for. The mapping enumerates only the correct pairings out
    // of every item × every target, so the arithmetic alone cannot tell this from a clean
    // answer — it sums to 2 either way. Being correct is the exact set.
    const s = scorePairs({
      response: ["A paris", "B tokyo", "A tokyo"],
      validation: CAPITALS,
    });
    expect(s.points).toBe(2);
    expect(s.correct).toBe(false);
  });

  test("half the pairings is half the marks", () => {
    expect(scorePairs({ response: ["A paris"], validation: CAPITALS })).toMatchObject({
      points: 1,
      correct: false,
    });
  });

  test("a wrong pairing earns nothing and is not correct", () => {
    expect(scorePairs({ response: ["A tokyo", "B paris"], validation: CAPITALS })).toMatchObject({
      points: 0,
      correct: false,
    });
  });

  test("a pairing the author never enumerated still gets an outcome to mark", () => {
    // Without an entry the renderer has nothing to hang a ✗ on, and the candidate sees a row
    // that is neither right nor wrong.
    const s = scorePairs({ response: ["A tokyo"], validation: CAPITALS });
    expect(s.options?.["A tokyo"]).toMatchObject({ selected: true, points: 0, correct: false });
  });

  test("an empty response scores zero without throwing", () => {
    expect(scorePairs({ response: undefined, validation: CAPITALS })).toMatchObject({
      points: 0,
      correct: false,
      maxPoints: 2,
    });
  });

  test("under match-correct the whole set earns one point, and anything else nothing", () => {
    const exact: Validation = {
      responseProcessing: "match_correct",
      cardinality: "multiple",
      baseType: "directedPair",
      points: 1,
      correctResponse: ["A paris", "B tokyo"],
    };
    expect(scorePairs({ response: ["B tokyo", "A paris"], validation: exact })).toMatchObject({
      points: 1,
      correct: true,
    });
    expect(scorePairs({ response: ["A paris"], validation: exact })).toMatchObject({ points: 0 });
    expect(
      scorePairs({ response: ["A paris", "B tokyo", "A tokyo"], validation: exact }),
    ).toMatchObject({ points: 0 });
  });

  test("scoreInteraction dispatches on the declared baseType", () => {
    expect(
      scoreInteraction({
        interaction: { type: "match" },
        validation: CAPITALS,
        response: ["A paris", "B tokyo", "A tokyo"],
      }),
    ).toMatchObject({ correct: false });
  });
});
