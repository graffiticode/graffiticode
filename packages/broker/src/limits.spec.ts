import { DEFAULT_LIMITS, maxExecutionMs, parseLimits } from "./limits.js";

describe("broker time limits", () => {
  it("defaults to a 10 s provider timeout and a 30 s deadline", () => {
    expect(parseLimits({})).toEqual(DEFAULT_LIMITS);
    expect(maxExecutionMs(DEFAULT_LIMITS)).toBe(50_000);
  });

  it("reads overrides", () => {
    expect(parseLimits({ BROKER_PROVIDER_CALL_TIMEOUT_MS: "5000", BROKER_EXECUTION_DEADLINE_MS: "20000" }))
      .toEqual({ providerCallMs: 5000, executionMs: 20000 });
  });

  it.each([
    [{ BROKER_PROVIDER_CALL_TIMEOUT_MS: "0" }, /positive integer/],
    [{ BROKER_PROVIDER_CALL_TIMEOUT_MS: "1.5" }, /positive integer/],
    [{ BROKER_EXECUTION_DEADLINE_MS: "soon" }, /positive integer/],
    [{ BROKER_PROVIDER_CALL_TIMEOUT_MS: "20000", BROKER_EXECUTION_DEADLINE_MS: "10000" }, /cannot exceed BROKER_EXECUTION_DEADLINE_MS/],
    [{ BROKER_EXECUTION_DEADLINE_MS: "61000" }, /60 s/]
  ])("refuses %j", (env, message) => {
    expect(() => parseLimits(env)).toThrow(message);
  });
});
