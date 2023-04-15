import { startAuthApp } from "@graffiticode/auth/src/testing/app.js";
import request from "supertest";
import { createApp } from "../app.js";
import { clearFirestore } from "../testing/firestore.js";
import {
  TASK1, DATA1, DATA2, TASK2,
  CODE_AS_DATA, TASK_WITH_CODE_AS_DATA
} from "../testing/fixture.js";
import { createSuccessResponse } from "./utils.js";

describe("routes/data", () => {
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

  it("get multiple datas from different stores", async () => {
    const res1 = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", "ephemeral")
      .send({ task: TASK1 })
      .expect(200);
    expect(res1).toHaveProperty("body.status", "success");
    const id1 = res1.body.data.id;
    const res2 = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", "persistent")
      .send({ task: TASK2 });
    expect(res2).toHaveProperty("body.status", "success");
    const id2 = res2.body.data.id;
    await request(app)
      .get("/data")
      .query({ id: [id1, id2].join(",") })
      .expect(200, createSuccessResponse([DATA1, DATA2]));
  });
});

describe.each(["ephemeral", "persistent"])("/data[%s]", (storageType) => {
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

  it("get single data", async () => {
    const res = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", storageType)
      .send({ task: TASK1 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");

    const id = res.body.data.id;
    await request(app)
      .get("/data")
      .query({ id })
      .expect(200, createSuccessResponse(DATA1));
  });

  it("get single data from data task", async () => {
    const res = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", storageType)
      .send({ task: TASK_WITH_CODE_AS_DATA })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");

    const id = res.body.data.id;
    await request(app)
      .get("/data")
      .query({ id })
      .expect(200, createSuccessResponse(CODE_AS_DATA));
  });

  it("get single data using ephemeral flag", async () => {
    const res = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", storageType)
      .send({ task: TASK1 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");

    const id = res.body.data.id;
    const ephemeral = storageType === "memory";
    await request(app)
      .get("/data")
      .query({ id, ephemeral })
      .expect(200, createSuccessResponse(DATA1));
  });

  it("get multiple datas", async () => {
    const res1 = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", storageType)
      .send({ task: TASK1 })
      .expect(200);
    expect(res1).toHaveProperty("body.status", "success");
    const id1 = res1.body.data.id;
    const res2 = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", storageType)
      .send({ task: TASK2 });
    expect(res2).toHaveProperty("body.status", "success");
    const id2 = res2.body.data.id;

    await request(app)
      .get("/data")
      .query({ id: [id1, id2].join(",") })
      .expect(200, createSuccessResponse([DATA1, DATA2]));
  });

  it("get data with token created with token", async () => {
    const { accessToken: token } = await authApp.auth.generateTokens({ uid: "1" });
    const res = await request(app)
      .post("/task")
      .set("Authorization", token)
      .set("x-graffiticode-storage-type", storageType)
      .send({ task: TASK1 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const id = res.body.data.id;

    await request(app)
      .get("/data")
      .set("Authorization", token)
      .query({ id })
      .expect(200, createSuccessResponse(DATA1));
  });

  it("get data with token created without token", async () => {
    const { accessToken: token } = await authApp.auth.generateTokens({ uid: "1" });
    const res = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", storageType)
      .send({ task: TASK1 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const id = res.body.data.id;

    await request(app)
      .get("/data")
      .set("Authorization", token)
      .query({ id })
      .expect(200, createSuccessResponse(DATA1));
  });

  it("should not get data without token created with token", async () => {
    const { accessToken: token } = await authApp.auth.generateTokens({ uid: "1" });
    const res = await request(app)
      .post("/task")
      .set("Authorization", token)
      .set("x-graffiticode-storage-type", storageType)
      .send({ task: TASK1 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const id = res.body.data.id;

    await request(app)
      .get("/data")
      .query({ id })
      .expect(404);
  });
});
