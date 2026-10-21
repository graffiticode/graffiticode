import { UnauthenticatedError } from "@graffiticode/common/errors";
import request from "supertest";
import { startAuthApp } from "../../testing/app.js";
import admin from "firebase-admin";
import { getFirestore } from "../../firebase.js";
import { cleanUpFirebase } from "../../testing/firebase.js";

const uid = "abc123";

describe("routes/v1/ethereum", () => {
  let authApp;
  beforeEach(async () => {
    authApp = await startAuthApp();
  });

  afterEach(async () => {
    await authApp.cleanUp();
    await cleanUpFirebase();
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

  describe("clean-expired", () => {
    const internalApiKey = "test-internal-key";
    let savedInternalApiKey;
    beforeEach(() => {
      savedInternalApiKey = process.env.INTERNAL_API_KEY;
      process.env.INTERNAL_API_KEY = internalApiKey;
    });
    afterEach(() => {
      if (savedInternalApiKey === undefined) {
        delete process.env.INTERNAL_API_KEY;
      } else {
        process.env.INTERNAL_API_KEY = savedInternalApiKey;
      }
    });

    it("should reject requests without the internal API key", async () => {
      const res = await request(authApp.app)
        .post("/v1/refresh-tokens/clean-expired");
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it("should reject requests with a wrong internal API key", async () => {
      const res = await request(authApp.app)
        .post("/v1/refresh-tokens/clean-expired")
        .set("X-Internal-API-Key", "wrong-key");
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it("should delete expired tokens and leave active ones", async () => {
      const { refreshToken: activeToken } = await authApp.authService.generateTokens({ uid });
      const { refreshToken: expiredToken } = await authApp.authService.generateTokens({ uid });

      const db = getFirestore();
      const tokenToIdRef = db.doc(`refresh-tokens/-indexes-/token-to-id/${expiredToken}`);
      const tokenToIdDoc = await tokenToIdRef.get();
      const expiredId = tokenToIdDoc.get("id");

      const pastTime = admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
      await db.doc(`refresh-tokens/${expiredId}`).update({ expiresAt: pastTime });

      await request(authApp.app)
        .post("/v1/refresh-tokens/clean-expired")
        .set("X-Internal-API-Key", internalApiKey)
        .expect(200);

      await expect(authApp.authService.getRefreshToken({ refreshToken: activeToken })).resolves.toBeDefined();
      await expect(authApp.authService.getRefreshToken({ refreshToken: expiredToken })).rejects.toThrow();
    });
  });

  describe("clean-expired with the cleanup-only key", () => {
    let saved;
    beforeEach(() => { saved = process.env.CLEANUP_API_KEY; process.env.CLEANUP_API_KEY = "test-cleanup-key"; });
    afterEach(() => { if (saved === undefined) delete process.env.CLEANUP_API_KEY; else process.env.CLEANUP_API_KEY = saved; });

    it("deletes expired tokens with the cleanup key, and refuses a wrong one", async () => {
      const { refreshToken: activeToken } = await authApp.authService.generateTokens({ uid });
      const { refreshToken: expiredToken } = await authApp.authService.generateTokens({ uid });
      const db = getFirestore();
      const expiredId = (await db.doc(`refresh-tokens/-indexes-/token-to-id/${expiredToken}`).get()).get("id");
      await db.doc(`refresh-tokens/${expiredId}`).update({ expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000) });

      await request(authApp.app).post("/v1/refresh-tokens/clean-expired").set("X-Cleanup-API-Key", "wrong").expect(403);
      await expect(authApp.authService.getRefreshToken({ refreshToken: expiredToken })).resolves.toBeDefined();

      await request(authApp.app).post("/v1/refresh-tokens/clean-expired").set("X-Cleanup-API-Key", "test-cleanup-key").expect(200);
      await expect(authApp.authService.getRefreshToken({ refreshToken: activeToken })).resolves.toBeDefined();
      await expect(authApp.authService.getRefreshToken({ refreshToken: expiredToken })).rejects.toThrow();
    });
  });

  describe("sessions", () => {
    it("should return 401 if unauthenticated", async () => {
      await request(authApp.app)
        .get("/v1/refresh-tokens/sessions")
        .expect(401);
    });

    it("should return active sessions for the user", async () => {
      const { accessToken } = await authApp.authService.generateTokens({ uid });

      const res = await request(authApp.app)
        .get("/v1/refresh-tokens/sessions")
        .set("Authorization", accessToken)
        .expect(200);

      expect(res.body).toHaveProperty("status", "success");
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThan(0);
      const session = res.body.data[0];
      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("createdAt");
      expect(session).toHaveProperty("expiresAt");
      expect(session).toHaveProperty("additionalClaims");
    });
  });

  describe("session details", () => {
    it("marks the caller's session as current and returns its sign-in details", async () => {
      const { accessToken, refreshToken } = await authApp.authService.generateTokens({ uid, meta: { method: "wallet", userAgent: "UA-1" } });
      await authApp.authService.generateTokens({ uid, meta: { method: "email", userAgent: "UA-2" } });

      const res = await request(authApp.app)
        .get("/v1/refresh-tokens/sessions")
        .set("Authorization", accessToken)
        .set("X-Refresh-Token", refreshToken)
        .expect(200);
      const current = res.body.data.filter(s => s.current);
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({ method: "wallet", userAgent: "UA-1" });
      expect(res.body.data.find(s => !s.current)).toMatchObject({ method: "email", userAgent: "UA-2" });

      const none = await request(authApp.app)
        .get("/v1/refresh-tokens/sessions")
        .set("Authorization", accessToken)
        .expect(200);
      expect(none.body.data.some(s => s.current)).toBe(false);
    });
  });

  describe("API-key access tokens", () => {
    it("are refused on every session route", async () => {
      await authApp.authService.generateTokens({ uid });
      const { id, token } = await authApp.apiKeyService.create({ uid });
      const authContext = await authApp.apiKeyService.authenticateWithId({ id, token });
      const accessToken = await authApp.authService.createAccessToken(authContext);

      await request(authApp.app).get("/v1/refresh-tokens/sessions").set("Authorization", accessToken).expect(403);
      await request(authApp.app).delete("/v1/refresh-tokens/sessions/some-id").set("Authorization", accessToken).expect(403);
      await request(authApp.app).delete("/v1/refresh-tokens/sessions").set("Authorization", accessToken).expect(403);

      // Nothing was ended.
      const { accessToken: personal } = await authApp.authService.generateTokens({ uid });
      const res = await request(authApp.app).get("/v1/refresh-tokens/sessions").set("Authorization", personal).expect(200);
      expect(res.body.data).toHaveLength(2);
    });
  });

  describe("delete session", () => {
    it("should return 401 if unauthenticated", async () => {
      await request(authApp.app)
        .delete("/v1/refresh-tokens/sessions/some-id")
        .expect(401);
    });

    it("should delete the specified session", async () => {
      const { accessToken } = await authApp.authService.generateTokens({ uid });

      const listRes = await request(authApp.app)
        .get("/v1/refresh-tokens/sessions")
        .set("Authorization", accessToken)
        .expect(200);

      const sessionId = listRes.body.data[0].id;

      await request(authApp.app)
        .delete(`/v1/refresh-tokens/sessions/${sessionId}`)
        .set("Authorization", accessToken)
        .expect(200);

      const listRes2 = await request(authApp.app)
        .get("/v1/refresh-tokens/sessions")
        .set("Authorization", accessToken)
        .expect(200);
      expect(listRes2.body.data).toHaveLength(0);
    });
  });

  describe("delete all sessions", () => {
    it("should return 401 if unauthenticated", async () => {
      await request(authApp.app)
        .delete("/v1/refresh-tokens/sessions")
        .expect(401);
    });

    it("should delete all sessions for user", async () => {
      const { accessToken } = await authApp.authService.generateTokens({ uid });
      await authApp.authService.generateTokens({ uid });

      const listRes = await request(authApp.app)
        .get("/v1/refresh-tokens/sessions")
        .set("Authorization", accessToken)
        .expect(200);
      expect(listRes.body.data.length).toBe(2);

      await request(authApp.app)
        .delete("/v1/refresh-tokens/sessions")
        .set("Authorization", accessToken)
        .expect(200);

      const listRes2 = await request(authApp.app)
        .get("/v1/refresh-tokens/sessions")
        .set("Authorization", accessToken)
        .expect(200);
      expect(listRes2.body.data).toHaveLength(0);
    });

    it("should keep the session for the refreshToken in the body", async () => {
      const { accessToken, refreshToken } = await authApp.authService.generateTokens({ uid });
      await authApp.authService.generateTokens({ uid });
      await authApp.authService.generateTokens({ uid });

      await request(authApp.app)
        .delete("/v1/refresh-tokens/sessions")
        .set("Authorization", accessToken)
        .send({ refreshToken })
        .expect(200);

      const listRes = await request(authApp.app)
        .get("/v1/refresh-tokens/sessions")
        .set("Authorization", accessToken)
        .expect(200);
      expect(listRes.body.data).toHaveLength(1);
      await expect(authApp.authService.getRefreshToken({ refreshToken })).resolves.toBeDefined();
    });
  });
});
