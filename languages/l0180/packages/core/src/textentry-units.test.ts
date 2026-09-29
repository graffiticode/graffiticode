// SPDX-License-Identifier: MIT
/**
 * Cutting text at its markers, and binding blanks to what they recognize.
 *
 * Most of this file is the checks. They are the point: naming the blank is what makes them
 * expressible, and a positional model — Learnosity's, and L0160's — cannot say which answer is
 * orphaned or whether the counts even agree.
 */
import { test, describe, expect } from "vitest";
import { cut } from "./textentry.js";

const right = (response: string, points?: number) => ({
  response,
  assess: { correct: true, ...(points !== undefined ? { points } : {}) },
});
const explained = (response: string, rationale: string) => ({ response, assess: { rationale } });
const capital = () => [{ id: "capital", responses: [right("Paris")] }];

describe("cutting the text", () => {
  test("splits into text and blanks, in order", () => {
    const { segments } = cut("The capital of France is {{capital}}.", capital(), false, "text-entry");
    expect(segments).toEqual([
      { text: "The capital of France is " },
      { id: "capital", blank: true },
      { text: "." },
    ]);
  });

  test("a marker at the very start or the very end leaves no empty run", () => {
    expect(cut("{{capital}} is the capital.", capital(), false, "t").segments).toEqual([
      { id: "capital", blank: true },
      { text: " is the capital." },
    ]);
    expect(cut("The capital is {{capital}}", capital(), false, "t").segments).toEqual([
      { text: "The capital is " },
      { id: "capital", blank: true },
    ]);
  });

  test("the answer binds by name, not by position", () => {
    // The clauses are reversed and the blanks are not. Under a positional model every answer
    // after the first would silently rebind; this is what the marker id exists for.
    const { mapping } = cut(
      "The capital of Italy is {{italy}}, and of France is {{france}}.",
      [
        { id: "france", responses: [right("Paris")] },
        { id: "italy", responses: [right("Rome")] },
      ],
      false,
      "text-entry",
    );
    expect(mapping.france.responses[0].response).toBe("Paris");
    expect(mapping.italy.responses[0].response).toBe("Rome");
  });
});

describe("what a blank recognizes", () => {
  test("a right answer defaults to one point", () => {
    const { mapping } = cut("{{a}}", [{ id: "a", responses: [right("Paris")] }], false, "t");
    expect(mapping.a.responses).toEqual([{ response: "Paris", correct: true, points: 1 }]);
    expect(mapping.a.points).toBe(1);
  });

  test("a blank is worth its BEST correct answer, not their sum", () => {
    // Only one answer can be typed, so summing would let a blank claim points nobody can earn.
    // `choice` sums because several options can be selected; the difference is cardinality.
    const { mapping } = cut(
      "{{a}}",
      [{ id: "a", responses: [right("Paris", 2), right("Paree", 1)] }],
      false,
      "t",
    );
    expect(mapping.a.points).toBe(2);
  });

  test("a near-miss earns partial credit", () => {
    const { mapping } = cut(
      "{{a}}",
      [{ id: "a", responses: [right("Paris"), { response: "paris, france", assess: { points: 1 } }] }],
      false,
      "t",
    );
    expect(mapping.a.responses[1]).toEqual({ response: "paris, france", points: 1 });
  });

  test("a recognized wrong answer carries its rationale and earns nothing", () => {
    const { mapping } = cut(
      "{{a}}",
      [{ id: "a", responses: [right("Paris"), explained("Lyon", "The largest city after Paris.")] }],
      false,
      "t",
    );
    expect(mapping.a.responses[1]).toEqual({
      response: "Lyon",
      points: 0,
      rationale: "The largest city after Paris.",
    });
  });

  test("a penalty is available, as it is on a choice option", () => {
    const { mapping } = cut(
      "{{a}}",
      [{ id: "a", responses: [right("Paris"), { response: "London", assess: { points: -1 } }] }],
      false,
      "t",
    );
    expect(mapping.a.responses[1].points).toBe(-1);
  });

  test("case sensitivity resolves onto the blank, overridable", () => {
    const { mapping } = cut(
      "{{a}} {{b}}",
      [
        { id: "a", responses: [right("NASA")], caseSensitive: true },
        { id: "b", responses: [right("Cape Canaveral")] },
      ],
      false,
      "t",
    );
    expect(mapping.a.caseSensitive).toBe(true);
    expect(mapping.b.caseSensitive).toBe(false);
  });
});

describe("the checks naming the blank makes possible", () => {
  const err = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e: any) {
      return String(e.message);
    }
    return "";
  };

  test("a marker no blank declares names it, and lists what is declared", () => {
    const msg = err(() => cut("The capital is {{captial}}.", capital(), false, "t"));
    expect(msg).toContain("{{captial}}");
    expect(msg).toContain("no blank declares that id");
    expect(msg).toContain("declares: capital");
  });

  test("a blank with no marker names it — the check L0176 cannot make", () => {
    const msg = err(() =>
      cut("The capital is {{capital}}.", [...capital(), { id: "spare", responses: [right("x")] }], false, "t"),
    );
    expect(msg).toContain('blank "spare"');
    expect(msg).toContain("nothing can be typed into it");
  });

  test("text with no marker renders nothing to fill in", () => {
    const msg = err(() => cut("The capital of France is Paris.", capital(), false, "t"));
    expect(msg).toContain("no {{…}} marker");
  });

  test("the same marker twice is one blank asked for twice", () => {
    const msg = err(() => cut("{{capital}} and {{capital}}.", capital(), false, "t"));
    expect(msg).toContain("appears twice");
  });

  test("two responses that normalize the same are ambiguous", () => {
    // Both would claim the same typed input, and the scorer would silently take whichever came
    // first. Naming it here is the only place an author can be told.
    const msg = err(() =>
      cut("{{a}}", [{ id: "a", responses: [right("Paris"), right("paris")] }], false, "t"),
    );
    expect(msg).toContain("same answer as response 1");
    expect(msg).toContain("once capitals are ignored");
    expect(msg).toContain("case-sensitive true");
  });

  test("the same two are fine when capitals are meant to matter", () => {
    const { mapping } = cut(
      "{{a}}",
      [{ id: "a", responses: [right("Paris"), explained("paris", "Proper nouns take a capital.")] }],
      true,
      "t",
    );
    expect(mapping.a.responses).toHaveLength(2);
  });

  test("a blank with no correct response cannot be scored", () => {
    const msg = err(() =>
      cut("{{a}}", [{ id: "a", responses: [explained("Lyon", "Not the capital.")] }], false, "t"),
    );
    expect(msg).toContain("no response is marked `correct`");
  });

  test("a response needs its answer and an assess", () => {
    expect(err(() => cut("{{a}}", [{ id: "a", responses: [{ assess: { correct: true } }] }], false, "t")))
      .toContain("needs the answer it recognizes");
    expect(err(() => cut("{{a}}", [{ id: "a", responses: [{ response: "Paris" }] }], false, "t")))
      .toContain("needs an `assess` saying what");
    expect(err(() => cut("{{a}}", [{ id: "a", responses: [{ response: "Paris", assess: {} }] }], false, "t")))
      .toContain("assess must say what it asserts");
  });

  test("a blank needs an id and at least one response", () => {
    expect(err(() => cut("{{a}}", [{ responses: [right("x")] }], false, "t"))).toContain("needs an `id`");
    expect(err(() => cut("{{a}}", [{ id: "a", responses: [] }], false, "t"))).toContain(
      "needs at least one response",
    );
  });

  test("braces in the passage that are not a marker are caught, not ignored", () => {
    const msg = err(() => cut("The set {{1,2}} has {{capital}} members.", capital(), false, "t"));
    expect(msg).toContain("no blank declares that id");
  });
});

describe("numeric blanks", () => {
  const err = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e: any) {
      return String(e.message);
    }
    return "";
  };
  const num = (id: string, responses: any[], extra: any = {}) => [
    { id, baseType: "float", responses, ...extra },
  ];
  const ok = (response: string) => ({ response, assess: { correct: true } });

  test("the base type and tolerance ride on the blank", () => {
    const { mapping } = cut("{{a}}", num("a", [ok("0.5")], { tolerance: 0.01 }), false, "t");
    expect(mapping.a.baseType).toBe("float");
    expect(mapping.a.tolerance).toBe(0.01);
    // Numbers have no case, so the string-only field is absent rather than defaulted.
    expect(mapping.a.caseSensitive).toBeUndefined();
  });

  test("a string blank still says so, rather than defaulting by absence", () => {
    const { mapping } = cut("{{a}}", [{ id: "a", responses: [ok("Paris")] }], false, "t");
    expect(mapping.a.baseType).toBe("string");
    expect(mapping.a.caseSensitive).toBe(false);
    expect(mapping.a.tolerance).toBeUndefined();
  });

  test("an answer that is not a number says what forms are understood", () => {
    const msg = err(() => cut("{{a}}", num("a", [ok("about half")]), false, "t"));
    expect(msg).toContain("is not a number this can compare");
    expect(msg).toContain("1/2");
    expect(msg).toContain("Expressions, units");
  });

  test("integer refuses a fractional answer", () => {
    const msg = err(() =>
      cut("{{a}}", [{ id: "a", baseType: "integer", responses: [ok("3.5")] }], false, "t"),
    );
    expect(msg).toContain("is not a whole number");
    expect(msg).toContain('base-type "float"');
  });

  test("case-sensitive on a number, and tolerance on text, are both refused", () => {
    expect(
      err(() => cut("{{a}}", num("a", [ok("1")], { caseSensitive: true }), false, "t")),
    ).toContain("numbers have no case");
    expect(
      err(() => cut("{{a}}", [{ id: "a", responses: [ok("Paris")], tolerance: 0.1 }], false, "t")),
    ).toContain("it is how close a NUMBER may be");
  });

  test("a negative tolerance is refused", () => {
    expect(err(() => cut("{{a}}", num("a", [ok("1")], { tolerance: -1 }), false, "t"))).toContain(
      "is negative",
    );
  });

  test("two answers that are the same number collide, however written", () => {
    const msg = err(() => cut("{{a}}", num("a", [ok("0.5"), ok("0.50")]), false, "t"));
    expect(msg).toContain("is the same answer as response 1");
  });

  test("a fraction collides with its decimal", () => {
    const msg = err(() => cut("{{a}}", num("a", [ok("0.5"), ok("1/2")]), false, "t"));
    expect(msg).toContain("is the same answer as response 1");
  });

  test("input-formats narrows what may be typed, and is emitted expanded", () => {
    const { mapping } = cut("{{a}}", num("a", [ok("0.5")], { inputFormats: ["fraction"] }), false, "t");
    expect(mapping.a.inputFormats).toEqual(["fraction"]);
  });

  test("the default accepts every form, and says so by absence", () => {
    // `numeric` is the umbrella, so it expands to all three and then earns no key at all —
    // the same rule tolerance follows. A field that is always present says nothing.
    for (const formats of [undefined, ["numeric"]]) {
      const { mapping } = cut("{{a}}", num("a", [ok("0.5")], { inputFormats: formats }), false, "t");
      expect(mapping.a.inputFormats, String(formats)).toBeUndefined();
    }
  });

  test("several forms may be listed, in a stable order", () => {
    const { mapping } = cut(
      "{{a}}",
      num("a", [ok("0.5")], { inputFormats: ["scientific", "decimal"] }),
      false,
      "t",
    );
    expect(mapping.a.inputFormats).toEqual(["decimal", "scientific"]);
  });

  test("numeric beside a particular form is a contradiction, not a widening", () => {
    const msg = err(() =>
      cut("{{a}}", num("a", [ok("0.5")], { inputFormats: ["numeric", "fraction"] }), false, "t"),
    );
    expect(msg).toContain("already means every form");
    expect(msg).toContain("`fraction`");
  });

  test("input-formats on a text blank is refused", () => {
    const msg = err(() =>
      cut("{{a}}", [{ id: "a", responses: [ok("Paris")], inputFormats: ["fraction"] }], false, "t"),
    );
    expect(msg).toContain("how a NUMBER may be written");
  });

  test("the authored answer is not constrained by input-formats", () => {
    // It says what may be TYPED. Asking for a fraction while writing the key as 0.5 is the
    // ordinary case, and refusing it would force authors to write keys they do not mean.
    expect(err(() => cut("{{a}}", num("a", [ok("0.5")], { inputFormats: ["fraction"] }), false, "t"))).toBe("");
  });

  test("a repeating answer with no way to reach it is refused", () => {
    // The trap this closes: it compiles, it grades, and every decimal a student types is
    // wrong with nothing said. A right answer marked wrong in silence is the failure the
    // whole numeric feature exists to remove, so it must not survive at the default.
    const msg = err(() => cut("{{a}}", num("a", [ok("1/3")]), false, "t"));
    expect(msg).toContain("has no exact decimal form");
    expect(msg).toContain('input-formats [ "fraction" ]');
    expect(msg).toContain("`tolerance`");
  });

  test("asking for a fraction is one way out, a tolerance the other", () => {
    expect(err(() => cut("{{a}}", num("a", [ok("1/3")], { inputFormats: ["fraction"] }), false, "t"))).toBe("");
    expect(err(() => cut("{{a}}", num("a", [ok("1/3")], { tolerance: 0.001 }), false, "t"))).toBe("");
  });

  test("accepting decimals alongside fractions is not a way out", () => {
    // The decimal half would still be unreachable, so half the accepted forms grade silently.
    for (const formats of [["decimal"], ["fraction", "decimal"], ["scientific"]]) {
      expect(err(() => cut("{{a}}", num("a", [ok("1/3")], { inputFormats: formats }), false, "t")), String(formats))
        .toContain("has no exact decimal form");
    }
  });

  test("a fraction that does terminate needs neither", () => {
    for (const value of ["1/2", "3/4", "1/8", "7/20", "4/2"]) {
      expect(err(() => cut("{{a}}", num("a", [ok(value)]), false, "t")), value).toBe("");
    }
  });

  test("a repeating string is just a string, and nothing is claimed about it", () => {
    // Without `base-type` the answer is the literal text "1/3", compared as text. No decimal
    // is involved and there is nothing to refuse.
    expect(err(() => cut("{{a}}", [{ id: "a", responses: [ok("1/3")] }], false, "t"))).toBe("");
  });

  test("collision follows the tolerance, since that is what decides a match", () => {
    // 0.5 and 0.55 are 0.05 apart. At a tolerance of 0.1 each reaches the other, so one typed
    // value could match both; at 0.01 they are safely distinct.
    const near = [ok("0.5"), { response: "0.55", assess: { points: 1 } }];
    expect(err(() => cut("{{a}}", num("a", near, { tolerance: 0.1 }), false, "t"))).toContain(
      "within a tolerance of 0.1",
    );
    expect(err(() => cut("{{a}}", num("a", near, { tolerance: 0.01 }), false, "t"))).toBe("");
  });
});
