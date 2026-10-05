import { DEFAULT_LIMITS, headroomMs, maxExecutionMs, parseLimits } from "./limits.js";

describe("broker time limits", () => {
  it("defaults to a 10 s provider timeout, a 30 s deadline and a 5 s authorization wait", () => {
    expect(parseLimits({})).toEqual(DEFAULT_LIMITS);
    expect(maxExecutionMs(DEFAULT_LIMITS)).toBe(50_000);
    // H = deadline + 10 s skew, against the 50 s a fresh token has.
    expect(headroomMs(DEFAULT_LIMITS)).toBe(40_000);
  });

  it("reads overrides", () => {
    expect(parseLimits({ BROKER_PROVIDER_CALL_TIMEOUT_MS: "5000", BROKER_EXECUTION_DEADLINE_MS: "20000", BROKER_AUTHORIZE_TIMEOUT_MS: "2000" }))
      .toEqual({ providerCallMs: 5000, executionMs: 20000, authorizeMs: 2000 });
  });

  // The headroom constraint is on the combination: a fresh token (60 s, up to
  // 10 s from mint to execute) must cover the deadline plus 10 s of skew.
  it("accepts a 40 s deadline, the most a fresh token can cover", () => {
    expect(parseLimits({ BROKER_EXECUTION_DEADLINE_MS: "40000" }).executionMs).toBe(40_000);
  });

  it.each([
    [{ BROKER_PROVIDER_CALL_TIMEOUT_MS: "0" }, /positive integer/],
    [{ BROKER_PROVIDER_CALL_TIMEOUT_MS: "1.5" }, /positive integer/],
    [{ BROKER_EXECUTION_DEADLINE_MS: "soon" }, /positive integer/],
    [{ BROKER_AUTHORIZE_TIMEOUT_MS: "-1" }, /positive integer/],
    [{ BROKER_PROVIDER_CALL_TIMEOUT_MS: "20000", BROKER_EXECUTION_DEADLINE_MS: "10000" }, /cannot exceed BROKER_EXECUTION_DEADLINE_MS/],
    [{ BROKER_AUTHORIZE_TIMEOUT_MS: "30000" }, /must be less than BROKER_EXECUTION_DEADLINE_MS/],
    // Under the old 60 s cap, but 45 s + 10 s skew is past the 50 s a fresh token has.
    [{ BROKER_EXECUTION_DEADLINE_MS: "45000" }, /at most 40000 ms/],
    [{ BROKER_EXECUTION_DEADLINE_MS: "40001" }, /at most 40000 ms/],
    [{ BROKER_EXECUTION_DEADLINE_MS: "61000" }, /at most 40000 ms/]
  ])("refuses %j", (env, message) => {
    expect(() => parseLimits(env)).toThrow(message);
  });
});
