import {
  OPERATIONS,
  PROTECTED_FUNCTIONS,
  REGISTRY_VERSION,
  compilerConfigForLang,
  isOperationAllowed,
  systemPreviewFunctionsForLang,
  taskRequiresProtected,
  viewSafeFunctionsForLang
} from "./protected-registry.js";

describe("protected-registry", () => {
  it("has a version", () => {
    expect(Number.isInteger(REGISTRY_VERSION)).toBe(true);
  });

  it("names only known operations of the function's backend and kind", () => {
    for (const fns of Object.values(PROTECTED_FUNCTIONS)) {
      for (const spec of Object.values(fns)) {
        for (const op of spec.ops) {
          expect(OPERATIONS[op]).toBeDefined();
          expect(OPERATIONS[op].backend).toBe(spec.backend);
          expect(OPERATIONS[op].kind).toBe(spec.kind);
        }
      }
    }
  });

  // A permission is named for the language function it guards: the lexicon
  // name of its node tag (INIT is `init`, SAVE_TO_ITEMBANK is
  // `save-to-itembank`), so a grant reads the same as the program it allows.
  it("names each function after the language function it guards", () => {
    for (const fns of Object.values(PROTECTED_FUNCTIONS)) {
      for (const [fn, spec] of Object.entries(fns)) {
        expect(spec.tags.map(t => t.toLowerCase().replace(/_/g, "-"))).toContain(fn);
      }
    }
  });

  it("never makes an implicit function a write", () => {
    for (const fns of Object.values(PROTECTED_FUNCTIONS)) {
      for (const spec of Object.values(fns)) {
        if (spec.implicit) {
          expect(spec.kind).not.toBe("write");
        }
      }
    }
  });

  it("maps each tag to at most one function per language", () => {
    for (const fns of Object.values(PROTECTED_FUNCTIONS)) {
      const tags = Object.values(fns).flatMap(spec => spec.tags);
      expect(new Set(tags).size).toBe(tags.length);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(PROTECTED_FUNCTIONS["0176"].init.ops)).toBe(true);
    expect(() => {
      "use strict";
      PROTECTED_FUNCTIONS["0176"].init.ops.push("learnosity.write-items");
    }).toThrow();
  });

  const base = { lang: "0176", backend: "learnosity" };

  describe("isOperationAllowed", () => {
    it("allows preview to sign Items and Questions previews", () => {
      expect(isOperationAllowed({ ...base, fn: "init", op: "learnosity.sign-items-preview" })).toBe(true);
      expect(isOperationAllowed({ ...base, fn: "init", op: "learnosity.sign-questions-preview" })).toBe(true);
    });
    it("never lets preview sign Author requests or write items", () => {
      expect(isOperationAllowed({ ...base, fn: "init", op: "learnosity.sign-author" })).toBe(false);
      expect(isOperationAllowed({ ...base, fn: "init", op: "learnosity.write-items" })).toBe(false);
    });
    it("never lets save sign", () => {
      expect(isOperationAllowed({ ...base, fn: "save-to-itembank", op: "learnosity.sign-items-preview" })).toBe(false);
      expect(isOperationAllowed({ ...base, fn: "save-to-itembank", op: "learnosity.write-items" })).toBe(true);
    });
    it("rejects a wrong backend, language, unknown fn or op", () => {
      expect(isOperationAllowed({ ...base, backend: "other", fn: "save-to-itembank", op: "learnosity.write-items" })).toBe(false);
      expect(isOperationAllowed({ ...base, lang: "0158", fn: "save-to-itembank", op: "learnosity.write-items" })).toBe(false);
      expect(isOperationAllowed({ ...base, fn: "nope", op: "learnosity.write-items" })).toBe(false);
      expect(isOperationAllowed({ ...base, fn: "save-to-itembank", op: "toString" })).toBe(false);
    });
    it("accepts L-prefixed language ids", () => {
      expect(isOperationAllowed({ ...base, lang: "L0176", fn: "save-to-itembank", op: "learnosity.write-items" })).toBe(true);
    });
  });

  describe("no execution modes", () => {
    it("has no mode in any function's spec", () => {
      for (const fns of Object.values(PROTECTED_FUNCTIONS)) {
        for (const spec of Object.values(fns)) {
          expect(spec.modes).toBeUndefined();
        }
      }
    });
    it("allows Author signing only for the Author function, and never lets it write", () => {
      expect(isOperationAllowed({ ...base, fn: "author", op: "learnosity.sign-author" })).toBe(true);
      expect(isOperationAllowed({ ...base, fn: "author", op: "learnosity.write-items" })).toBe(false);
      expect(isOperationAllowed({ ...base, fn: "save-to-itembank", op: "learnosity.sign-author" })).toBe(false);
    });
    it("keeps Author non-delegable and out of reach of published views", () => {
      const author = PROTECTED_FUNCTIONS["0176"].author;
      expect(author.delegable).toBe(false);
      expect(author.viewSafe).toBe(false);
      expect(viewSafeFunctionsForLang("0176")).toEqual(["init"]);
    });
  });

  describe("systemPreviewFunctionsForLang", () => {
    it("is exactly the implicit, view-safe signing functions (preview only for 0176)", () => {
      expect(systemPreviewFunctionsForLang("0176")).toEqual(["init"]);
      expect(systemPreviewFunctionsForLang("L0176")).toEqual(["init"]);
    });
    it("never includes a write or Author signing", () => {
      for (const lang of Object.keys(PROTECTED_FUNCTIONS)) {
        for (const fn of systemPreviewFunctionsForLang(lang)) {
          const spec = PROTECTED_FUNCTIONS[lang][fn];
          expect(spec).toMatchObject({ kind: "sign", viewSafe: true, implicit: true });
          for (const op of spec.ops) {
            expect(OPERATIONS[op].kind).toBe("sign");
            expect(op).not.toBe("learnosity.sign-author");
          }
        }
      }
      expect(systemPreviewFunctionsForLang("0176")).not.toContain("save-to-itembank");
      expect(systemPreviewFunctionsForLang("0176")).not.toContain("author");
    });
    it("is empty for an unprotected language", () => {
      expect(systemPreviewFunctionsForLang("0002")).toEqual([]);
    });
  });

  describe("compilerConfigForLang", () => {
    it("keys explicit functions by tag and lists implicit ones", () => {
      const { protectedFunctions, implicitProtectedFunctions } = compilerConfigForLang("0176");
      expect(protectedFunctions.SAVE_TO_ITEMBANK).toEqual({ fn: "save-to-itembank", kind: "write" });
      expect(protectedFunctions.INIT.fn).toBe("init");
      expect(protectedFunctions.AUTHOR).toEqual({ fn: "author", kind: "sign" });
      expect(implicitProtectedFunctions.map(f => f.fn)).toEqual(["init"]);
    });
    it("is empty for an unprotected language", () => {
      expect(compilerConfigForLang("0002")).toEqual({ protectedFunctions: {}, implicitProtectedFunctions: [] });
    });
  });

  describe("taskRequiresProtected", () => {
    it("is true for every task of a language with an implicit function", () => {
      expect(taskRequiresProtected({ lang: "0176", code: { 1: { tag: "NUM", elts: ["1"] }, root: 1 } })).toBe(true);
    });
    it("is false for an unprotected language", () => {
      expect(taskRequiresProtected({ lang: "0000", code: { 1: { tag: "SAVE_TO_ITEMBANK", elts: [] }, root: 1 } })).toBe(false);
    });
  });
});
