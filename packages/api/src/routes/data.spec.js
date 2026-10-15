import { startAuthApp } from "@graffiticode/auth/testing";
import request from "supertest";
import { createApp } from "../app.js";
import { clearFirestore } from "../testing/firestore.js";
import { TASK1, DATA1, DATA2, TASK2 } from "../testing/fixture.js";
import { startLangApp } from "../testing/lang.js";
import { createSuccessResponse } from "./utils.js";
import { admin } from "../storage/firebase.js";
import { createStorers } from "../storage/index.js";

describe.each(["ephemeral", "persistent"])("routes/data[%s]", (storageType) => {
  let langApp;
  let authApp;
  let app;
  beforeEach(async () => {
    await clearFirestore();

    langApp = await startLangApp();
    langApp.setData(TASK1.code, DATA1);
    langApp.setData(TASK2.code, DATA2);

    authApp = await startAuthApp();
    app = createApp({ authUrl: authApp.url });

    process.env.BASE_URL_L0000 = langApp.url;
  });

  afterEach(async () => {
    await authApp.cleanUp();
    await langApp.cleanUp();
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
      .expect(200, createSuccessResponse({ data: DATA1 }));
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
      .expect(200, createSuccessResponse({ data: DATA1 }));
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
      .expect(200, createSuccessResponse({ data: [DATA1, DATA2] }));
  });

  it("get data with token created with token", async () => {
    const { accessToken: token } = await authApp.authService.generateTokens({ uid: "1" });
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
      .expect(200, createSuccessResponse({ data: DATA1 }));
  });

  it("get data with token created without token", async () => {
    const { accessToken: token } = await authApp.authService.generateTokens({ uid: "1" });
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
      .expect(200, createSuccessResponse({ data: DATA1 }));
  });

  it("should not get data without token created with token", async () => {
    const { accessToken: token } = await authApp.authService.generateTokens({ uid: "1" });
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

// The compile generation (generation.js), end to end through a fake L0158
// language server.
describe("routes/data compile generation", () => {
  const L0158_TASK = { lang: "0158", code: TASK1.code };
  const OLD = { val: "old compiler" };
  const NEW = { val: "new compiler" };
  const ENV = ["COMPILE_GENERATION_L0158", "BASE_URL_L0158", "BASE_URL_L0000"];
  let saved;
  let langApp;
  let authApp;
  let app;
  beforeEach(async () => {
    await clearFirestore();
    saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
    delete process.env.COMPILE_GENERATION_L0158;
    langApp = await startLangApp();
    process.env.BASE_URL_L0158 = langApp.url;
    process.env.BASE_URL_L0000 = langApp.url;
    authApp = await startAuthApp();
    app = createApp({ authUrl: authApp.url });
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await authApp.cleanUp();
    await langApp.cleanUp();
  });

  const postTask = async task => {
    const res = await request(app)
      .post("/task")
      .set("x-graffiticode-storage-type", "persistent")
      .send({ task })
      .expect(200);
    return res.body.data.id;
  };
  const stored = async key => {
    const doc = await admin.firestore().doc(`compiles/${key}`).get();
    return doc.exists ? JSON.parse(doc.data().data) : undefined;
  };

  it("leaves a request without the parameter as it was", async () => {
    process.env.COMPILE_GENERATION_L0158 = "g1";
    langApp.setData(L0158_TASK.code, OLD);
    const id = await postTask(L0158_TASK);
    await request(app).get("/data").query({ id }).expect(200, createSuccessResponse({ data: OLD }));
    expect(await stored(id)).toStrictEqual(OLD);
    expect(await stored(`${id}@g1`)).toBeUndefined();
  });

  it("serves the active generation with the same cache headers", async () => {
    process.env.COMPILE_GENERATION_L0158 = "g1";
    langApp.setData(L0158_TASK.code, NEW);
    const id = await postTask(L0158_TASK);
    const plain = await request(app).get("/data").query({ id }).expect(200);
    const scoped = await request(app).get("/data").query({ id, generation: "g1" }).expect(200, createSuccessResponse({ data: NEW }));
    expect(scoped.headers["cache-control"]).toBe(plain.headers["cache-control"]);
    expect(await stored(`${id}@g1`)).toStrictEqual(NEW);
  });

  it("refuses a generation when none is active", async () => {
    const id = await postTask(L0158_TASK);
    const res = await request(app).get("/data").query({ id, generation: "g1" }).expect(400);
    expect(res.body.error.message).toMatch(/no compile generation is active/);
    expect(langApp.calls()).toBe(0);
  });

  it("refuses a generation that isn't the active one", async () => {
    process.env.COMPILE_GENERATION_L0158 = "g1";
    const id = await postTask(L0158_TASK);
    const res = await request(app).get("/data").query({ id, generation: "g2" }).expect(400);
    expect(res.body.error.message).toMatch(/not the active compile generation/);
    await request(app).get("/data").query({ id, generation: "" }).expect(400);
    await request(app).get(`/data?id=${id}&generation=g1&generation=g1`).expect(400);
    expect(langApp.calls()).toBe(0);
    expect(await stored(`${id}@g2`)).toBeUndefined();
  });

  it("refuses a generation for a non-L0158 task or a chain with one", async () => {
    process.env.COMPILE_GENERATION_L0158 = "g1";
    const other = await postTask(TASK1);
    const { taskStorer } = createStorers();
    const chain = taskStorer.appendIds(await postTask(L0158_TASK), other);
    for (const id of [other, chain]) {
      const res = await request(app).get("/data").query({ id, generation: "g1" }).expect(400);
      expect(res.body.error.message).toMatch(/only to L0158 tasks/);
    }
    expect(langApp.calls()).toBe(0);
  });

  // THE RACE: a handler without the generation holds its compile open past
  // activation and past the cleanup of compiles/{id}, then writes. It may be on
  // another instance (an earlier api revision, which never knew the
  // parameter) or on this one, started before the generation was set.
  it.each([
    ["another api instance", true],
    ["the same api instance", false],
  ])("never serves a stale write from %s to a generation-scoped read", async (_, separate) => {
    const oldApp = separate ? createApp({ authUrl: authApp.url }) : app;
    langApp.setData(L0158_TASK.code, OLD);
    const id = await postTask(L0158_TASK);
    const held = langApp.hold();
    const oldResponse = request(oldApp).get("/data").query({ id }).then(res => res);
    await held.arrived;

    // Activation, the cleanup, and the new compiler, all while it's held.
    process.env.COMPILE_GENERATION_L0158 = "g1";
    await admin.firestore().doc(`compiles/${id}`).delete();
    langApp.setData(L0158_TASK.code, NEW);

    await request(app).get("/data").query({ id, generation: "g1" }).expect(200, createSuccessResponse({ data: NEW }));
    expect(langApp.calls()).toBe(2);

    // The old handler finishes: its stale result lands under the old key only.
    held.release();
    const old = await oldResponse;
    expect(old.status).toBe(200);
    expect(old.body.data).toStrictEqual(OLD);
    expect(await stored(id)).toStrictEqual(OLD);
    expect(await stored(`${id}@g1`)).toStrictEqual(NEW);

    // Scoped reads keep answering the new output, from the store.
    await request(app).get("/data").query({ id, generation: "g1" }).expect(200, createSuccessResponse({ data: NEW }));
    expect(langApp.calls()).toBe(2);
  });

  it("compiles fresh on the first scoped read after the stale write lands", async () => {
    // The same race, with the stale write arriving before any scoped read.
    langApp.setData(L0158_TASK.code, OLD);
    const id = await postTask(L0158_TASK);
    const held = langApp.hold();
    const oldResponse = request(app).get("/data").query({ id }).then(res => res);
    await held.arrived;
    process.env.COMPILE_GENERATION_L0158 = "g1";
    await admin.firestore().doc(`compiles/${id}`).delete();
    langApp.setData(L0158_TASK.code, NEW);
    held.release();
    await oldResponse;
    expect(await stored(id)).toStrictEqual(OLD);

    await request(app).get("/data").query({ id, generation: "g1" }).expect(200, createSuccessResponse({ data: NEW }));
    expect(langApp.calls()).toBe(2);
  });
});
