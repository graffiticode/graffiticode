import { startAuthApp } from "@graffiticode/auth/testing";
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

  // cors() answers every preflight before any router sees it.
  it.each(["/data", "/compile", "/task", "/form", "/preview/sign", "/publications", "/lang-overrides"])("OPTIONS %s is a CORS preflight", async path => {
    const res = await request(app)
      .options(path)
      .set("Origin", "https://console.test")
      .set("Access-Control-Request-Method", "POST")
      .expect(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("GET / with auth token", async () => {
    const { accessToken: token } = await authApp.authService.generateTokens({ uid: "1" });

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
