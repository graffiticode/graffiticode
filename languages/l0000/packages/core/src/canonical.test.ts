import { describe, test, expect } from "vitest";
import { argsDigest, canonicalJSON } from "@graffiticode/l0000";

// Shared vectors: these digests were computed by the broker's implementation
// (graffiticode packages/broker/src/canonical.js). If either side changes, an
// execution token minted by one would never match the payload the other sees.
const VECTORS: [unknown, string, string][] = [
  [{ b: 2, a: 1 }, '{"a":1,"b":2}', "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"],
  [
    { questions: [{ response_id: "q-0", type: "mcq", stimulus: 'Q é "x"' }], id: "t", skip: undefined },
    '{"id":"t","questions":[{"response_id":"q-0","stimulus":"Q é \\"x\\"","type":"mcq"}]}',
    "d5e95bc25861c09b8ddb35843b33f3d27aeef4f5a3853d8133c21897a9143e4b",
  ],
  [[1, "two", null, undefined, { z: [true, false], y: 1.5 }], '[1,"two",null,null,{"y":1.5,"z":[true,false]}]',
    "2f51203a604c465370f084c3f413c5ce3f11bd736f1507cb2a6b96b1d46e632d"],
  ["plain", '"plain"', "945603a8f587786b463c3f94fce115c0fae88fac2728cc96ddf5981cf7f61741"],
];

describe("canonical args digest matches the broker", () => {
  test.each(VECTORS)("%j", (value, json, digest) => {
    expect(canonicalJSON(value)).toBe(json);
    expect(argsDigest(value)).toBe(digest);
  });
});
