import { CANONICAL_VECTORS } from "@graffiticode/common/canonical";
import { argsDigest, canonicalJSON } from "./index.js";

// The broker's args digest must reproduce the shared vectors exactly, or a
// token minted against one encoding never matches the payload it carries.
describe("broker args digest", () => {
  it.each(CANONICAL_VECTORS.map(v => [...v]))("matches the shared vector for %j", (value, json, digest) => {
    expect(canonicalJSON(value)).toBe(json);
    expect(argsDigest(value)).toBe(digest);
  });
});
