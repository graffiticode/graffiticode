// POST /command and GET /command/:id (B5 slice 5, D1): the key is required, a
// new key needs COMMANDS_LNNNN on, an existing command is served whatever the
// flag says, a legacy key answers with its protocol, and the run's outcome is
// what the caller gets.
import express from "express";
import request from "supertest";
import { buildCommandRouter } from "./command.js";
import { PolicyRefused } from "../commands/policy-commands.js";

const UID = "0xuser";
const TASKS = [{ lang: "0176", code: { root: "save" } }];

let calls;
let policy;
let runs;
const build = env => {
  const app = express();
  app.use(express.json());
  app.use((/** @type {any} */ req, _res, next) => {
    req.auth = req.get("authorization") ? { context: { uid: UID } } : { context: null };
    next();
  });
  const taskStorer = { get: async () => TASKS, create: async () => "task-data" };
  app.use("/command", buildCommandRouter({ taskStorer, policy, run: async args => { runs.push(args); return { commandId: args.commandId, status: "completed", result: { state: "available" } }; }, worker: "w1", env }));
  return app;
};

beforeEach(() => {
  calls = [];
  runs = [];
  policy = {
    allocate: async args => { calls.push(["allocate", args]); return { protocol: "command", commandId: "c:1", generation: 1, owned: true, status: "pending", leaseExpiresAt: Date.now() + 60_000 }; },
    get: async args => { calls.push(["get", args]); throw new PolicyRefused("command-not-found"); },
    lease: async args => { calls.push(["lease", args]); return { generation: 2 }; },
  };
});

/** @type {(app: any, body: object, headers?: Record<string, string>) => any} */
const post = (app, body, headers = { authorization: "Bearer t" }) => request(app).post("/command").set(headers).send(body);
const BODY = { id: "task-save", connectionId: "conn-1", idempotencyKey: "job-1" };

describe("POST /command", () => {
  it("allocates, runs, and answers the outcome with a status URL", async () => {
    const res = await post(build({ COMMANDS_L0176: "on" }), BODY);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ commandId: "c:1", outcome: "completed", result: "available", statusUrl: "/command/c%3A1" });
    expect(calls[0][1]).toMatchObject({ connectionId: "conn-1", idempotencyKey: "job-1", lang: "0176", worker: "w1" });
    expect(JSON.parse(calls[0][1].request)).toEqual({ id: "task-save", connectionId: "conn-1", options: {} });
    expect(runs).toEqual([{ commandId: "c:1", generation: 1 }]);
  });

  it("requires a signed-in user, a connection and a key", async () => {
    const app = build({ COMMANDS_L0176: "on" });
    expect((await post(app, BODY, {})).status).toBe(401);
    expect((await post(app, { ...BODY, idempotencyKey: undefined })).status).toBe(400);
    expect((await post(app, { ...BODY, connectionId: undefined })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("asks only for the key's protocol while the flag is off: a new key is refused, an existing command served", async () => {
    const off = build({});
    policy.allocate = async args => { calls.push(["allocate", args]); return { protocol: "none" }; };
    const refused = await post(off, BODY);
    expect([refused.status, refused.body.error.reason]).toEqual([409, "commands-not-enabled"]);
    expect(calls[0][1].create).toBe(false);
    policy.allocate = async () => ({ protocol: "command", commandId: "c:1", generation: 1, owned: false, status: "completed", result: { state: "available" }, leaseExpiresAt: 0 });
    const served = await post(off, BODY);
    expect(served.status).toBe(200);
    expect(served.body.data.outcome).toBe("completed");
    expect(runs).toEqual([]);
  });

  it("refuses a chain with a flagged stage but no write, as a read with nothing to command", async () => {
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => { req.auth = { context: { uid: UID } }; next(); });
    policy.allocate = async args => { calls.push(["allocate", args]); return { protocol: "none" }; };
    app.use("/command", buildCommandRouter({ taskStorer: { get: async () => TASKS, create: async () => "task-data" }, policy, run: async () => ({}), worker: "w1", env: { COMMANDS_L0176: "on" }, eligible: async () => false }));
    const res = await post(app, BODY);
    expect([res.status, res.body.error.reason]).toEqual([409, "no-effects"]);
    expect(calls[0][1].create).toBe(false);
    expect(runs).toEqual([]);
  });

  it("serves a key the legacy path holds by that path, as a command outcome, whatever the flag", async () => {
    policy.allocate = async () => ({ protocol: "legacy", invocationId: "inv-1", seq: 1 });
    const legacyCalls = [];
    const legacy = async args => { legacyCalls.push(args); return { data: { saved: 1 }, errors: [], effects: [{ status: "succeeded" }] }; };
    for (const env of [{ COMMANDS_L0176: "on" }, {}]) {
      const app = express();
      app.use(express.json());
      app.use((/** @type {any} */ req, _res, next) => { req.auth = { context: { uid: UID } }; next(); });
      app.use("/command", buildCommandRouter({ taskStorer: { get: async () => TASKS, create: async () => "task-data" }, policy, run: async () => ({}), worker: "w1", env, legacy }));
      const res = await post(app, BODY);
      expect(res.body.data).toEqual({ protocol: "legacy", invocationId: "inv-1", outcome: "completed", result: "available", data: { saved: 1 } });
    }
    expect(legacyCalls[0]).toMatchObject({ id: "task-save", connectionId: "conn-1", idempotencyKey: "job-1" });
    expect(runs).toEqual([]);
  });

  it("answers pending for a command another worker holds, and takes over one whose lease expired", async () => {
    policy.allocate = async () => ({ protocol: "command", commandId: "c:1", generation: 1, owned: false, status: "pending", leaseExpiresAt: Date.now() + 60_000 });
    const app = build({ COMMANDS_L0176: "on" });
    expect((await post(app, BODY)).body.data.outcome).toBe("pending");
    expect(runs).toEqual([]);
    policy.allocate = async () => ({ protocol: "command", commandId: "c:1", generation: 1, owned: false, status: "pending", leaseExpiresAt: Date.now() - 1 });
    expect((await post(app, BODY)).body.data.outcome).toBe("completed");
    expect(runs).toEqual([{ commandId: "c:1", generation: 2 }]);
  });

  it("passes a conflicting key's refusal through", async () => {
    policy.allocate = async () => { throw new PolicyRefused("idempotency-key-reused"); };
    const res = await post(build({ COMMANDS_L0176: "on" }), BODY);
    expect(res.status).toBe(409);
    expect(res.body.error.reason).toBe("idempotency-key-reused");
  });
});

describe("GET /command/:id", () => {
  it("reads the command for its user", async () => {
    policy.get = async ({ commandId }) => ({ commandId, status: "partial", result: { state: "unavailable" } });
    const res = await request(build({})).get("/command/c%3A1").set({ authorization: "Bearer t" });
    expect(res.body.data).toEqual({ commandId: "c:1", outcome: "partial", result: "unavailable", statusUrl: "/command/c%3A1" });
  });

  it("says why a command whose admission was refused failed", async () => {
    policy.get = async ({ commandId }) => ({ commandId, status: "failed", result: { state: "none" }, admissionRefusal: { reason: "not-granted", at: "2026-11-10T00:00:00Z" } });
    const res = await request(build({})).get("/command/c%3A1").set({ authorization: "Bearer t" });
    expect(res.body.data).toEqual({ commandId: "c:1", outcome: "failed", result: "none", statusUrl: "/command/c%3A1", reason: "not-granted" });
  });

  it("answers 404 for another user's or an unknown command", async () => {
    const res = await request(build({})).get("/command/c%3A9").set({ authorization: "Bearer t" });
    expect(res.status).toBe(404);
  });
});
