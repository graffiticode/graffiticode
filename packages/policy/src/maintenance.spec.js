import { admission, createProtectedSwitch, parseHardDisable } from "./maintenance.js";

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

  describe("canary", () => {
    const CANARY = { uid: "0xcanary", connectionId: "conn-canary" };
    const stateOf = async (value, opts = {}) => createProtectedSwitch({ readFlag: flag(value), ...opts }).state();

    it("is read from the flag only while it is off", async () => {
      expect((await stateOf({ enabled: false, canary: CANARY })).canary).toEqual(CANARY);
      expect((await stateOf({ enabled: true, canary: CANARY })).canary).toBeUndefined();
    });

    it("admits exactly the canary pair while off, and everyone while on", async () => {
      const off = await stateOf({ enabled: false, canary: CANARY });
      expect(admission(off, CANARY)).toBe("canary");
      expect(admission(off, { uid: "0xcanary", connectionId: "conn-other" })).toBeNull();
      expect(admission(off, { uid: "0xother", connectionId: "conn-canary" })).toBeNull();
      expect(admission(off, {})).toBeNull();
      expect(admission(off)).toBeNull();
      expect(admission(await stateOf({ enabled: true }), {})).toBe("enabled");
    });

    it("admits no one when the canary is malformed", async () => {
      for (const canary of [{ uid: "0xcanary" }, { connectionId: "conn-canary" }, { uid: 7, connectionId: "c" }, { uid: "a b", connectionId: "c" }, "0xcanary", null]) {
        const off = await stateOf({ enabled: false, canary });
        expect(off.canary).toBeNull();
        expect(admission(off, { uid: "undefined", connectionId: "undefined" })).toBeNull();
      }
    });

    it("admits no one under a hard disable, or with a missing or unreadable flag", async () => {
      expect(admission(await stateOf({ enabled: false, canary: CANARY }, { hardDisabled: true }), CANARY)).toBeNull();
      expect(admission(await stateOf(null), CANARY)).toBeNull();
      const unreadable = await createProtectedSwitch({ readFlag: async () => { throw new Error("x"); } }).state();
      expect(admission(unreadable, CANARY)).toBeNull();
    });
  });
});
