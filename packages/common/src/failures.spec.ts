import { FAILURE_CATEGORIES, REASON_CATEGORIES, classify, underlyingReason, categoryForStatus, isMalformedBody } from "./failures.js";

describe("failure categories", () => {
  it("are the five FAIL-01 distinguishes", () => {
    expect([...FAILURE_CATEGORIES]).toEqual(["authentication", "permission", "malformed", "conflict", "unavailable"]);
  });

  it("classify a known reason", () => {
    expect(classify("not-granted")).toEqual({ category: "permission", classified: true });
    expect(classify("token-replayed")).toEqual({ category: "conflict", classified: true });
    expect(classify("maintenance")).toEqual({ category: "unavailable", classified: true });
  });

  it("classify a wrapped reason by the reason it wraps", () => {
    expect(underlyingReason("authorization-denied:token-expired")).toBe("token-expired");
    expect(classify("authorization-denied:token-expired").category).toBe("authentication");
    expect(classify("authorization-denied:maintenance").category).toBe("unavailable");
    expect(classify("authorization-denied:not-granted").category).toBe("permission");
  });

  // An unknown reason never passes as a permission denial: it could hide an
  // outage. It is unavailable, and flagged for reporting.
  it("report an unknown or missing reason as unavailable and unclassified", () => {
    for (const reason of ["no-such-reason", "authorization-denied:no-such-reason", undefined, null, 42, ""]) {
      expect(classify(reason)).toEqual({ category: "unavailable", classified: false });
    }
  });

  it("map statuses without a reason", () => {
    expect([401, 403, 409, 400, 404, 413, 429, 500, 501, 503].map(categoryForStatus))
      .toEqual(["authentication", "permission", "conflict", "malformed", "malformed", "malformed", "unavailable", "unavailable", "unavailable", "unavailable"]);
  });

  it("recognize a body the JSON parser rejected", () => {
    expect(isMalformedBody({ type: "entity.parse.failed" })).toBe(true);
    expect(isMalformedBody({ type: "entity.too.large" })).toBe(true);
    expect(isMalformedBody(new Error("boom"))).toBe(false);
    expect(isMalformedBody(null)).toBe(false);
  });

  it("are frozen", () => {
    expect(Object.isFrozen(REASON_CATEGORIES)).toBe(true);
    expect(Object.isFrozen(FAILURE_CATEGORIES)).toBe(true);
  });
});
