import { UnauthenticatedError } from "@graffiticode/common/errors";
import request from "supertest";
import { startAuthApp } from "../../testing/app.js";

const uid = "abc123";

describe("routes/v1/ethereum", () => {
  let authApp;
  beforeEach(async () => {
    authApp = await startAuthApp();
  });

  afterEach(async () => {
    await authApp.cleanUp();
  });

  describe("exchange", () => {
    it("should return invalid argument if no refresh token is provided", async () => {
      const res = await request(authApp.app)
        .post("/v1/refresh-tokens/exchange")
        .expect(400);

      expect(res.body).toHaveProperty("status", "error");
      expect(res.body).toHaveProperty("error.message", "must provide a refreshToken");
    });

    it("should return unauthenticated if refresh token does not exist", async () => {
      const res = await request(authApp.app)
        .post("/v1/refresh-tokens/exchange")
        .send({ refreshToken: "does-not-exist" })
        .expect(401);

      expect(res.body).toHaveProperty("status", "error");
      expect(res.body).toHaveProperty("error.message", "Unauthorized");
    });

    it("should return valid accessToken if refreshToken is valid", async () => {
      const { refreshToken } = await authApp.authService.generateTokens({ uid });

      const res = await request(authApp.app)
        .post("/v1/refresh-tokens/exchange")
        .send({ refreshToken })
        .expect(200);

      expect(res.body).toHaveProperty("status", "success");
      expect(res.body).toHaveProperty("data.accessToken");
      const { accessToken: token } = res.body.data;
      await expect(authApp.authService.verifyToken({ token })).resolves.toHaveProperty("uid", uid);
    });
  });

  describe("revoke", () => {
    it("should return invalid argument if no refresh token is provided", async () => {
      const res = await request(authApp.app)
        .post("/v1/refresh-tokens/revoke")
        .expect(400);

      expect(res.body).toHaveProperty("status", "error");
      expect(res.body).toHaveProperty("error.message", "must provide a refreshToken");
    });

    it("should succeed if refresh token does not exist", async () => {
      const res = await request(authApp.app)
        .post("/v1/refresh-tokens/revoke")
        .send({ refreshToken: "does-not-exist" })
        .expect(200);

      expect(res.body).toHaveProperty("status", "success");
      expect(res.body).toHaveProperty("data", null);
    });

    it("should succeed if refresh token exists", async () => {
      const { refreshToken } = await authApp.authService.generateTokens({ uid });

      const res = await request(authApp.app)
        .post("/v1/refresh-tokens/revoke")
        .send({ refreshToken })
        .expect(200);

      expect(res.body).toHaveProperty("status", "success");
      expect(res.body).toHaveProperty("data", null);
      // Should not be able to use the refreshToken to generate an accessToken.
      await expect(authApp.authService.generateAccessToken({ refreshToken }))
        .rejects.toThrow(UnauthenticatedError);
    });
  });
});
