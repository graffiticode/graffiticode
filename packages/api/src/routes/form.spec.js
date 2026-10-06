import { jest } from "@jest/globals";

// Mock bent to avoid slow HTTP calls to external language compilers
jest.unstable_mockModule("bent", () => ({
  // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
  default: jest.fn(() => jest.fn().mockResolvedValue({})),
}));

// Dynamic imports after mock setup
const { startAuthApp } = await import("@graffiticode/auth/testing");
const { default: request } = await import("supertest");
const { createApp } = await import("../app.js");
const { clearFirestore } = await import("../testing/firestore.js");
const { TASK1 } = await import("../testing/fixture.js");
const { createError, createErrorResponse } = await import("./utils.js");

describe("routes/form", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

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

  it("should get a form by id for a task that has been created", async () => {
    const res = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", "ephemeral")
      .send({ task: TASK1 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const id = res.body.data.id;
    await request(app)
      .get("/form")
      .query({ id })
      .expect(302);
  });

  it("should carry a publication through to the view and its data url", async () => {
    const res = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", "ephemeral")
      .send({ task: TASK1 })
      .expect(200);
    const id = res.body.data.id;
    const redirect = await request(app)
      .get("/form")
      .query({ id, publication: "pub-1234" })
      .expect(302);
    const location = new URL(redirect.headers.location);
    expect(location.searchParams.get("publication")).toBe("pub-1234");
    expect(new URL(location.searchParams.get("url")).searchParams.get("publication")).toBe("pub-1234");
  });

  it("should refuse a connection from an anonymous caller", async () => {
    const res = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", "ephemeral")
      .send({ task: TASK1 })
      .expect(200);
    await request(app)
      .get("/form")
      .query({ id: res.body.data.id, connection: "conn-1" })
      .expect(400);
  });

  it("should handle missing params", async () => {
    await request(app)
      .get("/form")
      // `category` (spec FAIL-01, W3) is the one reviewed addition to this body.
      .expect(400, createErrorResponse({ ...createError(400, "Missing or invalid parameters"), category: "malformed" }));
  });

  it.skip("should handle bad id param", async () => {
    await request(app)
      .get("/form?id=xxx")
      .expect(400, createErrorResponse(createError(4001)));
  });
});
