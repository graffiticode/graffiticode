import {
  CACHE_CLASSES,
  COMPILE_ONLY,
  INTERPRETER_DECLARATIONS,
  INTERPRETER_MANIFEST_VERSION,
  capCacheClass,
  interpreterDeclarationFor,
  interpreterLangFor,
  manifestProblems,
  stricterCacheClass,
} from "./interpreter-manifest.js";

// A declaration set for the helpers' tests; the manifest itself declares none yet.
const DECLARED = {
  "0176": { interpreter: "interpreter", cacheCaps: { evaluate: "shared", present: "no-store" }, interprets: ["0158"] },
  "0182": { interpreter: "interpreter", cacheCaps: { evaluate: "private", present: "private" }, getOrCreate: true },
} as const;

describe("interpreter-manifest", () => {
  it("has its own version", () => {
    expect(Number.isInteger(INTERPRETER_MANIFEST_VERSION)).toBe(true);
    expect(INTERPRETER_MANIFEST_VERSION).toBeGreaterThan(0);
  });

  it("is itself valid", () => {
    expect(manifestProblems(INTERPRETER_DECLARATIONS)).toEqual([]);
  });

  it("treats an undeclared language as compile-only, with no cap beyond its own", () => {
    for (const lang of ["0176", "L0176", "176", "0000"]) {
      expect(interpreterDeclarationFor(lang)).toBe(COMPILE_ONLY);
    }
    expect(capCacheClass("immutable", "0000", "present")).toBe("immutable");
    expect(capCacheClass("no-store", "0000", "evaluate")).toBe("no-store");
  });

  it("declares L0184 and L0186 interpreters (C1), uncapped in both modes; L0000 stays compile-only until C7", () => {
    for (const lang of ["L0184", "0186"]) {
      expect(interpreterDeclarationFor(lang)).toEqual({ interpreter: "interpreter", cacheCaps: { evaluate: "immutable", present: "immutable" } });
    }
    expect(capCacheClass("immutable", "0184", "present")).toBe("immutable");
    expect(capCacheClass("shared", "0184", "evaluate")).toBe("shared");
    expect(Object.keys(INTERPRETER_DECLARATIONS)).toEqual(["0184", "0186"]);
  });

  it("finds a declaration by any spelling of the language", () => {
    expect(interpreterDeclarationFor("L0176", DECLARED)).toBe(DECLARED["0176"]);
    expect(interpreterDeclarationFor(176, DECLARED)).toBe(DECLARED["0176"]);
  });

  it("routes a producer to the language that declares it interprets it, else to itself", () => {
    expect(interpreterLangFor("L0158", DECLARED)).toBe("0176");
    expect(interpreterLangFor("0176", DECLARED)).toBe("0176");
    expect(interpreterLangFor("0184", DECLARED)).toBe("0184");
    expect(interpreterLangFor("0158")).toBe("0158");
  });

  it("orders cache classes from loosest to strictest", () => {
    expect(CACHE_CLASSES).toEqual(["immutable", "shared", "private", "no-store"]);
    expect(stricterCacheClass("shared", "private")).toBe("private");
    expect(stricterCacheClass("no-store", "immutable")).toBe("no-store");
    expect(stricterCacheClass("shared", "shared")).toBe("shared");
  });

  it("caps a result's class at its language's cap for the mode, and never loosens it", () => {
    expect(capCacheClass("immutable", "0176", "evaluate", DECLARED)).toBe("shared");
    expect(capCacheClass("immutable", "0176", "present", DECLARED)).toBe("no-store");
    expect(capCacheClass("private", "0176", "evaluate", DECLARED)).toBe("private");
    // A class the manifest doesn't know is the strictest.
    expect(capCacheClass("forever", "0184", "present", DECLARED)).toBe("no-store");
    expect(capCacheClass(undefined, "0184", "present", DECLARED)).toBe("no-store");
  });

  it("finds problems in a declaration set", () => {
    expect(manifestProblems(DECLARED)).toEqual([]);
    expect(manifestProblems({
      176: { interpreter: "interpreter", cacheCaps: { evaluate: "shared", present: "no-store" } },
      "0001": { interpreter: "maybe", cacheCaps: { evaluate: "forever" } },
      "0002": { interpreter: "interpreter", cacheCaps: { evaluate: "shared", present: "shared" }, interprets: ["0002", "abc", "0158"] },
      "0003": { interpreter: "interpreter", cacheCaps: { evaluate: "shared", present: "shared" }, interprets: ["0158"] },
      "0004": { interpreter: "compile-only", cacheCaps: { evaluate: "shared", present: "shared" }, getOrCreate: true },
      "0005": null,
    })).toEqual([
      "176: not a four-digit language id",
      "0001: interpreter must be \"compile-only\" or \"interpreter\"",
      "0001: cacheCaps.evaluate must be one of immutable, shared, private, no-store",
      "0001: cacheCaps.present must be one of immutable, shared, private, no-store",
      "0002: interprets itself",
      "0002: interprets abc, not a four-digit language id",
      "0158: interpreted by both 0002 and 0003",
      "0004: getOrCreate needs an interpreter",
      "0005: not a declaration",
    ]);
  });
});
