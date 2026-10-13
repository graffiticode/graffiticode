import { CANONICAL_VECTORS, canonicalDigest, canonicalJSON } from "./canonical.js";

describe("canonical JSON", () => {
  it.each(CANONICAL_VECTORS.map(v => [...v]))("encodes %j", (value, json, digest) => {
    expect(canonicalJSON(value)).toBe(json);
    expect(canonicalDigest(value)).toBe(digest);
  });

  it("ignores key order and undefined members, and nothing else", () => {
    expect(canonicalDigest({ a: 1, b: [1, 2] })).toBe(canonicalDigest({ b: [1, 2], a: 1, c: undefined }));
    expect(canonicalDigest({ a: 1, b: [1, 2] })).not.toBe(canonicalDigest({ a: 1, b: [2, 1] }));
    expect(canonicalDigest({ a: "1" })).not.toBe(canonicalDigest({ a: 1 }));
  });

  it("keeps its vectors frozen", () => {
    expect(Object.isFrozen(CANONICAL_VECTORS)).toBe(true);
  });
});
