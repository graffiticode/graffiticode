import { UnauthenticatedError } from "@graffiticode/common/errors";
import request from "supertest";
import { startAuthApp } from "../../testing/app.js";

const uid = "abc123";
const otherUid = "def456";

describe("routes/v1/api-keys", () => {
  let authApp;
  beforeEach(async () => {
    authApp = await startAuthApp();
  });

  afterEach(async () => {
    await authApp.cleanUp();
  });

  describe("create", () => {
    it("should return unauthorized if missing access token", async () => {
      await request(authApp.app)
        .post("/v1/api-keys")
        .expect(403);
    });

    it("should return unauthorized if access token is derived from an API Key", async () => {
      const { id, token } = await authApp.apiKeyService.create({ uid });
      const authContext = await authApp.apiKeyService.authenticate({ id, token });
      const accessToken = await authApp.authService.createAccessToken(authContext);

      await request(authApp.app)
        .post("/v1/api-keys")
        .set("Authorization", accessToken)
        .expect(403);
    });

    it("should return create an API key with", async () => {
      const { accessToken } = await authApp.authService.generateTokens({ uid });

      const res = await request(authApp.app)
        .post("/v1/api-keys")
        .set("Authorization", accessToken)
        .expect(200);

      expect(res.body).toHaveProperty("status", "success");
      const { id, token } = res.body.data;
      await expect(authApp.apiKeyService.authenticate({ id, token })).resolves.toHaveProperty("uid", uid);
    });
  });

  describe("delete", () => {
    it("should return unauthorized if missing access token", async () => {
      const { id } = await authApp.apiKeyService.create({ uid });

      await request(authApp.app)
        .delete(`/v1/api-keys/${id}`)
        .expect(403);
    });

    it("should return unauthorized if access token is derived from an API Key", async () => {
      const { id, token } = await authApp.apiKeyService.create({ uid });
      const authContext = await authApp.apiKeyService.authenticate({ id, token });
      const accessToken = await authApp.authService.createAccessToken(authContext);

      await request(authApp.app)
        .delete(`/v1/api-keys/${id}`)
        .set("Authorization", accessToken)
        .expect(403);
    });

    it("should return not found for non-exist api key", async () => {
      const { accessToken } = await authApp.authService.generateTokens({ uid });

      await request(authApp.app)
        .delete("/v1/api-keys/foo")
        .set("Authorization", accessToken)
        .expect(404);
    });

    it("should return unauthorized if API key was created by another user", async () => {
      const { id } = await authApp.apiKeyService.create({ uid });
      const { accessToken } = await authApp.authService.generateTokens({ uid: otherUid });

      await request(authApp.app)
        .delete(`/v1/api-keys/${id}`)
        .set("Authorization", accessToken)
        .expect(403);
    });

    it("should delete API key with valid access token", async () => {
      const { id, token } = await authApp.apiKeyService.create({ uid });
      const { accessToken } = await authApp.authService.generateTokens({ uid });

      await request(authApp.app)
        .delete(`/v1/api-keys/${id}`)
        .set("Authorization", accessToken)
        .expect(200);

      await expect(authApp.apiKeyService.authenticate({ id, token }))
        .rejects.toThrow(UnauthenticatedError);
    });
  });

  describe("authenticate", () => {
    it("should return unauthenticated for non existant api key", async () => {
      const { token } = await authApp.apiKeyService.create({ uid });

      await request(authApp.app)
        .post("/v1/api-keys/non-existant/authenticate")
        .send({ token })
        .expect(401);
    });

    it("should return unauthenticated for missing secret", async () => {
      const { id } = await authApp.apiKeyService.create({ uid });

      await request(authApp.app)
        .post(`/v1/api-keys/${id}/authenticate`)
        .expect(401);
    });

    it("should return unauthenticated for incorrect secret", async () => {
      const { id } = await authApp.apiKeyService.create({ uid });
      const { token } = await authApp.apiKeyService.create({ uid });

      await request(authApp.app)
        .post(`/v1/api-keys/${id}/authenticate`)
        .send({ token })
        .expect(401);
    });

    it("should return access and refresh tokens for valid api key", async () => {
      const { id, token } = await authApp.apiKeyService.create({ uid });

      const res = await request(authApp.app)
        .post(`/v1/api-keys/${id}/authenticate`)
        .send({ token })
        .expect(200);

      expect(res.body).toHaveProperty("status", "success");
      const { accessToken } = res.body.data;
      const accessTokenAuthContext = await authApp.authService.verifyToken({ token: accessToken });
      expect(accessTokenAuthContext).toHaveProperty("uid", uid);
      expect(accessTokenAuthContext).toHaveProperty("apiKey", true);
    });
  });
});
