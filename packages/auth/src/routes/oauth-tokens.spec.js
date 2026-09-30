/* eslint-disable camelcase */
import request from "supertest";
import { createHttpApp } from "@graffiticode/common/http";
import { buildOAuthTokensRouter } from "./oauth-tokens.js";

const KEY = "test-internal-key";

const buildFakeService = () => {
  const byAccess = new Map([["at-1", { access_token: "at-1", refresh_token: "rt-1", email: "a@b.c" }]]);
  const calls = [];
  return {
    calls,
    getByAccessToken: async t => byAccess.get(t) ?? null,
    getByRefreshToken: async t => [...byAccess.values()].find(e => e.refresh_token === t) ?? null,
    updateToken: async (t, updates) => { calls.push(["update", t, updates]); return { ...byAccess.get(t), ...updates }; },
    deleteToken: async t => { calls.push(["delete", t]); },
  };
};

describe("routes/oauth-tokens", () => {
  let service;
  let app;
  let prevKey;
  beforeEach(() => {
    prevKey = process.env.INTERNAL_API_KEY;
    process.env.INTERNAL_API_KEY = KEY;
    service = buildFakeService();
    app = createHttpApp(a => a.use("/oauth-tokens", buildOAuthTokensRouter({ oauthTokensService: service })));
  });
  afterEach(() => {
    process.env.INTERNAL_API_KEY = prevKey;
  });

  const post = path => request(app).post(`/oauth-tokens${path}`).set("X-Internal-API-Key", KEY);

  it("looks up an entry by access token or refresh token from the body", async () => {
    const byAccess = await post("/lookup").send({ access_token: "at-1" }).expect(200);
    expect(byAccess.body.data.token).toHaveProperty("refresh_token", "rt-1");
    const byRefresh = await post("/lookup").send({ refresh_token: "rt-1" }).expect(200);
    expect(byRefresh.body.data.token).toHaveProperty("access_token", "at-1");
  });

  it("reports an unknown token as not found and a missing one as a bad request", async () => {
    await post("/lookup").send({ access_token: "nope" }).expect(404);
    await post("/lookup").send({}).expect(400);
  });

  it("updates and deletes by the access token in the body", async () => {
    await post("/update").send({ access_token: "at-1", firebase_id_token: "id-2" }).expect(200);
    await post("/delete").send({ access_token: "at-1" }).expect(200);
    expect(service.calls).toEqual([
      ["update", "at-1", { firebase_id_token: "id-2" }],
      ["delete", "at-1"],
    ]);
  });

  it("refuses the body routes without the internal API key", async () => {
    await request(app).post("/oauth-tokens/lookup").send({ access_token: "at-1" }).expect(403);
  });

  it("no longer accepts a token in the URL", async () => {
    await request(app).get("/oauth-tokens?access_token=at-1").set("X-Internal-API-Key", KEY).expect(404);
    await request(app).delete("/oauth-tokens/at-1").set("X-Internal-API-Key", KEY).expect(404);
    await request(app).patch("/oauth-tokens/at-1").set("X-Internal-API-Key", KEY).send({ firebase_id_token: "x" }).expect(404);
    expect(service.calls).toEqual([]);
  });
});
