import { startAuthApp } from "@graffiticode/auth/src/testing/app.js";
import request from "supertest";
import { createApp } from "../app.js";
import { TASK1, DATA1, TASK2, DATA2 } from "../testing/fixture.js";
import { createSuccessResponse, createErrorResponse, createError } from "./utils.js";

describe("routes/compile", () => {
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

  it("should compile source", async () => {
    await request(app)
      .post("/compile")
      .send({ item: TASK1 })
      .expect(200, createSuccessResponse(DATA1));
  });

  it("should compile item", async () => {
    await request(app)
      .post("/compile")
      .send({ item: { ...TASK1, data: { foo: "bar" } } })
      .expect(200, createSuccessResponse(DATA1));
  });

  it("should compile multiple items", async () => {
    let res;
    res = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", "persistent")
      .send({ task: TASK1 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const taskId1 = res.body.data.id;

    res = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", "persistent")
      .send({ task: TASK2 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const taskId2 = res.body.data.id;

    await request(app)
      .post("/compile")
      .send([{ id: taskId1, data: { a: 10 } }, { id: taskId2, data: { b: 20 } }])
      .expect(200, createSuccessResponse([DATA1, DATA2]));
  });

  it("should return invalid argument for no item", async () => {
    await request(app)
      .post("/compile")
      .send({ item: null })
      .expect(400, createErrorResponse(createError(400, "item must be a non-null object")));
  });
});
