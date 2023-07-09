import { createHttpApp } from "@graffiticode/common/http";
import request from "supertest";
import { createServices } from "../services/index.js";
import { createStorers } from "../storage/index.js";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildGraffiticodeAuthenticator } from "./auth.js";

describe("routes/auth", () => {
  let services;
  let app;
  let auth;
  beforeEach(async () => {
    const storers = createStorers();
    services = createServices(storers);
    app = createHttpApp(a => {
      a.use(buildGraffiticodeAuthenticator(services));
      a.use((req, res) => {
        auth = req.auth;
        res.sendStatus(200);
      });
    });
  });

  afterEach(async () => {
    await cleanUpFirebase();
  });

  it("should set auth to null if no token", async () => {
    await request(app)
      .get("/")
      .expect(200, "OK");

    expect(auth).toBe(null);
  });

  it("should return 401 if invalid token", async () => {
    await request(app)
      .get("/")
      .set({ Authorization: "invalid-token" })
      .expect(401);
  });

  it("should populate auth context for valid token", async () => {
    const uid = "abc123";
    const { accessToken } = await services.authService.generateTokens({ uid });

    await request(app)
      .get("/")
      .set({ Authorization: accessToken })
      .expect(200, "OK");

    expect(auth).toHaveProperty("uid", uid);
  });

  it("should populate auth context for valid token with Bearer prefix", async () => {
    const uid = "abc123";
    const { accessToken } = await services.authService.generateTokens({ uid });

    await request(app)
      .get("/")
      .set({ Authorization: `Bearer ${accessToken}` })
      .expect(200, "OK");

    expect(auth).toHaveProperty("uid", uid);
  });

  it("should populate auth context for valid token in query", async () => {
    const uid = "abc123";
    const { accessToken } = await services.authService.generateTokens({ uid });

    await request(app)
      .get("/")
      .query({ access_token: accessToken })
      .expect(200, "OK");

    expect(auth).toHaveProperty("uid", uid);
  });

  it("should populate additional claims in auth context", async () => {
    const uid = "abc123";
    const { accessToken } = await services.authService.generateTokens({ uid, additionalClaims: { apiKey: true } });

    await request(app)
      .get("/")
      .set({ Authorization: accessToken })
      .expect(200, "OK");

    expect(auth).toHaveProperty("uid", uid);
    expect(auth).toHaveProperty("token.apiKey", true);
  });
});
