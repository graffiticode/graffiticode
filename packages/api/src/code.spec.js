// Characterization tests: these pin the CURRENT behavior of code.js (written
// before the TypeScript migration), not a judgment of it.
//
// objectToCode is not imported anywhere in the api today. As written, intern()
// only adds a node when `nodeMap[key] === 0`, but unseen keys are undefined, so
// no node is ever pooled and every non-empty input yields { root: 0 }. That is
// recorded here so a conversion cannot silently change it; fixing or deleting
// it is a separate, reviewed change.
import { objectToCode } from "./code.js";

describe("code/objectToCode", () => {
  it("returns null for empty or missing data", () => {
    expect(objectToCode(null)).toBeNull();
    expect(objectToCode(undefined)).toBeNull();
    expect(objectToCode({})).toBeNull();
    expect(objectToCode([])).toBeNull();
    expect(objectToCode("")).toBeNull();
  });

  it("returns { root: 0 } for any non-empty data", () => {
    expect(objectToCode({ a: 1, b: "x" })).toEqual({ root: 0 });
    expect(objectToCode([1, 2])).toEqual({ root: 0 });
    expect(objectToCode({ nested: { list: [true, null] } })).toEqual({ root: 0 });
  });

  it("returns a fresh object each call", () => {
    expect(objectToCode({ a: 1 })).not.toBe(objectToCode({ a: 1 }));
  });
});
