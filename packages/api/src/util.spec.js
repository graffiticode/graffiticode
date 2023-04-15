import { getCompilerHost, getCompilerPort, isNonEmptyString } from "./util.js";

describe("util", () => {
  describe("getCompilerHost", () => {
    it("should return localhost if useLocalCompiles is true", () => {
      const config = { useLocalCompiles: true, hosts: {} };
      expect(getCompilerHost("L0", config)).toBe("localhost");
    });
    it("should return default if useLocalCompiles is false", () => {
      const config = { useLocalCompiles: false, hosts: {} };
      expect(getCompilerHost("L0", config)).toBe("l0.graffiticode.org");
    });
    it("should return override if hosts is set", () => {
      const config = { useLocalCompiles: false, hosts: { l0: "mycompiler.com" } };
      expect(getCompilerHost("L0", config)).toBe("mycompiler.com");
    });
  });
  describe("getCompilerPort", () => {
    it("should return localhost if useLocalCompiles is true", () => {
      const config = { useLocalCompiles: true, ports: {} };
      expect(getCompilerPort("L0", config)).toBe("50");
    });
    it("should return default if useLocalCompiles is false", () => {
      const config = { useLocalCompiles: false, ports: {} };
      expect(getCompilerPort("L0", config)).toBe("443");
    });
    it("should return override if ports is set", () => {
      const config = { useLocalCompiles: false, ports: { l0: "42" } };
      expect(getCompilerPort("L0", config)).toBe("42");
    });
  });
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
