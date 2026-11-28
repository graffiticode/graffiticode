import { FailureError, wrap, contextOf } from "./failure-error.js";

describe("FailureError", () => {
  it("carries its reason, the reason's category, and its cause", () => {
    const cause = new Error("root");
    const err = new FailureError("not-granted", { message: "internal", details: { a: 1 }, context: { stage: "s1" }, statusCode: 403, cause });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: "FailureError", reason: "not-granted", category: "permission", message: "internal", details: { a: 1 }, context: { stage: "s1" }, statusCode: 403 });
    expect(err.cause).toBe(cause);
  });

  it("keeps a category decided where the failure was read, and ignores one that isn't a category", () => {
    expect(new FailureError("preflight-refused", { category: "malformed" }).category).toBe("malformed");
    expect(new FailureError("not-granted", { category: "nonsense" as any }).category).toBe("permission");
    expect(new FailureError("no-such-reason").category).toBe("unavailable");
  });

  it("keeps only the known context fields, as strings", () => {
    expect(contextOf({ lang: "0176", stage: "s0", fn: "save", step: "questions", secret: "x", other: 1 })).toEqual({ lang: "0176", stage: "s0", fn: "save", step: "questions" });
    expect(contextOf({ stage: 1 })).toBeUndefined();
    expect(contextOf(null)).toBeUndefined();
  });
});

describe("wrap", () => {
  it("returns a FailureError unchanged when it adds no context", () => {
    const err = new FailureError("not-granted", { context: { stage: "s0" } });
    expect(wrap(err)).toBe(err);
    expect(wrap(err, { stage: "s0" })).toBe(err);
  });

  it("copies a FailureError with the added context, never wrapping it", () => {
    const cause = new Error("root");
    const err = new FailureError("not-granted", { message: "m", category: "permission", details: { d: 1 }, context: { stage: "s0" }, statusCode: 403, cause });
    const out = wrap(err, { fn: "save" });
    expect(out).not.toBe(err);
    expect(out).toMatchObject({ reason: "not-granted", message: "m", category: "permission", details: { d: 1 }, context: { stage: "s0", fn: "save" }, statusCode: 403 });
    expect(out.cause).toBe(cause);
    expect(out.stack).toBe(err.stack);
    // Wrapping again stays one level deep: the cause is still the root.
    expect(wrap(out, { lang: "0176" }).cause).toBe(cause);
  });

  it("keeps a service error's own checked fields: its category, status, details and context", () => {
    // As PreflightRefused (api admission.js) carries a refusal.
    const refused = Object.assign(new Error("preflight of s0 refused (400, preflight-refused)"), { reason: "preflight-refused", category: "malformed", status: 400, stage: "s0" });
    expect(wrap(refused, { lang: "0176" })).toMatchObject({ reason: "preflight-refused", category: "malformed", statusCode: 400, context: { stage: "s0", lang: "0176" } });
    // As PolicyDenied carries its detail.
    const denied = Object.assign(new Error("policy denied"), { reason: "rate-limited", statusCode: 429, detail: { retryAfter: 5 } });
    expect(wrap(denied)).toMatchObject({ reason: "rate-limited", category: "unavailable", statusCode: 429, details: { retryAfter: 5 } });
    // Fields that don't check out are not kept.
    const odd = Object.assign(new Error("x"), { reason: "not-granted", category: "nonsense", status: 9999, details: ["a"], context: { stage: 7 } });
    const out = wrap(odd);
    expect(out).toMatchObject({ reason: "not-granted", category: "permission" });
    expect(out.statusCode).toBeUndefined();
    expect(out.details).toBeUndefined();
    expect(out.context).toBeUndefined();
  });

  it("makes anything else a FailureError caused by it", () => {
    const plain = Object.assign(new Error("policy said no"), { reason: "not-granted" });
    expect(wrap(plain, { stage: "s1" })).toMatchObject({ reason: "not-granted", category: "permission", message: "policy said no", context: { stage: "s1" } });
    expect(wrap(plain).cause).toBe(plain);
    const unknown = new Error("boom");
    expect(wrap(unknown)).toMatchObject({ reason: "internal", category: "unavailable", message: "boom" });
    expect(wrap("text").cause).toBe("text");
  });
});
