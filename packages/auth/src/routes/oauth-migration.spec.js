/* eslint-disable camelcase */
// The migration contract's HTTP binding (oauth-migration.js) and the fenced
// answer of the routers the fence covers, with fake storers (no emulator).
import request from "supertest";
import { createHttpApp } from "@graffiticode/common/http";
import { MigrationFencedError } from "../storage/oauth-migration.js";
import { buildOAuthFlowRouter } from "./oauth-flow.js";
import { buildOAuthMigrationRouter } from "./oauth-migration.js";
import { buildOAuthTokensRouter } from "./oauth-tokens.js";

const KEY = "test-internal-key";
const OPERATOR = "test-operator-key";
const HASH = "a".repeat(64);

describe("routes/oauth-migration", () => {
  let calls;
  let app;
  let saved;
  beforeEach(() => {
    saved = { internal: process.env.INTERNAL_API_KEY, operator: process.env.OAUTH_MIGRATION_OPERATOR_KEY };
    process.env.INTERNAL_API_KEY = KEY;
    process.env.OAUTH_MIGRATION_OPERATOR_KEY = OPERATOR;
    calls = [];
    const record = name => async (...args) => { calls.push([name, ...args]); return { outcome: "applied" }; };
    const oauthMigrationStorer = {
      status: async installation => ({ contract: 1, fenced: installation === "graffiticode", sealed: false }),
      consume: record("consume"),
      markMigrated: record("markMigrated"),
      revoke: record("revoke"),
      inventory: async (installation, cursor) => { calls.push(["inventory", installation, cursor]); return { records: [], next: null }; },
      fence: async installation => { calls.push(["fence", installation]); return { fenced: true }; },
      seal: async installation => { calls.push(["seal", installation]); return { sealed: true }; },
    };
    app = createHttpApp(a => a.use("/oauth-migration/v1", buildOAuthMigrationRouter({ oauthMigrationStorer })));
  });
  afterEach(() => {
    for (const [k, v] of [["INTERNAL_API_KEY", saved.internal], ["OAUTH_MIGRATION_OPERATOR_KEY", saved.operator]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const post = (path, body) => request(app).post(`/oauth-migration/v1${path}`).set("X-Internal-API-Key", KEY).send(body);

  it("answers bare JSON, as the contract states it", async () => {
    const status = await request(app).get("/oauth-migration/v1/status?installation=graffiticode").set("X-Internal-API-Key", KEY).expect(200);
    expect(status.body).toEqual({ contract: 1, fenced: true, sealed: false });
    expect((await post("/mark-migrated", { installation: "graffiticode", hash: HASH, mode: "import", claim_id: "c1" }).expect(200)).body).toEqual({ outcome: "applied" });
    expect(calls).toEqual([["markMigrated", "graffiticode", HASH, "import", "c1"]]);
    await request(app).get("/oauth-migration/v1/inventory?installation=graffiticode&cursor=t:x").set("X-Internal-API-Key", KEY).expect(200);
    expect(calls.at(-1)).toEqual(["inventory", "graffiticode", "t:x"]);
  });

  it("refuses malformed input before the storer sees it", async () => {
    for (const [path, body] of [
      ["/consume", { installation: "graffiticode", kind: "token", hash: HASH, claim_id: "c" }],
      ["/consume", { installation: "graffiticode", kind: "code", hash: "short", claim_id: "c" }],
      ["/mark-migrated", { installation: "graffiticode", hash: HASH, mode: "copy", claim_id: "c" }],
      ["/mark-migrated", { installation: "Graffiticode", hash: HASH, mode: "import", claim_id: "c" }],
      ["/revoke", { installation: "graffiticode", hash: HASH.toUpperCase() }],
      ["/consume", { installation: "graffiticode", kind: "code", hash: HASH, claim_id: "" }],
    ]) await post(path, body).expect(400);
    expect(calls).toEqual([]);
  });

  it("needs the internal key everywhere, and the operator's key for the fence and the seal", async () => {
    await request(app).get("/oauth-migration/v1/status?installation=graffiticode").expect(403);
    await post("/fence", { installation: "graffiticode" }).expect(403);
    await post("/seal", { installation: "graffiticode" }).expect(403);
    await post("/fence", { installation: "graffiticode" }).set("X-Migration-Operator-Key", "wrong").expect(403);
    expect(calls).toEqual([]);
    await post("/fence", { installation: "graffiticode" }).set("X-Migration-Operator-Key", OPERATOR).expect(200);
    await post("/seal", { installation: "graffiticode" }).set("X-Migration-Operator-Key", OPERATOR).expect(200);
    expect(calls).toEqual([["fence", "graffiticode"], ["seal", "graffiticode"]]);
  });

  it("an operation the storer can't decide yet answers 503, which the contract's callers retry", async () => {
    const { UnavailableError } = await import("@graffiticode/common/errors");
    const oauthMigrationStorer = { markMigrated: async () => { throw new UnavailableError("index repair"); } };
    const unready = createHttpApp(a => a.use("/oauth-migration/v1", buildOAuthMigrationRouter({ oauthMigrationStorer })));
    await request(unready).post("/oauth-migration/v1/mark-migrated").set("X-Internal-API-Key", KEY)
      .send({ installation: "graffiticode", hash: HASH, mode: "import", claim_id: "c" }).expect(503);
  });

  it("without an operator key configured, nobody can fence", async () => {
    delete process.env.OAUTH_MIGRATION_OPERATOR_KEY;
    await post("/fence", { installation: "graffiticode" }).set("X-Migration-Operator-Key", "").expect(500);
    expect(calls).toEqual([]);
  });
});

describe("a write the fence refuses", () => {
  let saved;
  beforeEach(() => { saved = process.env.INTERNAL_API_KEY; process.env.INTERNAL_API_KEY = KEY; });
  afterEach(() => { if (saved === undefined) delete process.env.INTERNAL_API_KEY; else process.env.INTERNAL_API_KEY = saved; });
  const fenced = async () => { throw new MigrationFencedError(); };

  it("answers 409 migration_fenced on the flow routes", async () => {
    const app = createHttpApp(a => a.use("/oauth-codes", buildOAuthFlowRouter({ put: fenced, patch: fenced, remove: fenced, get: async () => ({ code: "c" }) })));
    for (const req of [request(app).put("/oauth-codes/c"), request(app).patch("/oauth-codes/c"), request(app).delete("/oauth-codes/c")]) {
      const res = await req.set("X-Internal-API-Key", KEY).send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("migration_fenced");
    }
    await request(app).get("/oauth-codes/c").set("X-Internal-API-Key", KEY).expect(200);
  });

  it("answers 409 migration_fenced on the token routes", async () => {
    const service = { rotateTokens: fenced, updateToken: fenced, deleteToken: fenced, createToken: fenced };
    const app = createHttpApp(a => a.use("/oauth-tokens", buildOAuthTokensRouter({ oauthTokensService: service })));
    const res = await request(app).post("/oauth-tokens/delete").set("X-Internal-API-Key", KEY).send({ access_token: "a" });
    expect([res.status, res.body.error]).toEqual([409, "migration_fenced"]);
  });
});
