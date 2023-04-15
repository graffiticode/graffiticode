import { startAuthApp } from "@graffiticode/auth/src/testing/app.js";
import request from "supertest";
import { createApp } from "../app.js";
import { clearFirestore } from "../testing/firestore.js";
import { TASK1 } from "../testing/fixture.js";
import { createError, createErrorResponse } from "./utils.js";

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

  it("should handle missing params", async () => {
    await request(app)
      .get("/form")
      .expect(400, createErrorResponse(createError(400, "Missing or invalid parameters")));
  });

  it("should handle bad lang param", async () => {
    await request(app)
      .get("/form?lang=xxx&data={}")
      .expect(400, createErrorResponse(createError(400, "Invalid lang xxx")));
  });

  it("should handle bad lang param", async () => {
    await request(app)
      .get("/form?lang=123456789&data={}")
      .expect(404, createErrorResponse(createError(404, "Language not found L123456789")));
  });
});
