import {
  OPERATIONS,
  PROTECTED_FUNCTIONS,
  REGISTRY_VERSION,
  compilerConfigForLang,
  isOperationAllowed,
  taskRequiresProtected
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
    expect(Object.isFrozen(PROTECTED_FUNCTIONS["0176"]["preview-itembank"].ops)).toBe(true);
    expect(() => {
      "use strict";
      PROTECTED_FUNCTIONS["0176"]["preview-itembank"].ops.push("learnosity.write-items");
    }).toThrow();
  });

  const base = { lang: "0176", backend: "learnosity", mode: "save" };

  describe("isOperationAllowed", () => {
    it("allows preview to sign Items and Questions previews", () => {
      expect(isOperationAllowed({ ...base, fn: "preview-itembank", op: "learnosity.sign-items-preview" })).toBe(true);
      expect(isOperationAllowed({ ...base, mode: "render", fn: "preview-itembank", op: "learnosity.sign-items-preview" })).toBe(true);
      expect(isOperationAllowed({ ...base, fn: "preview-itembank", op: "learnosity.sign-questions-preview" })).toBe(true);
    });
    it("never lets preview sign Author requests or write items", () => {
      expect(isOperationAllowed({ ...base, fn: "preview-itembank", op: "learnosity.sign-author" })).toBe(false);
      expect(isOperationAllowed({ ...base, fn: "preview-itembank", op: "learnosity.write-items" })).toBe(false);
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

  describe("modes", () => {
    it("never mints a write outside save mode", () => {
      for (const mode of ["author", "read", "render", "verify", "corpus"]) {
        expect(isOperationAllowed({ ...base, mode, fn: "save-to-itembank", op: "learnosity.write-items" })).toBe(false);
      }
    });
    it("mints Author signatures only in author mode", () => {
      expect(isOperationAllowed({ ...base, mode: "author", fn: "author-itembank", op: "learnosity.sign-author" })).toBe(true);
      for (const mode of ["save", "read", "render", "verify", "corpus"]) {
        expect(isOperationAllowed({ ...base, mode, fn: "author-itembank", op: "learnosity.sign-author" })).toBe(false);
      }
    });
    it("rejects a missing or unknown mode", () => {
      expect(isOperationAllowed({ ...base, mode: undefined, fn: "save-to-itembank", op: "learnosity.write-items" })).toBe(false);
      expect(isOperationAllowed({ ...base, mode: "admin", fn: "preview-itembank", op: "learnosity.sign-items-preview" })).toBe(false);
    });
    it("gives every write exactly the save mode", () => {
      for (const fns of Object.values(PROTECTED_FUNCTIONS)) {
        for (const spec of Object.values(fns)) {
          if (spec.kind === "write") {
            expect([...spec.modes]).toEqual(["save"]);
          }
        }
      }
    });
  });

  describe("compilerConfigForLang", () => {
    it("keys explicit functions by tag and lists implicit ones", () => {
      const { protectedFunctions, implicitProtectedFunctions } = compilerConfigForLang("0176");
      expect(protectedFunctions.SAVE_TO_ITEMBANK).toEqual({ fn: "save-to-itembank", kind: "write", modes: ["save"] });
      expect(protectedFunctions.INIT.fn).toBe("preview-itembank");
      expect(protectedFunctions.AUTHOR).toEqual({ fn: "author-itembank", kind: "sign", modes: ["author"] });
      expect(implicitProtectedFunctions.map(f => f.fn)).toEqual(["preview-itembank"]);
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
