import { readFileSync } from "node:fs";
import { toPublicError, PUBLIC_ERROR_VERSION, CATEGORY_MESSAGES } from "./public-error.js";
import { FailureError } from "./failure-error.js";
import { requestContextMiddleware } from "./request-context.js";

const FIXTURES = JSON.parse(readFileSync(new URL("../fixtures/public-errors.json", import.meta.url), "utf8"));

describe("toPublicError", () => {
  it("reproduces every shared vector", () => {
    expect(FIXTURES.version).toBe(PUBLIC_ERROR_VERSION);
    expect(FIXTURES.cases.length).toBeGreaterThanOrEqual(10);
    for (const { name, error, options, expected } of FIXTURES.cases) {
      expect([name, toPublicError(error, options)]).toEqual([name, expected]);
    }
  });

  it("never carries a stack, a cause, an internal message or a disallowed detail", () => {
    const SECRET = "SENTINEL-public-error-91c4";
    const cause = new Error(`upstream body ${SECRET}`);
    const err = new FailureError("rate-limited", {
      message: `internal ${SECRET}`,
      details: { retryAfter: 5, credential: SECRET },
      cause,
    });
    const out = toPublicError(err, { requestRef: "req-9" });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out).toEqual({
      version: 1,
      reason: "rate-limited",
      category: "unavailable",
      message: CATEGORY_MESSAGES.unavailable,
      details: { retryAfter: 5 },
      recovery: { action: "retry-same-key", operation: null },
      requestRef: "req-9",
      retryable: true,
    });
  });

  it("treats anything thrown as an unavailable failure with no reason", () => {
    for (const thrown of [new Error("boom"), "a string", null, undefined, 42]) {
      expect(toPublicError(thrown, { requestRef: "r" })).toEqual({
        version: 1,
        reason: null,
        category: "unavailable",
        message: CATEGORY_MESSAGES.unavailable,
        recovery: { action: "none", operation: null },
        requestRef: "r",
        retryable: false,
      });
    }
  });

  it("keeps an explicit category only when it is one of the five", () => {
    expect(toPublicError({ reason: "not-granted", category: "nonsense" }).category).toBe("permission");
    expect(toPublicError({ reason: "not-granted", category: "malformed" }).category).toBe("malformed");
  });

  it("takes the current request's id when none is given", async () => {
    const seen: (string | undefined)[] = [];
    await new Promise<void>(resolve => requestContextMiddleware({}, {}, () => {
      seen.push(toPublicError({ reason: "no-user" }).requestRef);
      resolve();
    }));
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(toPublicError({ reason: "no-user" }).requestRef).toBeUndefined();
  });

  it("caps a public message", () => {
    const out = toPublicError(new FailureError("not-granted", { publicMessage: "x".repeat(2000) }));
    expect(out.message).toHaveLength(500);
  });
});
