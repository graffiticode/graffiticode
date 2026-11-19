import { createHmac } from "node:crypto";
import { describe, expect, it } from "@jest/globals";
import { ActAsGrantError, ActAsGrantV2Error, signActAsGrant, signActAsGrantV2, verifyActAsGrant, verifyActAsGrantV2 } from "./act-as.js";

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

describe("act-as v1 is unchanged", () => {
  it("signs exactly the token it signed before v2 existed", () => {
    // Computed with v1 before this change; must never move.
    expect(signActAsGrant(SECRET, grant)).toBe(
      "eyJwIjoiZ2VuZXJhdGlvbiIsInUiOiJhbGljZSIsInMiOiJnZW4tMSIsIm4iOjIwMDB9.EPI-UYD355C20JUEbEI9ba_A6rTD9X8cgF6r3OiW3AM",
    );
  });
});

describe("act-as v2 grants", () => {
  const grantV2 = { ...grant, installation: "artcompiler" };
  const expectV2 = { ...expectFor, installation: "artcompiler" };

  const refusalV2 = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ActAsGrantV2Error);
      return (err as ActAsGrantV2Error).reason;
    }
    throw new Error("expected a refusal");
  };

  it("round-trips a grant for exactly its installation, purpose, uid and subject", () => {
    const token = signActAsGrantV2(SECRET, grantV2);
    expect(verifyActAsGrantV2(SECRET, token, expectV2, 1_000)).toEqual(grantV2);
  });

  it("refuses a grant for another installation", () => {
    const token = signActAsGrantV2(SECRET, grantV2);
    expect(refusalV2(() => verifyActAsGrantV2(SECRET, token, { ...expectV2, installation: "graffiticode" }, 1_000))).toBe("installation-mismatch");
  });

  it("refuses a grant signed with another installation's secret", () => {
    const token = signActAsGrantV2("t".repeat(32), grantV2);
    expect(refusalV2(() => verifyActAsGrantV2(SECRET, token, expectV2, 1_000))).toBe("bad-signature");
  });

  it("refuses an installation swapped into the payload", () => {
    const [, sig] = signActAsGrantV2(SECRET, grantV2).split(".");
    const forged = Buffer.from(JSON.stringify({ p: "generation", u: "alice", s: "gen-1", n: 2_000, i: "graffiticode" })).toString("base64url");
    expect(refusalV2(() => verifyActAsGrantV2(SECRET, `${forged}.${sig}`, { ...expectV2, installation: "graffiticode" }, 1_000))).toBe("bad-signature");
  });

  it("never verifies a token of one version as the other", () => {
    const v1 = signActAsGrant(SECRET, grant);
    expect(refusalV2(() => verifyActAsGrantV2(SECRET, v1, expectV2, 1_000))).toBe("bad-signature");
    const v2 = signActAsGrantV2(SECRET, grantV2);
    expect(refusal(() => verifyActAsGrant(SECRET, v2, expectFor, 1_000))).toBe("bad-signature");
  });

  it("refuses the other mismatches and expiry as v1 does", () => {
    const token = signActAsGrantV2(SECRET, grantV2);
    expect(refusalV2(() => verifyActAsGrantV2(SECRET, token, { ...expectV2, purpose: "effect" }, 1_000))).toBe("wrong-purpose");
    expect(refusalV2(() => verifyActAsGrantV2(SECRET, token, { ...expectV2, uid: "bob" }, 1_000))).toBe("uid-mismatch");
    expect(refusalV2(() => verifyActAsGrantV2(SECRET, token, { ...expectV2, subject: "gen-2" }, 1_000))).toBe("subject-mismatch");
    expect(refusalV2(() => verifyActAsGrantV2(SECRET, token, expectV2, 2_000))).toBe("expired");
  });

  it("refuses malformed tokens and won't sign without a valid installation", () => {
    expect(refusalV2(() => verifyActAsGrantV2(SECRET, "nope", expectV2, 1_000))).toBe("malformed");
    expect(refusalV2(() => verifyActAsGrantV2(SECRET, 7, expectV2, 1_000))).toBe("malformed");
    // Correctly signed, but its installation isn't an installation id.
    const payload = Buffer.from(JSON.stringify({ p: "generation", u: "alice", s: "gen-1", n: 2_000, i: "Bad/Id" })).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(`act-as.v2.${payload}`).digest("base64url");
    expect(refusalV2(() => verifyActAsGrantV2(SECRET, `${payload}.${sig}`, { ...expectV2, installation: "Bad/Id" }, 1_000))).toBe("malformed");
    expect(() => signActAsGrantV2(SECRET, { ...grantV2, installation: "Bad/Id" })).toThrow(/installation/);
    expect(() => signActAsGrantV2(SECRET, { ...grant } as any)).toThrow(/installation/);
  });
});
