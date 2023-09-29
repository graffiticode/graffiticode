import { startAuthApp } from "@graffiticode/auth/testing";
import { InvalidArgumentError } from "@graffiticode/common/errors";
import { createClient } from "./index.js";

const uid = "abc123";

describe("ethereum", () => {
  let authApp;
  let client;

  beforeEach(async () => {
    authApp = await startAuthApp();
    client = createClient({ url: authApp.url });
  });

  afterEach(async () => {
    await authApp.cleanUp();
  });

  describe("exchange", () => {
    it("should return invalid argument if refresh token is not provided", async () => {
      await expect(client.exchangeRefreshToken()).rejects.toThrow(InvalidArgumentError);
    });

    it("should return unauthenticated if refresh token does not exist", async () => {
      await expect(client.exchangeRefreshToken({ refreshToken: "does-not-exist" }))
        .rejects.toThrow("Unauthorized");
    });

    it("should return valid accessToken is valid refreshToken", async () => {
      const { refreshToken } = await authApp.authService.generateTokens({ uid });

      const { accessToken } = await client.exchangeRefreshToken({ refreshToken });

      await expect(client.verifyAccessToken({ accessToken }))
        .resolves.toHaveProperty("uid", uid);
    });
  });

  describe("revoke", () => {
    it("should return invalid argument if refresh token is not provided", async () => {
      await expect(client.revokeRefreshToken()).rejects.toThrow(InvalidArgumentError);
    });

    it("should succeed if refresh token does not exist", async () => {
      await expect(client.revokeRefreshToken({ refreshToken: "does-not-exist" })).resolves.toBe();
    });

    it("should succeed if refresh token exists", async () => {
      const { refreshToken } = await authApp.authService.generateTokens({ uid });

      await expect(client.revokeRefreshToken({ refreshToken })).resolves.toBe();

      // Should not be able to use the refreshToken to generate an accessToken.
      await expect(client.exchangeRefreshToken({ refreshToken }))
        .rejects.toThrow("Unauthorized");
    });
  });
});
