import { startAuthApp } from "@graffiticode/auth/testing";
import request from "supertest";
import { createApp } from "../app.js";
import { TASK1, DATA1, TASK2, DATA2 } from "../testing/fixture.js";
import { startLangApp } from "../testing/lang.js";
import { createSuccessResponse, createErrorResponse, createError } from "./utils.js";

describe("routes/compile", () => {
  let langApp;
  let authApp;
  let app;

  beforeEach(async () => {
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

  it("should compile source", async () => {
    langApp.setData(TASK1.code, DATA1);
    const res = await request(app)
      .post("/compile")
      .send({ item: TASK1 });

    expect(res.body).toEqual(
      expect.objectContaining(
        createSuccessResponse({ data: DATA1 })
      )
    );
  });

  it("should compile item", async () => {
    langApp.setData({ foo: "bar" }, "meow");
    langApp.setData(TASK1.code, DATA1);
    const res = await request(app)
      .post("/compile")
      .send({ item: { ...TASK1, data: { foo: "bar" } } });

    expect(res.body).toEqual(
      expect.objectContaining(
        createSuccessResponse({ data: DATA1 })
      )
    );
  });

  it.skip("should compile multiple items", async () => {
    let res;
    res = await request(app)
      .post("/task")
      .send({ task: TASK1 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const taskId1 = res.body.data.id;

    res = await request(app)
      .post("/task")
      .send({ task: TASK2 })
      .expect(200);
    expect(res).toHaveProperty("body.status", "success");
    const taskId2 = res.body.data.id;

    await request(app)
      .post("/compile")
      .send([{ id: taskId1, data: { a: 10 } }, { id: taskId2, data: { b: 20 } }])
      .expect(200, createSuccessResponse({ data: [DATA1, DATA2] }));
  });

  it("should return invalid argument for no item", async () => {
    await request(app)
      .post("/compile")
      .send({ item: null })
      .expect(400, createErrorResponse(createError(400, "item must be a non-null object")));
  });
});
