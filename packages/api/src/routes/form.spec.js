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
const { createStorers } = await import("../storage/index.js");
const { buildFormRouter } = await import("./form.js");
const { default: express } = await import("express");
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

  // The compile generation (generation.js): with COMPILE_GENERATION_L0158 set,
  // an L0158 item renders in L0176's View and reads its data under it.
  describe("L0158 compile generation", () => {
    const L0158_TASK = { lang: "0158", code: TASK1.code };
    const ENV = ["COMPILE_GENERATION_L0158", "BASE_URL_L0158", "BASE_URL_L0176", "BASE_URL_L0000"];
    let saved;
    beforeEach(() => {
      saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
      delete process.env.COMPILE_GENERATION_L0158;
      process.env.BASE_URL_L0158 = "https://l0158.test";
      process.env.BASE_URL_L0176 = "https://l0176.test";
      process.env.BASE_URL_L0000 = "https://l0000.test";
    });
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    const postTask = async task => {
      const res = await request(app)
        .post("/task")
        .set("x-graffiticode-storage-type", "ephemeral")
        .send({ task })
        .expect(200);
      return res.body.data.id;
    };
    const formLocation = async (query, status = 302) => {
      const res = await request(app).get("/form").query(query).expect(status);
      return status === 302 ? new URL(res.headers.location) : res;
    };

    it("redirects an L0158 task to L0158's form when no generation is set", async () => {
      const id = await postTask(L0158_TASK);
      const location = await formLocation({ id });
      expect(location.origin).toBe("https://l0158.test");
      expect(location.pathname).toBe("/form");
      expect(location.searchParams.get("id")).toBe(id);
      const dataUrl = new URL(location.searchParams.get("url"));
      expect(dataUrl.pathname).toBe("/data");
      expect(dataUrl.searchParams.get("id")).toBe(id);
      expect(dataUrl.searchParams.has("generation")).toBe(false);
    });

    it("redirects an L0158 task to L0176's form with the generation on its data url", async () => {
      process.env.COMPILE_GENERATION_L0158 = "rel-2026-10-15.1";
      const id = await postTask(L0158_TASK);
      const location = await formLocation({ id, origin: "https://console.test" });
      expect(location.origin).toBe("https://l0176.test");
      expect(location.pathname).toBe("/form");
      expect(location.searchParams.get("id")).toBe(id);
      expect(location.searchParams.get("origin")).toBe("https://console.test");
      // The View's own URL doesn't carry it; only its data source does.
      expect(location.searchParams.has("generation")).toBe(false);
      const dataUrl = new URL(location.searchParams.get("url"));
      expect(dataUrl.pathname).toBe("/data");
      expect(dataUrl.searchParams.get("id")).toBe(id);
      expect(dataUrl.searchParams.get("generation")).toBe("rel-2026-10-15.1");
    });

    // A signed-in viewer, on the form router alone: bent is mocked in this
    // file, so the app can't validate a real token.
    const signedInForm = () => {
      const { taskStorer } = createStorers();
      const pingLang = jest.fn(async () => true);
      const getBaseUrlForLanguage = jest.fn(async (/** @type {string} */ lang) => `https://${lang.toLowerCase()}.test`);
      const formApp = express();
      formApp.use(express.json());
      formApp.use((req, _res, next) => {
        // The shape routes/auth.js gives a validated token.
        /** @type {any} */ (req).auth = { token: "tok", uid: "u1", context: { uid: "u1" } };
        next();
      });
      formApp.use("/form", buildFormRouter({ pingLang, getBaseUrlForLanguage })({ taskStorer }));
      return { formApp, taskStorer, pingLang, getBaseUrlForLanguage };
    };

    it("resolves L0176's base url for the viewer and keeps the access token on both urls", async () => {
      process.env.COMPILE_GENERATION_L0158 = "g1";
      const { formApp, taskStorer, pingLang, getBaseUrlForLanguage } = signedInForm();
      const id = await taskStorer.create({ task: L0158_TASK, auth: null });
      const res = await request(formApp).get("/form").query({ id, access_token: "tok" }).expect(302);
      const location = new URL(res.headers.location);
      expect(location.origin).toBe("https://l0176.test");
      // The viewer's uid, so a language override on L0176 still applies.
      expect(getBaseUrlForLanguage).toHaveBeenCalledWith("L0176", { uid: "u1" });
      expect(pingLang).toHaveBeenCalledWith("L0176", { uid: "u1" });
      expect(location.searchParams.get("access_token")).toBe("tok");
      const dataUrl = new URL(location.searchParams.get("url"));
      expect(dataUrl.searchParams.get("access_token")).toBe("tok");
      expect(dataUrl.searchParams.get("generation")).toBe("g1");
    });

    it("refuses an L0158 view through a connection once a generation is set", async () => {
      const { formApp, taskStorer } = signedInForm();
      const id = await taskStorer.create({ task: L0158_TASK, auth: null });
      // Unset, a connection is carried as today.
      const before = await request(formApp).get("/form").query({ id, connection: "conn-1" }).expect(302);
      expect(new URL(before.headers.location).origin).toBe("https://l0158.test");
      expect(new URL(before.headers.location).searchParams.get("connection")).toBe("conn-1");
      process.env.COMPILE_GENERATION_L0158 = "g1";
      const res = await request(formApp).get("/form").query({ id, connection: "conn-1" }).expect(400);
      expect(res.body.error.message).toMatch(/can't be viewed through a connection/);
    });

    it("treats a malformed generation as unset", async () => {
      process.env.COMPILE_GENERATION_L0158 = "a/b";
      const id = await postTask(L0158_TASK);
      const location = await formLocation({ id });
      expect(location.origin).toBe("https://l0158.test");
      expect(new URL(location.searchParams.get("url")).searchParams.has("generation")).toBe(false);
    });

    it.each([[undefined], ["g1"]])("leaves a non-L0158 task alone (generation %s)", async (generation) => {
      if (generation) process.env.COMPILE_GENERATION_L0158 = generation;
      const id = await postTask(TASK1);
      const location = await formLocation({ id });
      expect(location.origin).toBe("https://l0000.test");
      expect(new URL(location.searchParams.get("url")).searchParams.has("generation")).toBe(false);
    });

    it("leaves a chain with a non-L0158 stage on its head's form", async () => {
      process.env.COMPILE_GENERATION_L0158 = "g1";
      const { taskStorer } = createStorers();
      const id = taskStorer.appendIds(await postTask(L0158_TASK), await postTask(TASK1));
      const location = await formLocation({ id });
      expect(location.origin).toBe("https://l0158.test");
      expect(new URL(location.searchParams.get("url")).searchParams.has("generation")).toBe(false);
    });
  });
});
