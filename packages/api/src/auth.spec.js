import { describe } from "@jest/globals";
import { buildValidateToken, authUnreachable } from "./auth.js";
import { UnauthenticatedError, UnavailableError } from "./errors/http.js";
import { startAuthApp } from "@graffiticode/auth/testing";

describe("auth", () => {
  let authApp;
  let validateToken;
  beforeEach(async () => {
    authApp = await startAuthApp();
    validateToken = buildValidateToken({ authUrl: authApp.url });
  });

  afterEach(async () => {
    if (authApp) {
      await authApp.cleanUp();
    }
  });

  it("should reject for missing token", async () => {
    const token = "header.payload.signature";

    await expect(validateToken(token)).rejects.toThrow();
  });

  it("should return uid from auth app", async () => {
    const { accessToken: token } = await authApp.authService.generateTokens({ uid: "1" });

    await expect(validateToken(token)).resolves.toStrictEqual({ uid: "1" });
  });
});

// 2026-10-27: a verify call that never reached auth was answered as an invalid
// token. A transport failure is asked once more, then 503; auth's own refusal
// is still 401, without a retry.
describe("auth unreachable", () => {
  const reset = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const edge = () => Object.assign(new Error("Incorrect statusCode: 502"), { statusCode: 502 });
  const refused = () => Object.assign(new Error("invalid token"), { code: 401 });
  const withClient = verifyToken => buildValidateToken({ authUrl: "http://auth.invalid", client: { verifyToken } });

  it("asks auth again once when it couldn't be reached, and succeeds", async () => {
    let calls = 0;
    const validate = withClient(async () => { if (++calls === 1) throw reset(); return { uid: "1" }; });
    await expect(validate("t")).resolves.toStrictEqual({ uid: "1" });
    expect(calls).toBe(2);
  });

  it("answers 503 when auth still can't be reached", async () => {
    for (const fail of [reset, edge]) {
      let calls = 0;
      const err = await withClient(async () => { calls++; throw fail(); })("t").catch(e => e);
      expect(err).toBeInstanceOf(UnavailableError);
      expect(err.statusCode).toBe(503);
      expect(calls).toBe(2);
    }
  });

  it("still answers 401 for a token auth refused, without asking again", async () => {
    let calls = 0;
    const err = await withClient(async () => { calls++; throw refused(); })("t").catch(e => e);
    expect(err).toBeInstanceOf(UnauthenticatedError);
    expect(calls).toBe(1);
  });

  it("gives up on an attempt that doesn't answer in time, asks again, then answers 503", async () => {
    let calls = 0;
    const hang = () => new Promise(() => {});
    const validate = buildValidateToken({ authUrl: "http://auth.invalid", client: { verifyToken: async () => { calls++; return hang(); } }, timeoutMs: 20 });
    const err = await validate("t").catch(e => e);
    expect(err).toBeInstanceOf(UnavailableError);
    expect(calls).toBe(2);
    let second = 0;
    const recovers = buildValidateToken({ authUrl: "http://auth.invalid", client: { verifyToken: async () => (++second === 1 ? hang() : { uid: "1" }) }, timeoutMs: 20 });
    await expect(recovers("t")).resolves.toStrictEqual({ uid: "1" });
  });

  it("classifies only transport failures as unreachable", () => {
    expect(authUnreachable(reset())).toBe(true);
    expect(authUnreachable(edge())).toBe(true);
    expect(authUnreachable(refused())).toBe(false);
  });
});
