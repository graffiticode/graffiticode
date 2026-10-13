// Characterization tests: these pin the CURRENT behavior of client/remote.js
// (the published `@graffiticode/auth/client` entry point, written before the
// TypeScript migration), not a judgment of it. Runs a real auth app against
// the emulators.
import { createClient } from "./remote.js";
import { startAuthApp } from "../testing/app.js";
import { signInAndGetIdToken } from "../testing/firebase.js";

describe("client/remote", () => {
  const uid = "abc123";
  let authApp;
  let client;
  beforeEach(async () => {
    authApp = await startAuthApp();
    client = authApp.client;
  });

  afterEach(async () => {
    await authApp.cleanUp();
  });

  it("exposes the published client surface", () => {
    expect(Object.keys(client).sort()).toEqual([
      "apiKeys",
      "ethereum",
      "exchangeRefreshToken",
      "revokeRefreshToken",
      "verifyAccessToken",
      "verifyToken",
    ]);
    expect(Object.keys(client.apiKeys).sort()).toEqual(["authenticate", "create", "remove"]);
    expect(Object.keys(client.ethereum).sort()).toEqual(["authenticate", "getNonce"]);
  });

  it("defaults to https://auth.graffiticode.com without making a request", () => {
    expect(() => createClient()).not.toThrow();
  });

  describe("verifyAccessToken (local JWKS check against /certs)", () => {
    it("returns uid = sub and the token's claims merged with its protected header", async () => {
      const { accessToken } = await authApp.authService.generateTokens({ uid });

      const result = await client.verifyAccessToken(accessToken);

      expect(result.uid).toBe(uid);
      expect(result.token).toMatchObject({ sub: uid, iss: "urn:graffiticode:auth", alg: "ES256", kid: expect.any(String) });
    });

    it("rejects a malformed token", async () => {
      await expect(client.verifyAccessToken("not-a-jwt")).rejects.toThrow();
    });
  });

  describe("verifyToken (remote /oauth/verify)", () => {
    it("returns { uid, token } for an auth access token", async () => {
      const { accessToken } = await authApp.authService.generateTokens({ uid });
      await expect(client.verifyToken(accessToken)).resolves.toMatchObject({ uid, token: { uid, sub: uid } });
    });

    it("returns { uid, token } for a firebase id token", async () => {
      const { firebaseCustomToken } = await authApp.authService.generateTokens({ uid });
      const idToken = await signInAndGetIdToken(firebaseCustomToken);
      await expect(client.verifyToken(idToken)).resolves.toMatchObject({ uid });
    });

    it("throws the server's message and code", async () => {
      await expect(client.verifyToken("")).rejects.toMatchObject({ message: "must provide a idToken", code: 400 });
      await expect(client.verifyToken("garbage")).rejects.toMatchObject({ code: 401 });
    });
  });

  describe("exchangeRefreshToken / revokeRefreshToken", () => {
    it("exchanges a refresh token for access_token and firebaseCustomToken", async () => {
      const { refreshToken } = await authApp.authService.generateTokens({ uid });
      const data = await client.exchangeRefreshToken(refreshToken);
      expect(Object.keys(data).sort()).toEqual(["access_token", "firebaseCustomToken"]);
      await expect(client.verifyAccessToken(data.access_token)).resolves.toHaveProperty("uid", uid);
    });

    it("stops exchanging a revoked refresh token", async () => {
      const { refreshToken } = await authApp.authService.generateTokens({ uid });
      await expect(client.revokeRefreshToken(refreshToken)).resolves.toBeUndefined();
      await expect(client.exchangeRefreshToken(refreshToken)).rejects.toMatchObject({ code: 401 });
    });

    it("throws the server's message for missing arguments", async () => {
      await expect(client.exchangeRefreshToken()).rejects.toMatchObject({ message: "must provide a refresh_token", code: 400 });
      await expect(client.revokeRefreshToken()).rejects.toMatchObject({ message: "must provide a token", code: 400 });
    });
  });
});
