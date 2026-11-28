import { FAILURE_CATEGORIES, REASON_CATEGORIES, classify, underlyingReason, categoryForStatus, isMalformedBody, FAILURE_SPECS, SPEC_EXTRA_REASONS, RECOVERY_ACTIONS, STATUS_FOR_CATEGORY, DETAIL_KINDS, recoveryFor, specOf, canonicalReason } from "./failures.js";

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

// Error handling proposal, step 2 (PR 2a).
describe("failure specs", () => {
  it("cover exactly the registered reasons, each with its table category", () => {
    expect(Object.keys(FAILURE_SPECS).sort()).toEqual(Object.keys(REASON_CATEGORIES).sort());
    for (const [reason, spec] of Object.entries(FAILURE_SPECS)) {
      expect([reason, spec.category]).toEqual([reason, REASON_CATEGORIES[reason]]);
      expect(Number.isInteger(spec.status)).toBe(true);
    }
  });

  it("add extras only to registered reasons, with valid recovery actions", () => {
    for (const reason of SPEC_EXTRA_REASONS) expect([reason, REASON_CATEGORIES[reason]]).toEqual([reason, expect.any(String)]);
    for (const spec of Object.values(FAILURE_SPECS)) {
      const rule = spec.recovery;
      const actions = rule === undefined ? [] : typeof rule === "string" ? [rule] : [rule.read, rule.write];
      for (const action of actions) expect(RECOVERY_ACTIONS).toContain(action);
      for (const kind of Object.values(spec.details ?? {})) expect(Object.keys(DETAIL_KINDS)).toContain(kind);
    }
  });

  it("default each status to its category's", () => {
    expect(FAILURE_SPECS["not-granted"].status).toBe(STATUS_FOR_CATEGORY.permission);
    expect(FAILURE_SPECS["token-expired"].status).toBe(401);
    expect(FAILURE_SPECS["command-not-found"].status).toBe(404);
    expect(FAILURE_SPECS["rate-limited"].status).toBe(429);
  });

  it("are found for a wrapped reason, and for none that isn't registered", () => {
    expect(specOf("authorization-denied:token-expired")?.recovery).toBe("reauthenticate");
    expect(specOf("no-such-reason")).toBeUndefined();
    expect(specOf(42)).toBeUndefined();
  });

  it("never take an inherited property for a reason, alias or state", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(classify(name)).toEqual({ category: "unavailable", classified: false });
      expect(classify(`authorization-denied:${name}`)).toEqual({ category: "unavailable", classified: false });
      expect(specOf(name)).toBeUndefined();
      expect(canonicalReason(name)).toBe(name);
      expect(recoveryFor("policy-unavailable", { operation: "write", recordedState: name }).action).toBe("read-existing");
    }
  });

  it("resolve a legacy spelling through an alias", () => {
    expect(canonicalReason("old-name", { "old-name": "not-granted" })).toBe("not-granted");
    expect(canonicalReason("not-granted")).toBe("not-granted");
  });

  it("are frozen", () => {
    expect(Object.isFrozen(FAILURE_SPECS)).toBe(true);
    expect(Object.isFrozen(FAILURE_SPECS["not-granted"])).toBe(true);
  });
});

describe("recoveryFor", () => {
  it("decides from the reason and the operation, never from the category alone", () => {
    expect(recoveryFor("compile-response-lost", { operation: "read" }).action).toBe("retry-same-key");
    expect(recoveryFor("compile-response-lost", { operation: "write" }).action).toBe("read-existing");
    // An unknown operation is taken as a write.
    expect(recoveryFor("compile-response-lost", { operation: "something" }).action).toBe("read-existing");
    expect(recoveryFor("compile-response-lost").action).toBe("read-existing");
    // Unavailable, with no rule of its own: no retry.
    expect(recoveryFor("session-exhausted", { operation: "read" }).action).toBe("none");
    expect(recoveryFor("no-such-reason", { operation: "read" }).action).toBe("none");
    expect(recoveryFor(undefined).action).toBe("none");
  });

  it("decides from a recorded outcome before any reason's rule", () => {
    const write = recordedState => recoveryFor("policy-unavailable", { operation: "write", recordedState }).action;
    expect(write("uncertain")).toBe("reconcile");
    expect(write("partial")).toBe("read-existing");
    expect(write("completed")).toBe("read-existing");
    expect(write("pending")).toBe("read-existing");
    expect(write("something-new")).toBe("read-existing");
    // Nothing took effect, or no record: the reason decides.
    expect(write("failed")).toBe("retry-same-key");
    expect(write(null)).toBe("retry-same-key");
    expect(recoveryFor("compile-response-lost", { operation: "read", recordedState: "completed" }).action).toBe("read-existing");
  });

  it("checks each detail kind's values", () => {
    expect([0, 30, 604800].every(DETAIL_KINDS.seconds)).toBe(true);
    expect([-1, 1.5, "30", 604801, null, { a: 1 }].some(DETAIL_KINDS.seconds)).toBe(false);
    expect(DETAIL_KINDS.token("not-granted")).toBe(true);
    expect(["Not Granted", "a".repeat(65), { x: 1 }, ""].some(DETAIL_KINDS.token)).toBe(false);
    expect(DETAIL_KINDS.flag(false)).toBe(true);
    expect(DETAIL_KINDS.flag("true")).toBe(false);
  });

  it("names the operation it decided for", () => {
    expect(recoveryFor("not-granted", { operation: "write" })).toEqual({ action: "change-connection", operation: "write" });
    expect(recoveryFor("not-granted")).toEqual({ action: "change-connection", operation: null });
  });
});
