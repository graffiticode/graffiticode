import { parseCallers, parseSystemConnections, refuseRemovedSettings, requireEnv, parseSystemSigningLimits } from "./config.js";
import { createTokenBucket } from "./rate-limit.js";

describe("service configuration", () => {
  it("parses a caller map", () => {
    const callers = parseCallers(JSON.stringify({
      "l0176-run@graffiticode.iam.gserviceaccount.com": { role: "compiler", lang: "0176", extra: "ignored" },
      "console-run@graffiticode-app.iam.gserviceaccount.com": { role: "console" },
      "broker-run@graffiticode.iam.gserviceaccount.com": { role: "broker", lang: "0176" }
    }));
    expect(callers["l0176-run@graffiticode.iam.gserviceaccount.com"]).toEqual({ role: "compiler", lang: "0176" });
    // A broker holds no language: it executes for every compiler.
    expect(callers["broker-run@graffiticode.iam.gserviceaccount.com"]).toEqual({ role: "broker" });
    expect(Object.isFrozen(callers)).toBe(true);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["a user email", JSON.stringify({ "someone@example.com": { role: "console" } })],
    ["an unknown role", JSON.stringify({ "x@p.iam.gserviceaccount.com": { role: "admin" } })],
    ["a compiler without a language", JSON.stringify({ "x@p.iam.gserviceaccount.com": { role: "compiler" } })]
  ])("refuses %s", (_, json) => {
    expect(() => parseCallers(json)).toThrow();
  });

  it("parses system connections, and treats an absent or empty setting as none", () => {
    const parsed = parseSystemConnections(JSON.stringify({ learnosity: "conn-sys" }));
    expect(parsed).toEqual({ learnosity: "conn-sys" });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseSystemConnections(undefined)).toEqual({});
    expect(parseSystemConnections("")).toEqual({});
    expect(parseSystemConnections("{}")).toEqual({});
  });

  it.each([
    ["not JSON", "{"],
    ["an array", JSON.stringify(["conn-sys"])],
    ["a string", JSON.stringify("conn-sys")],
    ["an unknown backend", JSON.stringify({ other: "conn-sys" })],
    ["a non-string id", JSON.stringify({ learnosity: 7 })],
    ["an empty id", JSON.stringify({ learnosity: "" })],
    ["an id policy would refuse", JSON.stringify({ learnosity: "conn/sys" })]
  ])("refuses system connections given %s", (_, json) => {
    expect(() => parseSystemConnections(json)).toThrow(/POLICY_SYSTEM_CONNECTIONS/);
  });

  // Registry v7 removed Author signing and the settings that enabled it: a
  // deployment still setting one stops rather than appear to enable something.
  it.each(["POLICY_ENABLED_GATED_FUNCTIONS", "BROKER_ENABLED_GATED_OPERATIONS"])("refuses to start with the removed %s set", name => {
    expect(() => refuseRemovedSettings({ [name]: "[\"0176:author\"]" })).toThrow(new RegExp(`${name} no longer exist`));
    expect(() => refuseRemovedSettings({ [name]: "[]" })).toThrow(new RegExp(name));
  });

  it("starts with the removed settings absent or empty", () => {
    expect(() => refuseRemovedSettings({})).not.toThrow();
    expect(() => refuseRemovedSettings({ POLICY_ENABLED_GATED_FUNCTIONS: "", BROKER_ENABLED_GATED_OPERATIONS: " " })).not.toThrow();
  });

  it("requires settings to be present", () => {
    expect(() => requireEnv({}, "X")).toThrow(/X is required/);
    expect(() => requireEnv({ X: " " }, "X")).toThrow();
    expect(requireEnv({ X: "v" }, "X")).toBe("v");
  });
});

describe("system preview signing limits", () => {
  it("default to 120 a minute with a burst of 60, and read SYSTEM_SIGNINGS_PER_MINUTE and SYSTEM_SIGNINGS_BURST", () => {
    expect(parseSystemSigningLimits({})).toEqual({ perMinute: 120, burst: 60 });
    expect(parseSystemSigningLimits({ SYSTEM_SIGNINGS_PER_MINUTE: "", SYSTEM_SIGNINGS_BURST: " " })).toEqual({ perMinute: 120, burst: 60 });
    expect(parseSystemSigningLimits({ SYSTEM_SIGNINGS_PER_MINUTE: "30", SYSTEM_SIGNINGS_BURST: " 5 " })).toEqual({ perMinute: 30, burst: 5 });
  });

  it.each([["0"], ["-1"], ["1.5"], ["1e3"], ["0x10"], ["ten"], ["100001"], ["9007199254740993"]])("refuses %s, so the service doesn't start", value => {
    expect(() => parseSystemSigningLimits({ SYSTEM_SIGNINGS_PER_MINUTE: value })).toThrow(/SYSTEM_SIGNINGS_PER_MINUTE must be a whole number/);
    expect(() => parseSystemSigningLimits({ SYSTEM_SIGNINGS_BURST: value })).toThrow(/SYSTEM_SIGNINGS_BURST must be a whole number/);
  });
});

describe("the token bucket", () => {
  it("starts full, refills at its rate up to its burst, and says when to retry", () => {
    let t = 0;
    const bucket = createTokenBucket({ perMinute: 60, burst: 2, now: () => t });
    expect([bucket.take().ok, bucket.take().ok]).toEqual([true, true]);
    expect(bucket.take()).toEqual({ ok: false, retryAfter: 1 });
    t = 999;
    expect(bucket.take().ok).toBe(false);
    t = 1000;
    expect(bucket.take().ok).toBe(true);
    t = 1_000_000;
    expect([bucket.take().ok, bucket.take().ok, bucket.take().ok]).toEqual([true, true, false]);
  });

  it("never refills from a clock that steps back", () => {
    let t = 10_000;
    const bucket = createTokenBucket({ perMinute: 60, burst: 1, now: () => t });
    bucket.take();
    t = 0;
    expect(bucket.take().ok).toBe(false);
    t = 10_999;
    expect(bucket.take().ok).toBe(false);
    t = 11_000;
    expect(bucket.take().ok).toBe(true);
  });

  it("says how long until one token is available, in whole seconds", () => {
    const bucket = createTokenBucket({ perMinute: 1, burst: 1, now: () => 0 });
    bucket.take();
    expect(bucket.take()).toEqual({ ok: false, retryAfter: 60 });
  });
});
