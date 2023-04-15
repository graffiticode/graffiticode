import { startAuthApp } from "@graffiticode/auth/src/testing/app.js";
import request from "supertest";
import { createApp } from "./app.js";

describe("api", () => {
  let authApp;
  let app;
  beforeEach(async () => {
    authApp = await startAuthApp();
    app = createApp({ authUrl: authApp.url });
  });

  afterEach(async () => {
    if (authApp) {
      await authApp.cleanUp();
    }
  });

  it("GET /", (done) => {
    request(app)
      .get("/")
      .expect(200, "OK", done);
  });

  it("GET / with auth token", async () => {
    const { accessToken: token } = await authApp.auth.generateTokens({ uid: "1" });

    await request(app)
      .get("/")
      .set("Authorization", token)
      .expect(200);
  });

  it("GET / with invalid auth token", async () => {
    const token = "header.payload.signature";

    await request(app)
      .get("/")
      .set("Authorization", token)
      .expect(401);
  });
});
