import {
  ARTIFACT_COMPATIBLE_VERSIONS,
  REGISTRY_WINDOW,
  isAcceptedRegistryVersion,
  isArtifactCompatible,
  OPERATIONS,
  PROTECTED_FUNCTIONS,
  REGISTRY_VERSION,
  compilerConfigForLang,
  isOperationAllowed,
  systemPreviewFunctionsForLang,
  taskRequiresProtected,
  viewSafeFunctionsForLang,
  isStepRegistered,
  operationSteps
} from "./protected-registry.js";

describe("protected-registry", () => {
  it("has a version", () => {
    expect(Number.isInteger(REGISTRY_VERSION)).toBe(true);
  });

  // P1 (docs/graffiticode-interpreter-plan.md): artifact compatibility across
  // registry versions is declared, and the default is incompatible.
  it("serves artifacts from the current version and only the versions it declares compatible", () => {
    expect(isArtifactCompatible(REGISTRY_VERSION)).toBe(true);
    for (const v of ARTIFACT_COMPATIBLE_VERSIONS) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeLessThan(REGISTRY_VERSION);
      expect(isArtifactCompatible(v)).toBe(true);
    }
    expect(isArtifactCompatible(REGISTRY_VERSION - 1, [])).toBe(false);
    expect(isArtifactCompatible(REGISTRY_VERSION - 1, [REGISTRY_VERSION - 1])).toBe(true);
    expect(isArtifactCompatible(REGISTRY_VERSION + 1, [REGISTRY_VERSION - 1])).toBe(false);
    expect(isArtifactCompatible(undefined, [REGISTRY_VERSION - 1])).toBe(false);
    expect(isArtifactCompatible(String(REGISTRY_VERSION))).toBe(false);
  });

  // P1b: the window names only earlier versions, and accepts nothing else.
  it("accepts the current version and only the earlier versions its window names", () => {
    for (const v of REGISTRY_WINDOW) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeLessThan(REGISTRY_VERSION);
      expect(isAcceptedRegistryVersion(v)).toBe(true);
    }
    expect(isAcceptedRegistryVersion(REGISTRY_VERSION)).toBe(true);
    const NEXT = REGISTRY_VERSION + 1;
    expect(isAcceptedRegistryVersion(REGISTRY_VERSION, { current: NEXT, window: [] })).toBe(false);
    expect(isAcceptedRegistryVersion(REGISTRY_VERSION, { current: NEXT, window: [REGISTRY_VERSION] })).toBe(true);
    expect(isAcceptedRegistryVersion(NEXT, { current: NEXT, window: [REGISTRY_VERSION] })).toBe(true);
    expect(isAcceptedRegistryVersion(REGISTRY_VERSION - 1, { current: NEXT, window: [REGISTRY_VERSION] })).toBe(false);
    expect(isAcceptedRegistryVersion(undefined, { current: NEXT, window: [REGISTRY_VERSION] })).toBe(false);
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
      // Deliberately mutates the frozen (readonly) list to prove it throws.
      (PROTECTED_FUNCTIONS["0176"].init.ops as string[]).push("learnosity.write-items");
    }).toThrow();
  });

  const base = { lang: "0176", backend: "learnosity" };

  describe("isOperationAllowed", () => {
    it("allows preview to sign Items and Questions previews", () => {
      expect(isOperationAllowed({ ...base, fn: "init", op: "learnosity.sign-items-preview" })).toBe(true);
      expect(isOperationAllowed({ ...base, fn: "init", op: "learnosity.sign-questions-preview" })).toBe(true);
    });
    it("never lets preview write items", () => {
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
          // Execution modes were removed; no spec may carry one.
          expect((spec as Record<string, unknown>).modes).toBeUndefined();
        }
      }
    });
  });

  // v7 (AUTHOR-01, closed by removal): Graffiticode signs no Author sessions.
  describe("no Author signing", () => {
    it("registers no Author function or operation, in any language", () => {
      expect(REGISTRY_VERSION).toBeGreaterThanOrEqual(7);
      expect(Object.keys(PROTECTED_FUNCTIONS["0176"]).sort()).toEqual(["init", "save-to-itembank"]);
      expect(Object.keys(OPERATIONS)).not.toContain("learnosity.sign-author");
      for (const fns of Object.values(PROTECTED_FUNCTIONS)) {
        for (const spec of Object.values(fns)) expect(spec.ops).not.toContain("learnosity.sign-author");
      }
      expect(isOperationAllowed({ ...base, fn: "author", op: "learnosity.sign-author" })).toBe(false);
      expect(isOperationAllowed({ ...base, fn: "init", op: "learnosity.sign-author" })).toBe(false);
      expect(compilerConfigForLang("0176").protectedFunctions.AUTHOR).toBeUndefined();
      expect(viewSafeFunctionsForLang("0176")).toEqual(["init"]);
    });
  });

  describe("systemPreviewFunctionsForLang", () => {
    it("is exactly the implicit, view-safe signing functions (preview only for 0176)", () => {
      expect(systemPreviewFunctionsForLang("0176")).toEqual(["init"]);
      expect(systemPreviewFunctionsForLang("L0176")).toEqual(["init"]);
    });
    it("never includes a write", () => {
      for (const lang of Object.keys(PROTECTED_FUNCTIONS)) {
        for (const fn of systemPreviewFunctionsForLang(lang)) {
          const spec = PROTECTED_FUNCTIONS[lang][fn];
          expect(spec).toMatchObject({ kind: "sign", viewSafe: true, implicit: true });
          for (const op of spec.ops) {
            expect(OPERATIONS[op].kind).toBe("sign");
          }
        }
      }
      expect(systemPreviewFunctionsForLang("0176")).not.toContain("save-to-itembank");
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

// v6: the registered execution steps W2's live authorization checks (spec API-02).
describe("registered execution steps", () => {
  it("gives every operation steps whose purposes match its kind", () => {
    for (const [op, spec] of Object.entries(OPERATIONS)) {
      const steps = operationSteps(op) ?? [];
      expect(steps.length).toBeGreaterThan(0);
      expect(new Set(steps.map(s => s.id)).size).toBe(steps.length);
      if (spec.kind === "sign") expect(steps.map(s => s.purpose)).toEqual(["sign"]);
      if (spec.kind === "write") {
        expect(steps.some(s => s.purpose === "dispatch")).toBe(true);
        expect(steps.filter(s => s.purpose === "replay")).toHaveLength(1);
        expect(steps.some(s => s.purpose === "sign")).toBe(false);
      }
    }
    expect(operationSteps("learnosity.write-items")?.map(s => `${s.id}:${s.purpose}`)).toEqual(["questions:dispatch", "items:dispatch", "receipt:replay"]);
    expect(operationSteps("learnosity.no-such-op")).toBeNull();
    expect(Object.isFrozen(operationSteps("learnosity.write-items"))).toBe(true);
  });

  it("registers a step only with its own purpose, and dispatch steps only in order", () => {
    const op = "learnosity.write-items";
    expect(isStepRegistered({ op, step: "questions", purpose: "dispatch" })).toBe(true);
    expect(isStepRegistered({ op, step: "items", purpose: "dispatch", after: "questions" })).toBe(true);
    expect(isStepRegistered({ op, step: "receipt", purpose: "replay" })).toBe(true);
    // Out of order, repeated, wrong purpose, or unknown.
    expect(isStepRegistered({ op, step: "items", purpose: "dispatch" })).toBe(false);
    expect(isStepRegistered({ op, step: "questions", purpose: "dispatch", after: "questions" })).toBe(false);
    expect(isStepRegistered({ op, step: "items", purpose: "dispatch", after: "items" })).toBe(false);
    expect(isStepRegistered({ op, step: "questions", purpose: "replay" })).toBe(false);
    expect(isStepRegistered({ op, step: "receipt", purpose: "dispatch" })).toBe(false);
    expect(isStepRegistered({ op, step: "delete", purpose: "dispatch" })).toBe(false);
    expect(isStepRegistered({ op: "learnosity.sign-items-preview", step: "sign", purpose: "sign" })).toBe(true);
    expect(isStepRegistered({ op: "learnosity.sign-items-preview", step: "sign", purpose: "dispatch" })).toBe(false);
    expect(isStepRegistered({ op: "learnosity.sign-items-preview", step: "receipt", purpose: "replay" })).toBe(false);
    expect(isStepRegistered({ op: "learnosity.sign-author", step: "sign", purpose: "sign" })).toBe(false);
    expect(isStepRegistered({ op: "nope", step: "sign", purpose: "sign" })).toBe(false);
  });
});
