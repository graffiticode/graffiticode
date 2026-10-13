// SPDX-License-Identifier: MIT
/**
 * The one place a typed answer is compared to an authored one.
 *
 * Shared by the compiler and the scorer, so these cases stand for both. Before this module the
 * rule was written twice with a test asserting the two agreed; one implementation cannot
 * disagree with itself, and the drift that mattered — a collision the compiler refuses becoming
 * a silent first-match at score time — is now impossible rather than watched.
 */
import { test, describe, expect } from "vitest";
import { normalize, parseNumber, permittedFormats, sameNumber, terminates } from "./matching.js";

const n = (s: string) => parseNumber(s)?.value.toString();
const f = (s: string) => parseNumber(s)?.format;

describe("parseNumber accepts", () => {
  test("integers and a leading sign", () => {
    expect(n("8")).toBe("8");
    expect(n("-3")).toBe("-3");
    expect(n("+7")).toBe("7");
  });

  test("decimals, however written", () => {
    // The whole point: all of these are the same number, and string comparison said otherwise.
    expect(n("0.5")).toBe("0.5");
    expect(n(".5")).toBe("0.5");
    expect(n("0.50")).toBe("0.5");
    expect(n("0.500000")).toBe("0.5");
    expect(n("-0.25")).toBe("-0.25");
  });

  test("scientific notation", () => {
    expect(n("5e-1")).toBe("0.5");
    expect(n("-1.5E3")).toBe("-1500");
    expect(n("6.02e23")).toBe("6.02e+23");
  });

  test("simple fractions", () => {
    expect(n("1/2")).toBe("0.5");
    expect(n("3/4")).toBe("0.75");
    expect(n("-7/8")).toBe("-0.875");
    expect(n("4/2")).toBe("2");
  });

  test("thousands groupings", () => {
    expect(n("1,000")).toBe("1000");
    expect(n("1,234,567")).toBe("1234567");
    expect(n("1,000.25")).toBe("1000.25");
  });

  test("surrounding whitespace", () => {
    expect(n("  0.5  ")).toBe("0.5");
  });
});

describe("parseNumber rejects", () => {
  const rejected = [
    ["an expression", "1/2 + 1/3"],
    ["units", "5 cm"],
    ["a symbol", "x/2"],
    ["percent, which is ambiguous", "50%"],
    ["division by zero", "1/0"],
    ["a comma that is not a grouping", "1,2"],
    ["two slashes", "1/2/3"],
    ["words", "half"],
    ["nothing", "   "],
    ["a bare sign", "-"],
    ["a bare point", "."],
  ];
  for (const [why, input] of rejected) {
    test(`${why}: ${JSON.stringify(input)}`, () => {
      expect(parseNumber(input)).toBeNull();
    });
  }
});

describe("parseNumber reports how the number was written", () => {
  // The value is what scores; the form is what `input-formats` may constrain. Keeping both
  // is what lets a blank ask for a fraction and still compare in base 10.
  test("each form is named", () => {
    expect(f("0.5")).toBe("decimal");
    expect(f("1,000")).toBe("decimal");
    expect(f("1/2")).toBe("fraction");
    expect(f("5e-1")).toBe("scientific");
  });

  test("the same value can arrive in three forms", () => {
    for (const written of ["0.5", "1/2", "5e-1"]) {
      expect(n(written), written).toBe("0.5");
    }
    expect(new Set(["0.5", "1/2", "5e-1"].map(f)).size).toBe(3);
  });
});

describe("permittedFormats", () => {
  test("numeric means all of them, and is what an unconstrained blank gets", () => {
    expect(permittedFormats(["numeric"])).toEqual(["decimal", "fraction", "scientific"]);
    expect(permittedFormats(undefined)).toEqual(["decimal", "fraction", "scientific"]);
    expect(permittedFormats([])).toEqual(["decimal", "fraction", "scientific"]);
  });

  test("a subset is honoured in a stable order", () => {
    expect(permittedFormats(["fraction"])).toEqual(["fraction"]);
    expect(permittedFormats(["scientific", "decimal"])).toEqual(["decimal", "scientific"]);
  });
});

describe("terminates", () => {
  test("a literal decimal IS its own expansion, so it always does", () => {
    for (const s of ["0.5", "8", "-3", "1,000", "5e-1", "6.02e23"]) expect(terminates(s), s).toBe(true);
  });

  test("a fraction terminates when its denominator is made of 2s and 5s", () => {
    for (const s of ["1/2", "1/4", "1/8", "3/8", "1/5", "1/10", "7/20", "4/2", "0/3"]) {
      expect(terminates(s), s).toBe(true);
    }
  });

  test("and does not otherwise — which is the case nobody can type", () => {
    for (const s of ["1/3", "2/3", "1/6", "1/7", "5/12", "100/300"]) {
      expect(terminates(s), s).toBe(false);
    }
  });

  test("reduction happens first: 100/300 repeats, 4/2 does not", () => {
    // 300 has a 3 in it and 100/300 is a third; 2 divides 4 exactly. Testing the written
    // denominator rather than the reduced one would get both of these backwards.
    expect(terminates("100/300")).toBe(false);
    expect(terminates("4/2")).toBe(true);
  });

  test("what it cannot analyze is not refused", () => {
    // It decides whether to reject a program. A check that is unsure must not be the one to.
    for (const s of ["abc", "1/0", "", "5 cm"]) expect(terminates(s), s).toBe(true);
  });
});

describe("arithmetic is decimal, not binary", () => {
  test("0.1 + 0.2 equals 0.3, which is false in binary floating point", () => {
    // 0.1 + 0.2 === 0.30000000000000004 as JS numbers. That difference is small until it lands
    // on a tolerance boundary and decides a grade.
    expect(0.1 + 0.2 === 0.3).toBe(false);
    const sum = parseNumber("0.1")!.value.add(parseNumber("0.2")!.value);
    expect(sameNumber(sum, parseNumber("0.3")!.value)).toBe(true);
  });

  test("a third is a third", () => {
    expect(sameNumber(parseNumber("1/3")!.value, parseNumber("1/3")!.value)).toBe(true);
  });

  test("a rounded third is not, without a tolerance", () => {
    const third = parseNumber("1/3")!.value;
    expect(sameNumber(third, parseNumber("0.333")!.value)).toBe(false);
    expect(sameNumber(third, parseNumber("0.333")!.value, 0.001)).toBe(true);
  });
});

describe("sameNumber", () => {
  const d = (s: string) => parseNumber(s)!.value;

  test("exact when no tolerance is given, and that is already enough", () => {
    expect(sameNumber(d("0.5"), d("0.50"))).toBe(true);
    expect(sameNumber(d("0.5"), d("1/2"))).toBe(true);
    expect(sameNumber(d("0.5"), d("0.51"))).toBe(false);
  });

  test("a tolerance widens it symmetrically, and its edge is inclusive", () => {
    expect(sameNumber(d("0.51"), d("0.5"), 0.01)).toBe(true);
    expect(sameNumber(d("0.49"), d("0.5"), 0.01)).toBe(true);
    expect(sameNumber(d("0.511"), d("0.5"), 0.01)).toBe(false);
    expect(sameNumber(d("0.51"), d("0.5"), 0.001)).toBe(false);
  });
});

describe("normalize", () => {
  test("collapses surrounding and repeated whitespace", () => {
    expect(normalize("  Cape   Canaveral ", false)).toBe("cape canaveral");
  });

  test("case only when it is asked to matter", () => {
    expect(normalize("NASA", false)).toBe("nasa");
    expect(normalize("NASA", true)).toBe("NASA");
  });

  test("punctuation survives — the typed string IS the answer", () => {
    expect(normalize("can't", false)).toBe("can't");
    expect(normalize("cant", false)).not.toBe(normalize("can't", false));
  });
});
