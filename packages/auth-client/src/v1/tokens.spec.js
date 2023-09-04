import { startAuthApp } from "@graffiticode/auth/testing";
import { UnauthenticatedError } from "@graffiticode/common/errors";
import { createClient } from "./index.js";

const uid = "abc123";

describe("v1/tokens", () => {
  let authApp;
  let client;

  beforeEach(async () => {
    authApp = await startAuthApp();
    client = createClient({ url: authApp.url });
  });

  afterEach(async () => {
    await authApp.cleanUp();
  });

  describe("verifyAccessToken", () => {
    it("should throw error if not token is provided", async () => {
      await expect(client.verifyAccessToken()).rejects.toThrow("must provide a token");
    });

    it("should throw error if invalid token is provided", async () => {
      await expect(client.verifyAccessToken("invalid-token")).rejects.toThrow(UnauthenticatedError);
    });

    it("should verify given token", async () => {
      const accessToken = await authApp.authService.createAccessToken({ uid });

      await expect(client.verifyAccessToken(accessToken)).resolves.toHaveProperty("uid", uid);
    });
  });
});
