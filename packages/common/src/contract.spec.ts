// Contract v2's plan identity (W4): manifests checked for shape, the plan
// digest stable over canonical JSON, and the stage binding a session carries.
import { CONTRACT_VERSION, CONTRACT_VERSION_SCOPED, SUPPORTED_CONTRACT_VERSIONS, canonicalScopes, manifestProblems, pinnedStage, planDigest, scopeKey, scopeProblems, stageBinding, sameStage } from "./contract.js";
import { canonicalDigest } from "./canonical.js";

const hex = c => c.repeat(64);
const manifest = (over = {}) => ({
  stage: "s1",
  lang: "0176",
  sourceDigest: hex("a"),
  programDigest: hex("b"),
  optionsDigest: hex("c"),
  revision: "l0176-rmuxb8bkg-02e234",
  imageDigest: `sha256:${hex("d")}`,
  registryVersion: 6,
  requiredFunctions: ["save-to-itembank", "init"],
  ...over,
});

describe("contract v2", () => {
  it("is version 2, and versions 1 and 2 are supported", () => {
    expect(CONTRACT_VERSION).toBe(2);
    expect(SUPPORTED_CONTRACT_VERSIONS).toEqual([1, 2]);
  });

  it("checks a manifest's shape, field by field", () => {
    expect(manifestProblems(manifest(), "s1")).toEqual([]);
    expect(manifestProblems(manifest(), "s0")).toEqual(["stage"]);
    expect(manifestProblems(manifest({ lang: "176", programDigest: "x", revision: "Bad_Name", imageDigest: hex("d"), registryVersion: "6", requiredFunctions: ["init", "init"] })))
      .toEqual(["lang", "programDigest", "revision", "imageDigest", "registryVersion", "requiredFunctions"]);
    expect(manifestProblems(null)).toEqual(["manifest is not an object"]);
  });

  it("pins only the manifest's own fields, functions sorted, so the digest doesn't depend on order or extras", () => {
    const pinned = pinnedStage({ ...manifest(), extra: "dropped" } as any);
    expect(pinned).toEqual({ ...manifest(), requiredFunctions: ["init", "save-to-itembank"] });
    expect(sameStage(manifest(), manifest({ requiredFunctions: ["init", "save-to-itembank"] }))).toBe(true);
    expect(sameStage(manifest(), manifest({ optionsDigest: hex("e") }))).toBe(false);
  });

  it("digests a plan as SHA-256 over its canonical JSON", () => {
    const plan = { contractVersion: 2 as const, invocationId: "inv-1", taskIds: ["t0", "t1"], connectionId: "conn-1", inputDigest: hex("9"), registryVersion: 6, stages: [pinnedStage(manifest())] };
    expect(planDigest(plan)).toBe(canonicalDigest(plan));
    expect(planDigest({ ...plan, taskIds: ["t1", "t0"] })).not.toBe(planDigest(plan));
  });

  it("binds a session to everything the plan pins for its stage, except its position and registry", () => {
    expect(stageBinding(manifest())).toEqual({
      lang: "0176",
      sourceDigest: hex("a"),
      programDigest: hex("b"),
      optionsDigest: hex("c"),
      revision: "l0176-rmuxb8bkg-02e234",
      imageDigest: `sha256:${hex("d")}`,
      requiredFunctions: ["init", "save-to-itembank"],
    });
  });
});

// Computed with en_US.UTF-8 and da_DK.UTF-8: identical.
const GOLDEN_MIXED_CASE = "a24e22bdf4ad1e06cfd9893e82bf302eecd2cf01662970a0188c7a7be667b713";

// C5 plan decision 6: v3 plans name their scopes; nothing issues v3 yet.
describe("contract v3 types", () => {
  it("defines v3 without supporting it yet (Broker and Policy add it when they implement it)", () => {
    expect(CONTRACT_VERSION_SCOPED).toBe(3);
    expect(CONTRACT_VERSION).toBe(2);
    expect(SUPPORTED_CONTRACT_VERSIONS).not.toContain(3);
  });

  it("keeps a v2 plan's digest exactly as before", () => {
    const plan = { contractVersion: 2 as const, invocationId: "inv-1", taskIds: ["t0", "t1"], connectionId: "conn-1", inputDigest: hex("9"), registryVersion: 6, stages: [pinnedStage(manifest())] };
    // Computed at 64ee41e1, before v3 existed.
    expect(planDigest(plan)).toBe("5b48b71c1c05ec9a28803d5b69985e15a68141363124bf28eadc0c0684cae1f2");
  });

  it("checks a scope's shape", () => {
    expect(scopeProblems({ kind: "item", id: "wI9f3f1XtOWIe7TTJoKE" })).toEqual([]);
    expect(scopeProblems({ kind: "connection", id: "conn-686c62bc" })).toEqual([]);
    expect(scopeProblems({ kind: "user", id: "x" })).toEqual(["kind"]);
    expect(scopeProblems({ kind: "item", id: "" })).toEqual(["id"]);
    expect(scopeProblems({ kind: "item", id: "a/b" })).toEqual(["id"]);
    expect(scopeProblems({ kind: "item", id: "x", extra: 1 })).toEqual(["unknown fields: extra"]);
    expect(scopeProblems("item:x")).toEqual(["scope is not an object"]);
    expect(scopeProblems(null)).toEqual(["scope is not an object"]);
  });

  it("pins scopes sorted, each once, with only kind and id, so the digest doesn't depend on order", () => {
    const scopes = canonicalScopes([
      { kind: "item", id: "b" },
      { kind: "connection", id: "conn-1" },
      { kind: "item", id: "a" },
      { kind: "item", id: "b" },
    ]);
    expect(scopes).toEqual([{ kind: "connection", id: "conn-1" }, { kind: "item", id: "a" }, { kind: "item", id: "b" }]);
    expect(scopes.map(scopeKey)).toEqual(["connection:conn-1", "item:a", "item:b"]);
    expect(() => canonicalScopes([{ kind: "item", id: "" }])).toThrow(/malformed scope/);
    // Code-unit order, not locale order: upper case sorts before lower case.
    expect(canonicalScopes([{ kind: "item", id: "a" }, { kind: "item", id: "A" }, { kind: "item", id: "b" }, { kind: "item", id: "B" }, { kind: "item", id: "_" }, { kind: "item", id: "0" }]).map(scopeKey))
      .toEqual(["item:0", "item:A", "item:B", "item:_", "item:a", "item:b"]);
    expect(canonicalScopes([{ kind: "item", id: "A" }, { kind: "item", id: "a" }])).toEqual(canonicalScopes([{ kind: "item", id: "a" }, { kind: "item", id: "A" }]));
    const plan = (s) => ({ contractVersion: 3 as const, invocationId: "inv-1", taskIds: ["t0"], inputDigest: hex("9"), registryVersion: 9, scopes: canonicalScopes(s), stages: [] });
    expect(planDigest(plan([{ kind: "item", id: "b" }, { kind: "item", id: "a" }]))).toBe(planDigest(plan([{ kind: "item", id: "a" }, { kind: "item", id: "b" }])));
    expect(planDigest(plan([{ kind: "item", id: "a" }]))).not.toBe(planDigest(plan([{ kind: "item", id: "b" }])));
  });

  // The same scopes give the same digest on every machine, whatever its locale
  // (en-US and da-DK order "A" and "a" differently under localeCompare).
  it("digests mixed-case scopes to a fixed value", () => {
    const plan = { contractVersion: 3 as const, invocationId: "inv-1", taskIds: ["t0"], inputDigest: hex("a"), registryVersion: 9, stages: [], scopes: canonicalScopes([{ kind: "item", id: "a" }, { kind: "item", id: "A" }]) };
    expect(plan.scopes).toEqual([{ kind: "item", id: "A" }, { kind: "item", id: "a" }]);
    expect(planDigest(plan)).toBe(GOLDEN_MIXED_CASE);
  });
});
