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
  operationSteps,
  connectionBackends,
  credentialOf,
  MAX_CONDITIONAL_ATTEMPTS,
  writesOutsideCommandControl,
  artifactRegistryVersion,
  commandArtifactRegistryVersion
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

// v9 (C5a, docs/c5-l0013-commands-plan.md): a service-credential, item-scoped
// function, conditional steps, and v8 kept for artifacts and execution.
// v10 (C5d, docs/c5d-refusal-and-hold-plan.md decision 3): the `refusal`
// step, purpose `record`, and v9 and v8 kept for artifacts and execution.
describe("registry v10", () => {
  it("is version 10, with v9 and v8 in the window and their artifacts compatible", () => {
    expect(REGISTRY_VERSION).toBe(10);
    expect(REGISTRY_WINDOW).toEqual([9, 8]);
    expect(ARTIFACT_COMPATIBLE_VERSIONS).toEqual([9, 8]);
    for (const v of [10, 9, 8]) {
      expect(isAcceptedRegistryVersion(v)).toBe(true);
      expect(isArtifactCompatible(v)).toBe(true);
    }
    expect(isAcceptedRegistryVersion(7)).toBe(false);
    expect(isArtifactCompatible(7)).toBe(false);
    // A registry-9 Broker (window [8]) refuses a v10 token: why Broker goes first.
    expect(isAcceptedRegistryVersion(10, { current: 9, window: [8] })).toBe(false);
  });

  it("registers gcs.put-thumbnail's `refusal` step, purpose `record`, needing no predecessor", () => {
    const op = "gcs.put-thumbnail";
    expect(operationSteps(op)?.at(-1)).toEqual({ id: "refusal", purpose: "record" });
    expect(isStepRegistered({ op, step: "refusal", purpose: "record" })).toBe(true);
    expect(isStepRegistered({ op, step: "refusal", purpose: "record", after: null })).toBe(true);
    // Only with its own purpose, once, and on no other operation.
    expect(isStepRegistered({ op, step: "refusal", purpose: "dispatch" })).toBe(false);
    expect(isStepRegistered({ op, step: "refusal", purpose: "replay" })).toBe(false);
    expect(isStepRegistered({ op, step: "refusal", purpose: "record", attempt: 2 })).toBe(false);
    expect(isStepRegistered({ op, step: "receipt", purpose: "record" })).toBe(false);
    expect(isStepRegistered({ op, step: "publish", purpose: "record" })).toBe(false);
    for (const other of ["learnosity.write-items", "learnosity.sign-items-preview", "learnosity.sign-questions-preview"]) {
      expect(isStepRegistered({ op: other, step: "refusal", purpose: "record" })).toBe(false);
      expect((operationSteps(other) ?? []).some(s => s.purpose === "record")).toBe(false);
    }
  });

  it("changes no function's meaning, so artifacts bind exactly as under v9", () => {
    for (const fns of Object.values(PROTECTED_FUNCTIONS)) {
      for (const spec of Object.values(fns)) expect(spec.meaningSince).toBeLessThanOrEqual(9);
    }
    const l0176 = [{ lang: "0176", code: { 1: { tag: "NUM", elts: ["1"] }, root: 1 } }];
    const l0013 = [{ lang: "0013", code: { 1: { tag: "SNAP", elts: [] }, root: 1 } }];
    expect(artifactRegistryVersion(l0176)).toBe(8);
    expect(artifactRegistryVersion(l0013)).toBe(9);
    expect(artifactRegistryVersion(l0176)).toBe(artifactRegistryVersion(l0176, { current: 9, compatible: [8] }));
    expect(artifactRegistryVersion(l0013)).toBe(artifactRegistryVersion(l0013, { current: 9, compatible: [8] }));
  });
});

describe("registry v9", () => {
  it("registers L0013's snap: write, service credential, item scope, never delegable", () => {
    expect(Object.keys(PROTECTED_FUNCTIONS["0013"])).toEqual(["snap"]);
    expect(PROTECTED_FUNCTIONS["0013"].snap).toEqual({
      backend: "gcs",
      kind: "write",
      ops: ["gcs.put-thumbnail"],
      tags: ["SNAP"],
      implicit: false,
      delegable: false,
      viewSafe: false,
      credential: "service",
      scope: "item",
      // Dated at C5d's activation; nothing executes under it before then.
      publicCapture: { since: null },
      writesOutsideCommands: true,
      meaningSince: 9,
    });
    expect(OPERATIONS["gcs.put-thumbnail"]).toMatchObject({ backend: "gcs", kind: "write", credential: "service" });
    expect(Object.isFrozen(PROTECTED_FUNCTIONS["0013"].snap.publicCapture)).toBe(true);
  });

  it("leaves every v8 function and operation as it was", () => {
    expect(Object.keys(PROTECTED_FUNCTIONS["0176"]).sort()).toEqual(["init", "save-to-itembank"]);
    for (const spec of Object.values(PROTECTED_FUNCTIONS["0176"])) {
      expect(credentialOf(spec)).toBe("connection");
      expect((spec as Record<string, unknown>).scope).toBeUndefined();
      expect((spec as Record<string, unknown>).publicCapture).toBeUndefined();
    }
    for (const op of ["learnosity.sign-items-preview", "learnosity.sign-questions-preview", "learnosity.write-items"]) {
      expect(credentialOf(OPERATIONS[op])).toBe("connection");
      for (const step of operationSteps(op) ?? []) {
        expect(step.conditional).toBeUndefined();
        expect(step.attempts).toBeUndefined();
      }
    }
  });

  it("matches a function's credential to its operation's", () => {
    for (const fns of Object.values(PROTECTED_FUNCTIONS)) {
      for (const spec of Object.values(fns)) {
        for (const op of spec.ops) expect(credentialOf(OPERATIONS[op])).toBe(credentialOf(spec));
        // Only a service function has an item scope, and only an item-scoped one
        // a public-capture exception; a service function is never delegable.
        if (credentialOf(spec) === "service") {
          expect((spec as Record<string, unknown>).scope).toBe("item");
          expect(spec.delegable).toBe(false);
        } else {
          expect((spec as Record<string, unknown>).publicCapture).toBeUndefined();
        }
      }
    }
  });

  it("lets snap name its operation only against its own backend", () => {
    const snap = { lang: "0013", fn: "snap", op: "gcs.put-thumbnail" };
    expect(isOperationAllowed({ ...snap, backend: "gcs" })).toBe(true);
    expect(isOperationAllowed({ ...snap, lang: "L0013", backend: "gcs" })).toBe(true);
    // Never through a connection's backend, never another operation.
    expect(isOperationAllowed({ ...snap, backend: "learnosity" })).toBe(false);
    expect(isOperationAllowed({ ...snap, op: "learnosity.write-items", backend: "learnosity" })).toBe(false);
    // And no connection function reaches it.
    expect(isOperationAllowed({ lang: "0176", fn: "save-to-itembank", op: "gcs.put-thumbnail", backend: "gcs" })).toBe(false);
    expect(isOperationAllowed({ lang: "0176", fn: "save-to-itembank", op: "gcs.put-thumbnail", backend: "learnosity" })).toBe(false);
  });

  it("offers only connection backends for connections", () => {
    expect(connectionBackends()).toEqual(["learnosity"]);
    expect(connectionBackends()).not.toContain("gcs");
  });

  it("keeps snap out of previews, views and implicit compiles, and in the compiler's config", () => {
    expect(systemPreviewFunctionsForLang("0013")).toEqual([]);
    expect(viewSafeFunctionsForLang("0013")).toEqual([]);
    expect(compilerConfigForLang("0013")).toEqual({ protectedFunctions: { SNAP: { fn: "snap", kind: "write" } }, implicitProtectedFunctions: [] });
  });

  it("requires protection, and so no shared cache, exactly for an L0013 task that snaps", () => {
    expect(taskRequiresProtected({ lang: "0013", code: { 1: { tag: "SNAP", elts: [] }, root: 1 } })).toBe(true);
    expect(taskRequiresProtected({ lang: "0013", code: { 1: { tag: "NUM", elts: ["1"] }, root: 1 } })).toBe(false);
    expect(taskRequiresProtected({ lang: "0000", code: { 1: { tag: "SNAP", elts: [] }, root: 1 } })).toBe(false);
  });
});

// C5 plan decision 5: a conditional step may be authorized again after a
// failed precondition, as numbered attempts; no other step may.
// Registry 9: writes that can occur outside Policy/Broker command control.
describe("writesOutsideCommands", () => {
  it("marks snap, whose legacy path uploads by itself outside a command, and nothing else", () => {
    const marked = Object.entries(PROTECTED_FUNCTIONS).flatMap(([lang, fns]) =>
      Object.entries(fns).filter(([, spec]) => (spec as { writesOutsideCommands?: true }).writesOutsideCommands === true).map(([fn]) => `${lang}/${fn}`));
    expect(marked).toEqual(["0013/snap"]);
  });

  it("answers per language, however its id is written", () => {
    for (const lang of ["0013", "L0013", "13", "l0013"]) expect(writesOutsideCommandControl(lang)).toBe(true);
    for (const lang of ["0176", "L0176", "0000", "0185", "9999", null, undefined]) expect(writesOutsideCommandControl(lang)).toBe(false);
  });
});

describe("conditional steps", () => {
  const op = "gcs.put-thumbnail";

  it("declares every conditional step as a dispatch with 2..MAX attempts", () => {
    for (const name of Object.keys(OPERATIONS)) {
      for (const s of operationSteps(name) ?? []) {
        if (s.conditional === undefined) {
          expect(s.attempts).toBeUndefined();
          continue;
        }
        expect(s.conditional).toBe(true);
        expect(s.purpose).toBe("dispatch");
        expect(Number.isInteger(s.attempts)).toBe(true);
        expect(s.attempts).toBeGreaterThanOrEqual(2);
        expect(s.attempts).toBeLessThanOrEqual(MAX_CONDITIONAL_ATTEMPTS);
      }
    }
    expect(operationSteps(op)?.map(s => `${s.id}:${s.purpose}`)).toEqual(["publish:dispatch", "receipt:replay", "refusal:record"]);
    expect(operationSteps(op)?.[0]).toMatchObject({ conditional: true, attempts: 4 });
  });

  it("authorizes attempts 1..4 of publish, each after the one before", () => {
    expect(isStepRegistered({ op, step: "publish", purpose: "dispatch" })).toBe(true);
    expect(isStepRegistered({ op, step: "publish", purpose: "dispatch", after: null, attempt: 1 })).toBe(true);
    for (const attempt of [2, 3, 4]) {
      expect(isStepRegistered({ op, step: "publish", purpose: "dispatch", after: "publish", attempt })).toBe(true);
    }
    expect(isStepRegistered({ op, step: "receipt", purpose: "replay" })).toBe(true);
  });

  it("refuses a fifth attempt, a later attempt out of order, and a malformed attempt", () => {
    expect(isStepRegistered({ op, step: "publish", purpose: "dispatch", after: "publish", attempt: 5 })).toBe(false);
    expect(isStepRegistered({ op, step: "publish", purpose: "dispatch", after: null, attempt: 2 })).toBe(false);
    expect(isStepRegistered({ op, step: "publish", purpose: "dispatch", after: "receipt", attempt: 2 })).toBe(false);
    // Attempt 1 is the first: it follows nothing.
    expect(isStepRegistered({ op, step: "publish", purpose: "dispatch", after: "publish", attempt: 1 })).toBe(false);
    for (const attempt of [0, -1, 1.5, "2", null]) {
      expect(isStepRegistered({ op, step: "publish", purpose: "dispatch", after: "publish", attempt })).toBe(false);
    }
    expect(isStepRegistered({ op, step: "receipt", purpose: "replay", attempt: 2 })).toBe(false);
  });

  it("never lets an unconditional step be attempted twice (L0176 unchanged)", () => {
    const write = "learnosity.write-items";
    for (const attempt of [2, 3, 4]) {
      expect(isStepRegistered({ op: write, step: "questions", purpose: "dispatch", after: "questions", attempt })).toBe(false);
      expect(isStepRegistered({ op: write, step: "items", purpose: "dispatch", after: "items", attempt })).toBe(false);
      expect(isStepRegistered({ op: write, step: "items", purpose: "dispatch", after: "questions", attempt })).toBe(false);
      expect(isStepRegistered({ op: "learnosity.sign-items-preview", step: "sign", purpose: "sign", attempt })).toBe(false);
    }
    // Attempt 1, given or not, is the rule as before.
    expect(isStepRegistered({ op: write, step: "questions", purpose: "dispatch", attempt: 1 })).toBe(true);
    expect(isStepRegistered({ op: write, step: "items", purpose: "dispatch", after: "questions", attempt: 1 })).toBe(true);
  });
});

// The registry-9 API release (owner's review): an artifact's registry version
// comes from its chain, so API builds on either side of a bump bind it alike.
describe("artifactRegistryVersion", () => {
  const save = { lang: "0176", code: { 1: { tag: "SAVE_TO_ITEMBANK", elts: [] }, root: 1 } };
  const preview = { lang: "L0176", code: { 1: { tag: "NUM", elts: ["1"] }, root: 1 } };
  const snap = { lang: "0013", code: { 1: { tag: "SNAP", elts: [] }, root: 1 } };
  const plain = { lang: "0013", code: { 1: { tag: "NUM", elts: ["1"] }, root: 1 } };
  const fetch = { lang: "0185", code: { root: 1 } };

  it("declares each function's meaningSince, never past the registry", () => {
    for (const [lang, fns] of Object.entries(PROTECTED_FUNCTIONS)) {
      for (const [fn, spec] of Object.entries(fns)) {
        expect([lang, fn, Number.isInteger(spec.meaningSince) && spec.meaningSince <= REGISTRY_VERSION]).toEqual([lang, fn, true]);
      }
    }
    expect(PROTECTED_FUNCTIONS["0176"].init.meaningSince).toBe(8);
    expect(PROTECTED_FUNCTIONS["0176"]["save-to-itembank"].meaningSince).toBe(8);
    expect(PROTECTED_FUNCTIONS["0013"].snap.meaningSince).toBe(9);
  });

  it("binds an L0176 chain to 8, with or without other stages, under registry 9", () => {
    expect(artifactRegistryVersion([save])).toBe(8);
    expect(artifactRegistryVersion([preview])).toBe(8);
    expect(artifactRegistryVersion([save, fetch])).toBe(8);
  });

  it("binds a chain that snaps to 9, and one that doesn't to the oldest served", () => {
    expect(artifactRegistryVersion([snap])).toBe(9);
    expect(artifactRegistryVersion([save, snap])).toBe(9);
    expect(artifactRegistryVersion([plain])).toBe(8);
    expect(artifactRegistryVersion([fetch])).toBe(8);
  });

  it("is what a registry-8 build binds an L0176 chain to", () => {
    expect(artifactRegistryVersion([save], { current: 8, compatible: [] })).toBe(8);
    expect(() => artifactRegistryVersion([snap], { current: 8, compatible: [] })).toThrow();
  });
});

// The owner's review of #409: a command's artifact version comes from its
// recorded admission alone, so publication and materialization never need a
// fresh task lookup.
describe("commandArtifactRegistryVersion", () => {
  const save = { lang: "0176", modelDigest: "d", intents: [{ id: "i1", fn: "save-to-itembank", op: "learnosity.write-items", runtime: true }] };
  const preview = { lang: "0176", modelDigest: "d", intents: [] };
  const snap = { lang: "0013", modelDigest: "d", intents: [{ id: "i1", fn: "snap", op: "gcs.put-thumbnail", runtime: false, occurrences: ["n1"] }] };
  const plain = { lang: "0013", modelDigest: "d", intents: [] };
  const fetch = { lang: "0185", modelDigest: "d" };

  it("binds an L0176 command to 8 and one that snaps to 9", () => {
    expect(commandArtifactRegistryVersion({ stages: { s0: save, s1: fetch } })).toBe(8);
    expect(commandArtifactRegistryVersion({ stages: { s0: preview } })).toBe(8);
    expect(commandArtifactRegistryVersion({ stages: { s0: plain } })).toBe(8);
    expect(commandArtifactRegistryVersion({ stages: { s0: snap } })).toBe(9);
    expect(commandArtifactRegistryVersion({ stages: { s0: save, s1: snap } })).toBe(9);
  });

  it("agrees with the tasks' version for the same chain", () => {
    const tasks = {
      save: { lang: "0176", code: { 1: { tag: "SAVE_TO_ITEMBANK", elts: [] }, root: 1 } },
      snap: { lang: "0013", code: { 1: { tag: "SNAP", elts: [] }, root: 1 } },
    };
    expect(commandArtifactRegistryVersion({ stages: { s0: save } })).toBe(artifactRegistryVersion([tasks.save]));
    expect(commandArtifactRegistryVersion({ stages: { s0: snap } })).toBe(artifactRegistryVersion([tasks.snap]));
  });

  it("refuses without an admission, and a meaning newer than the registry", () => {
    expect(() => commandArtifactRegistryVersion(undefined)).toThrow();
    expect(() => commandArtifactRegistryVersion({ stages: {} })).toThrow();
    expect(commandArtifactRegistryVersion({ stages: { s0: save } }, { current: 8, compatible: [] })).toBe(8);
    expect(() => commandArtifactRegistryVersion({ stages: { s0: snap } }, { current: 8, compatible: [] })).toThrow();
  });

  // What the admission can't show is a function used without an intent. Only
  // a write acts under a command, and only through an admitted intent; every
  // other function is implicit (always counted). A tagged non-write function
  // would need its own record before this derivation could count it.
  it("relies on every non-implicit function being a write", () => {
    for (const [lang, fns] of Object.entries(PROTECTED_FUNCTIONS)) {
      for (const [fn, spec] of Object.entries(fns)) {
        expect([lang, fn, spec.implicit || spec.kind === "write"]).toEqual([lang, fn, true]);
      }
    }
  });
});
