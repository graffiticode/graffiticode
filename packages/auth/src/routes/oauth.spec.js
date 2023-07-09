import bent from "bent";
import { startAuthApp } from "../testing/app.js";

describe("routes/oauth", () => {
  const uid = "abc123";
  let authApp;
  beforeEach(async () => {
    authApp = await startAuthApp();
  });

  afterEach(async () => {
    await authApp.cleanUp();
  });

  describe("token", () => {
    it("should return invalid argument if no grant type", async () => {
      const postJSON = bent(authApp.url, "POST", "json", 200, 400);

      const { status, error } = await postJSON("/oauth/token", { grant_type: null });

      expect(status).toEqual("error");
      expect(error.code).toEqual(400);
      expect(error.message).toEqual("must provide a grant_type");
    });

    it("should return invalid argument if unknown grant type", async () => {
      const postJSON = bent(authApp.url, "POST", "json", 200, 400);

      const { status, error } = await postJSON("/oauth/token", { grant_type: "foo" });

      expect(status).toEqual("error");
      expect(error.code).toEqual(400);
      expect(error.message).toEqual("unknown grant_type foo");
    });

    describe("refresh_token", () => {
      it("should return valid access token", async () => {
        const { refreshToken } = await authApp.authService.generateTokens({ uid });

        const { access_token } = await authApp.client.exchangeRefreshToken(refreshToken);

        const { uid: actualUid } = await authApp.client.verifyAccessToken(access_token);
        expect(actualUid).toEqual(uid);
      });

      it("should return invalid arguement if missing refresh_token", async () => {
        await expect(authApp.client.exchangeRefreshToken(null)).rejects.toThrow("must provide a refresh_token");
      });

      it("should return unauthorized if invalid refreshToken", async () => {
        await expect(authApp.client.exchangeRefreshToken("foo")).rejects.toThrow("foo does not exist");
      });
    });
  });

  describe("revoke", () => {
    it("should return invalid argument if refresh token is not provided", async () => {
      await expect(authApp.client.revokeRefreshToken(null)).rejects.toThrow("must provide a token");
    });

    it("should not throw an erro for revoking non-existing refresh token", async () => {
      await expect(authApp.client.revokeRefreshToken("foo")).resolves.toBe();
    });

    it("should return not found for non-existing refresh token", async () => {
      const { refreshToken } = await authApp.authService.generateTokens({ uid });

      await authApp.client.revokeRefreshToken(refreshToken);

      await expect(authApp.client.exchangeRefreshToken(refreshToken))
        .rejects.toThrow(/does not exist/);
    });
  });
});
