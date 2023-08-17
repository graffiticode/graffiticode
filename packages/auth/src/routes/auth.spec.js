import request from "supertest";
import { cleanUpFirebase } from "../testing/firebase.js";
import { createApp } from "../app.js";

describe("routes/auth", () => {
  let authService;
  let app;
  let auth;
  beforeEach(async () => {
    const authApp = createApp();
    authService = authApp.authService;
    app = authApp.app;
    auth = null;
    authApp.app.use("/for-testing", (req, res) => {
      auth = req.auth;
      res.sendStatus(200);
    });
  });

  afterEach(async () => {
    await cleanUpFirebase();
  });

  it("should set auth to null if no token", async () => {
    await request(app)
      .get("/for-testing")
      .expect(200, "OK");

    expect(auth).toBe(null);
  });

  it("should return 401 if invalid token", async () => {
    await request(app)
      .get("/for-testing")
      .set({ Authorization: "invalid-token" })
      .expect(401);
  });

  it("should populate auth context for valid token", async () => {
    const uid = "abc123";
    const { accessToken } = await authService.generateTokens({ uid });

    await request(app)
      .get("/for-testing")
      .set({ Authorization: accessToken })
      .expect(200, "OK");

    expect(auth).toHaveProperty("uid", uid);
  });

  it("should populate auth context for valid token with Bearer prefix", async () => {
    const uid = "abc123";
    const { accessToken } = await authService.generateTokens({ uid });

    await request(app)
      .get("/for-testing")
      .set({ Authorization: `Bearer ${accessToken}` })
      .expect(200, "OK");

    expect(auth).toHaveProperty("uid", uid);
  });

  it("should populate auth context for valid token in query", async () => {
    const uid = "abc123";
    const { accessToken } = await authService.generateTokens({ uid });

    await request(app)
      .get("/for-testing")
      .query({ access_token: accessToken })
      .expect(200, "OK");

    expect(auth).toHaveProperty("uid", uid);
  });

  it("should populate additional claims in auth context", async () => {
    const uid = "abc123";
    const { accessToken } = await authService.generateTokens({ uid, additionalClaims: { apiKey: true } });

    await request(app)
      .get("/for-testing")
      .set({ Authorization: accessToken })
      .expect(200, "OK");

    expect(auth).toHaveProperty("uid", uid);
    expect(auth).toHaveProperty("token.apiKey", true);
  });
});
