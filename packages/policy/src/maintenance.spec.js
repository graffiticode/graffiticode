import { createProtectedSwitch, parseHardDisable } from "./maintenance.js";

describe("protected-execution switch", () => {
  const flag = value => async () => value;

  it("is on only when the flag says enabled: true", async () => {
    expect(await createProtectedSwitch({ readFlag: flag({ enabled: true }) }).state()).toMatchObject({ enabled: true, source: "flag" });
    for (const value of [{ enabled: false }, { enabled: "true" }, { enabled: 1 }, {}]) {
      expect(await createProtectedSwitch({ readFlag: flag(value) }).state()).toMatchObject({ enabled: false, source: "flag" });
    }
  });

  it("fails closed when the flag is missing or unreadable", async () => {
    expect(await createProtectedSwitch({ readFlag: flag(null) }).state()).toEqual({ enabled: false, source: "flag-missing" });
    const unreadable = createProtectedSwitch({ readFlag: async () => { throw new Error("firestore unavailable"); } });
    expect(await unreadable.state()).toEqual({ enabled: false, source: "flag-unreadable" });
  });

  it("lets a hard environment disable win over an enabled flag, without reading it", async () => {
    let reads = 0;
    const off = createProtectedSwitch({ hardDisabled: true, readFlag: async () => { reads++; return { enabled: true }; } });
    expect(await off.state()).toEqual({ enabled: false, source: "env-disabled" });
    expect(reads).toBe(0);
  });

  it("reuses a successful read for cacheMs, and never a failed one", async () => {
    let t = 0;
    let value = { enabled: true };
    let fail = false;
    let reads = 0;
    const s = createProtectedSwitch({
      cacheMs: 1000,
      now: () => t,
      readFlag: async () => {
        reads++;
        if (fail) throw new Error("unavailable");
        return value;
      }
    });
    expect((await s.state()).enabled).toBe(true);
    value = { enabled: false };
    t = 999;
    expect((await s.state()).enabled).toBe(true);
    t = 1000;
    expect((await s.state()).enabled).toBe(false);
    expect(reads).toBe(2);
    fail = true;
    t = 2000;
    expect(await s.state()).toEqual({ enabled: false, source: "flag-unreadable" });
    expect(await s.state()).toEqual({ enabled: false, source: "flag-unreadable" });
    expect(reads).toBe(4);
  });

  it("parses the hard disable strictly", () => {
    expect(parseHardDisable(undefined)).toBe(false);
    expect(parseHardDisable("")).toBe(false);
    expect(parseHardDisable("disabled")).toBe(true);
    for (const bad of ["off", "false", "enabled", "DISABLED"]) {
      expect(() => parseHardDisable(bad)).toThrow(/PROTECTED_EXECUTION/);
    }
  });

  it("needs a flag reader", () => {
    // @ts-expect-error deliberately missing
    expect(() => createProtectedSwitch({})).toThrow(/flag reader/);
  });
});
