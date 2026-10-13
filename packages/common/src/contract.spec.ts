// Contract v2's plan identity (W4): manifests checked for shape, the plan
// digest stable over canonical JSON, and the stage binding a session carries.
import { CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSIONS, manifestProblems, pinnedStage, planDigest, stageBinding, sameStage } from "./contract.js";
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
