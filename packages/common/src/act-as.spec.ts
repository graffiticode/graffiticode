import { describe, expect, it } from "@jest/globals";
import { ActAsGrantError, signActAsGrant, verifyActAsGrant } from "./act-as.js";

const SECRET = "s".repeat(32);
const grant = { purpose: "generation" as const, uid: "alice", subject: "gen-1", notAfter: 2_000 };
const expectFor = { purpose: "generation" as const, uid: "alice", subject: "gen-1" };

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ActAsGrantError);
    return (err as ActAsGrantError).reason;
  }
  throw new Error("expected a refusal");
};

describe("act-as grants", () => {
  it("round-trips a grant for exactly its purpose, uid and subject", () => {
    const token = signActAsGrant(SECRET, grant);
    expect(verifyActAsGrant(SECRET, token, expectFor, 1_000)).toEqual(grant);
  });

  it("refuses a grant signed with another secret", () => {
    const token = signActAsGrant("t".repeat(32), grant);
    expect(refusal(() => verifyActAsGrant(SECRET, token, expectFor, 1_000))).toBe("bad-signature");
  });

  it("refuses an altered payload", () => {
    const [, sig] = signActAsGrant(SECRET, grant).split(".");
    const forged = Buffer.from(JSON.stringify({ p: "generation", u: "mallory", s: "gen-1", n: 2_000 })).toString("base64url");
    expect(refusal(() => verifyActAsGrant(SECRET, `${forged}.${sig}`, { ...expectFor, uid: "mallory" }, 1_000))).toBe("bad-signature");
  });

  it("refuses a grant for another purpose, uid or subject", () => {
    const token = signActAsGrant(SECRET, grant);
    expect(refusal(() => verifyActAsGrant(SECRET, token, { ...expectFor, purpose: "effect" }, 1_000))).toBe("wrong-purpose");
    expect(refusal(() => verifyActAsGrant(SECRET, token, { ...expectFor, uid: "bob" }, 1_000))).toBe("uid-mismatch");
    expect(refusal(() => verifyActAsGrant(SECRET, token, { ...expectFor, subject: "gen-2" }, 1_000))).toBe("subject-mismatch");
  });

  it("refuses an expired grant", () => {
    const token = signActAsGrant(SECRET, grant);
    expect(refusal(() => verifyActAsGrant(SECRET, token, expectFor, 2_000))).toBe("expired");
  });

  it("refuses malformed tokens", () => {
    for (const bad of [undefined, 42, "", "abc", "a.b.c", "only."]) {
      expect(refusal(() => verifyActAsGrant(SECRET, bad, expectFor, 1_000))).toMatch(/malformed|bad-signature/);
    }
  });

  it("requires a long secret", () => {
    expect(() => signActAsGrant("short", grant)).toThrow(/at least 32/);
    expect(() => verifyActAsGrant("short", "a.b", expectFor)).toThrow(/at least 32/);
  });
});
