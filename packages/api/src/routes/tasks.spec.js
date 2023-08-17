import { startAuthApp } from "@graffiticode/auth/testing";
import request from "supertest";
import { createApp } from "../app.js";
import { clearFirestore } from "../testing/firestore.js";
import {
  TASK1, TASK1_WITH_SRC, TASK2,
  CODE_AS_DATA, TASK_WITH_CODE_AS_DATA
} from "../testing/fixture.js";
import { createError, createErrorResponse, createSuccessResponse } from "./utils.js";
import { startLangApp } from "../testing/lang.js";

describe("routes/tasks", () => {
  let langApp;
  let authApp;
  let app;
  beforeEach(async () => {
    await clearFirestore();

    langApp = await startLangApp();

    authApp = await startAuthApp();
    app = createApp({ authUrl: authApp.url });

    process.env.BASE_URL_L0 = langApp.url;
    process.env.BASE_URL_L1 = langApp.url;
  });

  afterEach(async () => {
    await authApp.cleanUp();
    await langApp.cleanUp();
  });

  it("should create a task", async () => {
    const res = await request(app)
      .post("/tasks")
      .send({ task: TASK1 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const id = res.body.data.id;

    await request(app)
      .get("/tasks")
      .query({ id })
      .expect(200, createSuccessResponse({ data: [TASK1] }));
  });

  it("should create a task with code as data", async () => {
    const res = await request(app)
      .post("/tasks")
      .send({ tasks: TASK_WITH_CODE_AS_DATA })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const id = res.body.data.id;

    await request(app)
      .get("/tasks")
      .query({ id })
      .expect(200, createSuccessResponse({ data: [TASK_WITH_CODE_AS_DATA] }));
  });

  it("should create a task with source code", async () => {
    const res = await request(app)
      .post("/tasks")
      .send({ tasks: TASK1_WITH_SRC })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const id = res.body.data.id;

    await request(app)
      .get("/tasks")
      .query({ id })
      .expect(200, createSuccessResponse({ data: [TASK1] }));
  });

  it("should create multiple tasks", async () => {
    const res = await request(app)
      .post("/tasks")
      .send({ tasks: [TASK1, TASK2] })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const [id1, id2] = res.body.data.id;

    await request(app)
      .get("/tasks")
      .query({ id: id1 })
      .expect(200, createSuccessResponse({ data: [TASK1] }));
    await request(app)
      .get("/tasks")
      .query({ id: id2 })
      .expect(200, createSuccessResponse({ data: [TASK2] }));
  });

  it("should handle no task ids", async () => {
    await request(app)
      .get("/tasks")
      .expect(400, createErrorResponse(createError(400, "must provide at least one id")));
  });

  it("should get a task that has been created", async () => {
    const res = await request(app)
      .post("/tasks")
      .set("x-graffiticode-storage-type", "ephemeral")
      .send({ tasks: TASK1 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const id = res.body.data.id;

    await request(app)
      .get("/tasks")
      .query({ id })
      .expect(200, createSuccessResponse({ data: [TASK1] }));
  });

  it("should get a task that has been created with code as data", async () => {
    const res = await request(app)
      .post("/tasks")
      .set("x-graffiticode-storage-type", "ephemeral")
      .send({ tasks: TASK_WITH_CODE_AS_DATA })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const id = res.body.data.id;
    const res2 = await request(app)
      .get("/tasks")
      .query({ id })
      .expect(200);
    expect(res2).toHaveProperty("body.data[0].code", CODE_AS_DATA);
  });

  it("should get a task that has been created from source", async () => {
    const res = await request(app)
      .post("/tasks")
      .set("x-graffiticode-storage-type", "ephemeral")
      .send({ tasks: TASK1_WITH_SRC })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const id = res.body.data.id;
    await request(app)
      .get("/tasks")
      .query({ id })
      .expect(200, createSuccessResponse({ data: [TASK1] }));
  });

  it("should get a task with token that has been created with token", async () => {
    const { accessToken: token } = await authApp.authService.generateTokens({ uid: "1" });
    const res = await request(app)
      .post("/tasks")
      .set("Authorization", token)
      .set("x-graffiticode-storage-type", "ephemeral")
      .send({ tasks: TASK1 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const id = res.body.data.id;

    await request(app)
      .get("/tasks")
      .set("Authorization", token)
      .query({ id })
      .expect(200, createSuccessResponse({ data: [TASK1] }));
  });

  it("should return not found for a task that has been created with token", async () => {
    const { accessToken: token } = await authApp.authService.generateTokens({ uid: "1" });
    const res = await request(app)
      .post("/tasks")
      .set("Authorization", token)
      .set("x-graffiticode-storage-type", "ephemeral")
      .send({ tasks: TASK1 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const id = res.body.data.id;

    await request(app)
      .get("/tasks")
      .query({ id })
      .expect(404);
  });

  it("should get a task with token that has been created without a token", async () => {
    const { accessToken: token } = await authApp.authService.generateTokens({ uid: "1" });
    const res = await request(app)
      .post("/tasks")
      .set("x-graffiticode-storage-type", "ephemeral")
      .send({ tasks: TASK1 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const id = res.body.data.id;

    await request(app)
      .get("/tasks")
      .set("Authorization", token)
      .query({ id })
      .expect(200, createSuccessResponse({ data: [TASK1] }));
  });

  it("should get multiple tasks that have been created", async () => {
    const res1 = await request(app)
      .post("/tasks")
      .set("x-graffiticode-storage-type", "ephemeral")
      .send({ tasks: TASK1 });
    expect(res1).toHaveProperty("body.status", "success");
    const id1 = res1.body.data.id;
    const res2 = await request(app)
      .post("/tasks")
      .set("x-graffiticode-storage-type", "ephemeral")
      .send({ tasks: TASK2 });
    expect(res2).toHaveProperty("body.status", "success");
    const id2 = res2.body.data.id;

    await request(app)
      .get("/tasks")
      .query({ id: [id1, id2].join(",") })
      .expect(200, createSuccessResponse({ data: [TASK1, TASK2] }));
  });

  it("get from same storage type", async () => {
    const createResponse = await request(app)
      .post("/tasks")
      .set("x-graffiticode-storage-type", "persistent")
      .send({ tasks: TASK1 });
    expect(createResponse).toHaveProperty("body.status", "success");
    const id = createResponse.body.data.id;

    await request(app)
      .get("/tasks")
      .query({ id })
      .set("x-graffiticode-storage-type", "persistent")
      .expect(200, createSuccessResponse({ data: [TASK1] }));
  });
});
