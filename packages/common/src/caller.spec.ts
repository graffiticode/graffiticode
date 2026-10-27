/* eslint-disable camelcase -- Google ID token claims are snake_case */

import { createCallerIdentity } from "./caller.js";
import { UnauthenticatedError, UnauthorizedError, UnavailableError } from "./errors.js";

const EMAIL = "l0000-run@graffiticode.iam.gserviceaccount.com";
const unsigned = claims => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
const request = (headers: Record<string, string>) => ({ get: (name: string) => headers[name] });
const headers = { "X-Caller-Identity": "caller-token", "X-Serverless-Authorization": `Bearer ${unsigned({ email: EMAIL })}` };

const identity = (verifyIdToken, lines: string[] = []) => createCallerIdentity({
  verifyIdToken,
  audience: "urn:graffiticode:policy",
  callers: { [EMAIL]: { role: "compiler", lang: "0000" } },
  log: line => lines.push(line),
});

describe("createCallerIdentity", () => {
  it("returns the caller for a verified token that matches the invoker, and logs nothing", async () => {
    const lines: string[] = [];
    const caller = await identity(async () => ({ email: EMAIL, email_verified: true }), lines)(request(headers));
    expect(caller).toEqual({ role: "compiler", lang: "0000", email: EMAIL });
    expect(lines).toEqual([]);
  });

  // 2026-10-27: an L0000 stage's snapshot got a 401 that left no trace of why.
  it("logs why a token failed verification, without the token or its claims, and refuses it (401)", async () => {
    const lines: string[] = [];
    const verify = async () => { throw new Error("Token used too late, 1761580834 > 1761580800: {\"email\":\"l0000-run@…\",\"aud\":\"urn:graffiticode:policy\"}"); };
    await expect(identity(verify, lines)(request(headers))).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(lines.map(l => JSON.parse(l))).toEqual([{ event: "caller-identity", outcome: "refused", reason: "invalid", detail: "Token used too late, 1761580834 > 1761580800", invoker: EMAIL }]);
    expect(lines[0]).not.toContain("caller-token");
    expect(lines[0]).not.toContain("aud");
  });

  it("answers unavailable (503, retry) when Google's certificates can't be reached, not 401", async () => {
    for (const err of [
      Object.assign(new Error("request to https://www.googleapis.com/oauth2/v1/certs failed, reason: socket hang up"), { code: "ECONNRESET" }),
      Object.assign(new Error("Request failed with status code 503"), { response: { status: 503 } }),
      Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }),
    ]) {
      const lines: string[] = [];
      await expect(identity(async () => { throw err; }, lines)(request(headers))).rejects.toBeInstanceOf(UnavailableError);
      expect(JSON.parse(lines[0]).reason).toBe("verifier-unavailable");
    }
  });

  it("logs a missing token and one without a verified email", async () => {
    const lines: string[] = [];
    await expect(identity(async () => ({}), lines)(request({ "X-Serverless-Authorization": headers["X-Serverless-Authorization"] }))).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(identity(async () => ({ email: EMAIL, email_verified: false }), lines)(request(headers))).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(lines.map(l => JSON.parse(l).reason)).toEqual(["missing", "no-verified-email"]);
  });

  it("still refuses an unknown caller and an invoker mismatch (403)", async () => {
    await expect(identity(async () => ({ email: "other@example.com", email_verified: true }))(request(headers))).rejects.toBeInstanceOf(UnauthorizedError);
    const mismatch = { ...headers, "X-Serverless-Authorization": `Bearer ${unsigned({ email: "other@example.com" })}` };
    await expect(identity(async () => ({ email: EMAIL, email_verified: true }))(request(mismatch))).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
