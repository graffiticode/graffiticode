import { isNonEmptyString } from "./utils.js";

describe("utils", () => {
  describe("isNonEmptyString", () => {
    it("should return true for string", () => {
      expect(isNonEmptyString("foo")).toBe(true);
    });
    it("should return false for empty string", () => {
      expect(isNonEmptyString("")).toBe(false);
    });
    it("should return false for number", () => {
      expect(isNonEmptyString(42)).toBe(false);
    });
    it("should return false for boolean", () => {
      expect(isNonEmptyString(false)).toBe(false);
    });
  });
});
