// System preview signing at the api (plan: system preview signing rate
// limits, step 2): the per-client limit charged per signing stage on
// POST /compile, GET /data and POST /preview/sign; the stateless signing
// endpoint; and the api's identity on every compile to L0176. Through the
// real app (app.js) against the fake language server.
import request from "supertest";
import { createApp } from "./app.js";
import { createApiAudit } from "./audit.js";
import { buildSigningLimiter, SigningRateLimited } from "./signing-limit.js";
import { INIT_DATA_CODE, PREVIEW_SIGN_LIMIT_BYTES } from "./routes/preview.js";
import { createStorers } from "./storage/index.js";
import { admin } from "./storage/firebase.js";
import { clearFirestore } from "./testing/firestore.js";
import { TASK1, DATA1 } from "./testing/fixture.js";
import { startLangApp } from "./testing/lang.js";

const l0176 = text => ({ lang: "0176", code: { 1: { tag: "STR", elts: [text] }, 2: { tag: "EXPRS", elts: [1] }, root: 2 } });
const TASK_A = l0176("a");
const TASK_B = l0176("b");
const SIGNED = { questions: [{ type: "mcq" }], security: { consumerKey: "k", domain: "l0176.graffiticode.org", signature: "sig" }, request: {} };
const PREVIEW = { data: { type: "questions", data: { questions: [] } }, errors: [], cache: false };
const MINTED = "id-token-for-urn:graffiticode:0176";
const SECRET = "edge-secret-0123456789";

const validateToken = async token => {
  if (!token.startsWith("user:")) throw new Error("bad user token");
  return { uid: token.slice(5) };
};

// Every document, by collection: what a request stored.
const snapshot = async () => {
  const db = admin.firestore();
  const out = {};
  for (const col of await db.listCollections()) {
    const docs = await col.get();
    out[col.id] = docs.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  return out;
};

let langApp;
let taskStorer;
let records;
let charges;
const recordingLimiter = { charge: async (_req, stages) => { charges.push(stages); } };
const appWith = (over = {}) => createApp(/** @type {any} */ ({
  validateToken,
  callerIdToken: async audience => `id-token-for-${audience}`,
  audit: createApiAudit({ sink: r => records.push(r) }),
  signingLimiter: recordingLimiter,
  ...over,
}));
const total = () => charges.reduce((a, b) => a + b, 0);

beforeEach(async () => {
  await clearFirestore();
  langApp = await startLangApp();
  process.env.BASE_URL_L0000 = langApp.url;
  process.env.BASE_URL_L0176 = langApp.url;
  langApp.setData(TASK1.code, DATA1);
  langApp.setData(TASK_A.code, PREVIEW);
  langApp.setData(TASK_B.code, PREVIEW);
  langApp.setData(INIT_DATA_CODE, { data: SIGNED, errors: [], cache: false });
  ({ taskStorer } = createStorers());
  records = [];
  charges = [];
});

afterEach(async () => {
  await langApp.cleanUp();
});

describe("charging, per signing stage, before dispatch", () => {
  it("one L0176 item is one stage", async () => {
    await request(appWith()).post("/compile").send({ item: { ...TASK_A, data: {} } }).expect(200);
    expect(charges).toEqual([1]);
  });

  it("a batch of items sums its stages", async () => {
    await request(appWith()).post("/compile").send([{ ...TASK_A }, { ...TASK_B }, { ...TASK1 }]).expect(200);
    expect(charges).toEqual([2]);
  });

  it("an item by id is charged its chain's stages", async () => {
    const a = await taskStorer.create({ task: TASK_A });
    const b = await taskStorer.create({ task: TASK_B });
    await request(appWith()).post("/compile").send({ id: `${a}+${b}` }).expect(200);
    expect(charges).toEqual([2]);
  });

  it("a batch of ids sums its stages", async () => {
    const a = await taskStorer.create({ task: TASK_A });
    const b = await taskStorer.create({ task: TASK_B });
    const t = await taskStorer.create({ task: TASK1 });
    await request(appWith()).get("/data").query({ id: [a, b, t].join(",") }).expect(200);
    expect(charges).toEqual([2]);
  });

  it("a chain with two L0176 stages is two, and a repeated stage counts each time", async () => {
    const a = await taskStorer.create({ task: TASK_A });
    const b = await taskStorer.create({ task: TASK_B });
    await request(appWith()).get("/data").query({ id: `${a}+${b}` }).expect(200);
    await request(appWith()).get("/data").query({ id: `${a}+${a}` }).expect(200);
    expect(charges).toEqual([2, 2]);
  });

  it("a chain with no L0176 stage is not charged", async () => {
    const t = await taskStorer.create({ task: TASK1 });
    await request(appWith()).get("/data").query({ id: t }).expect(200);
    await request(appWith()).post("/compile").send({ item: TASK1 }).expect(200);
    expect(total()).toBe(0);
  });

  it("a request through a connection is not charged", async () => {
    const a = await taskStorer.create({ task: TASK_A, auth: { uid: "0xowner" } });
    await request(appWith()).post("/compile").set("Authorization", "user:0xowner").send({ id: a, connectionId: "conn-1" });
    await request(appWith()).get("/data").set("Authorization", "user:0xowner").query({ id: a, connection: "conn-1" });
    expect(charges).toEqual([]);
  });

  it("a request through a publication is not charged", async () => {
    const a = await taskStorer.create({ task: TASK_A });
    await request(appWith()).get("/data").query({ id: a, publication: "pub-1" });
    expect(charges).toEqual([]);
  });

  it("POST /preview/sign is one stage", async () => {
    await request(appWith()).post("/preview/sign").send({ activity: { type: "questions", data: { questions: [] } } }).expect(200);
    expect(charges).toEqual([1]);
  });

  it("charges before any task is written: a refused POST /compile stores nothing", async () => {
    const before = await snapshot();
    const refusing = { charge: async () => { throw new SigningRateLimited({ retryAfter: 5 }); } };
    await request(appWith({ signingLimiter: refusing })).post("/compile").send({ item: { ...TASK_A, data: { x: 1 } } }).expect(429);
    expect(await snapshot()).toEqual(before);
    expect(langApp.calls()).toBe(0);
  });
});

describe("the limit's refusal", () => {
  const limited = () => appWith({ signingLimiter: buildSigningLimiter({ ratePerMinute: 10, burst: 2, edgeSecret: SECRET, audit: createApiAudit({ sink: r => records.push(r) }) }) });
  const sign = (app, headers = {}) => {
    let req = request(app).post("/preview/sign");
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req.send({ activity: { type: "questions", data: { questions: [] } } });
  };

  it("is a 429 with Retry-After and no-store, audited without identifiers, and dispatches nothing", async () => {
    const app = limited();
    await sign(app).expect(200);
    await sign(app).expect(200);
    const res = await sign(app).expect(429);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body).toMatchObject({ status: "error", error: { code: 429, message: "Previews are busy right now; try again in a moment.", reason: "rate-limited", category: "unavailable" } });
    expect(langApp.calls()).toBe(2);
    const audited = records.filter(r => r.event === "system-signing-limit");
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ event: "system-signing-limit", outcome: "denied", category: "unavailable", lang: "0176" });
    expect(audited[0]).not.toHaveProperty("service");
    expect(JSON.stringify(audited[0])).not.toMatch(/127\.0\.0\.1|::1|::ffff/);
  });

  it("audits a verified user's refusal with no uid or address", async () => {
    const app = limited();
    const as = { Authorization: "user:0xalice", "X-Forwarded-For": "198.51.100.7" };
    await sign(app, as).expect(200);
    await sign(app, as).expect(200);
    await sign(app, as).expect(429);
    const audited = records.filter(r => r.event === "system-signing-limit");
    expect(audited).toHaveLength(1);
    expect(audited[0]).not.toHaveProperty("user");
    expect(JSON.stringify(audited[0])).not.toMatch(/0xalice|198\.51\.100\.7/);
  });

  it("gives two verified users behind one address separate buckets", async () => {
    const app = limited();
    const egress = { "X-Forwarded-For": "198.51.100.7" };
    await sign(app, { ...egress, Authorization: "user:0xalice" }).expect(200);
    await sign(app, { ...egress, Authorization: "user:0xalice" }).expect(200);
    await sign(app, { ...egress, Authorization: "user:0xalice" }).expect(429);
    await sign(app, { ...egress, Authorization: "user:0xbob" }).expect(200);
    await sign(app, { ...egress, Authorization: "user:0xbob" }).expect(200);
    // And anonymous callers from that address have their own.
    await sign(app, egress).expect(200);
  });

  it("gives one verified user one bucket from any address", async () => {
    const app = limited();
    await sign(app, { "X-Forwarded-For": "198.51.100.7", Authorization: "user:0xalice" }).expect(200);
    await sign(app, { "X-Forwarded-For": "198.51.100.8", Authorization: "user:0xalice" }).expect(200);
    await sign(app, { "X-Forwarded-For": "198.51.100.9", Authorization: "user:0xalice" }).expect(429);
  });

  it("keys an invalid token by address, as anonymous, never in a bucket of its own", async () => {
    const app = limited();
    const a = await taskStorer.create({ task: TASK_A });
    const egress = { "X-Forwarded-For": "198.51.100.7" };
    // GET /data treats an invalid token as anonymous; it shares the address's bucket.
    await request(app).get("/data").set(egress).query({ id: a }).expect(200);
    await request(app).get("/data").set({ ...egress, Authorization: "expired-token" }).query({ id: a }).expect(200);
    await request(app).get("/data").set(egress).query({ id: a }).expect(429);
    await request(app).get("/data").set({ ...egress, Authorization: "another-bad-token" }).query({ id: a }).expect(429);
    // Elsewhere an invalid token is still refused outright, uncharged.
    const res = await sign(app, { "X-Forwarded-For": "198.51.100.9", Authorization: "expired-token" });
    expect(res.status).not.toBe(200);
    expect(langApp.calls()).toBe(2);
  });

  it("no longer shares one bucket across a server-side caller's users (the console/MCP shape)", async () => {
    const app = limited();
    const egress = { "X-Forwarded-For": "34.1.2.3" };
    for (const uid of ["0xu1", "0xu2", "0xu3", "0xu4"]) {
      await request(app).post("/compile").set({ ...egress, Authorization: `user:${uid}` })
        .send([{ ...TASK_A }, { ...TASK_B }]).expect(200);
    }
    // Each user has spent its own burst.
    await request(app).post("/compile").set({ ...egress, Authorization: "user:0xu1" }).send({ item: TASK_A }).expect(429);
  });

  it("is no-store on GET /data too, over its immutable header", async () => {
    const app = limited();
    const a = await taskStorer.create({ task: TASK_A });
    await request(app).get("/data").query({ id: `${a}+${a}` }).expect(200);
    const res = await request(app).get("/data").query({ id: a }).expect(429);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("keys a forged CF-Connecting-IP on the front end's address, so it can't escape the limit", async () => {
    const app = limited();
    const xff = { "X-Forwarded-For": "198.51.100.7" };
    await sign(app, { ...xff, "CF-Connecting-IP": "203.0.113.1" }).expect(200);
    await sign(app, { ...xff, "CF-Connecting-IP": "203.0.113.2" }).expect(200);
    await sign(app, { ...xff, "CF-Connecting-IP": "203.0.113.3" }).expect(429);
    await sign(app, { ...xff, "CF-Connecting-IP": "203.0.113.4", "X-Graffiticode-Edge": "wrong" }).expect(429);
    // Another client is unaffected.
    await sign(app, { "X-Forwarded-For": "198.51.100.8" }).expect(200);
  });

  it("keys our edge's CF-Connecting-IP when the edge header carries the secret", async () => {
    const app = limited();
    const edge = { "X-Forwarded-For": "172.70.1.1", "X-Graffiticode-Edge": SECRET };
    await sign(app, { ...edge, "CF-Connecting-IP": "203.0.113.1" }).expect(200);
    await sign(app, { ...edge, "CF-Connecting-IP": "203.0.113.1" }).expect(200);
    await sign(app, { ...edge, "CF-Connecting-IP": "203.0.113.1" }).expect(429);
    // Another client behind the same Cloudflare egress is unaffected.
    await sign(app, { ...edge, "CF-Connecting-IP": "203.0.113.2" }).expect(200);
  });

  it("keys on the last X-Forwarded-For entry, so prepended entries don't escape it", async () => {
    const app = limited();
    await sign(app, { "X-Forwarded-For": "1.1.1.1, 198.51.100.7" }).expect(200);
    await sign(app, { "X-Forwarded-For": "2.2.2.2, 198.51.100.7" }).expect(200);
    await sign(app, { "X-Forwarded-For": "3.3.3.3, 198.51.100.7" }).expect(429);
  });
});

describe("POST /preview/sign", () => {
  const activity = { type: "questions", data: { questions: [{ type: "mcq", stimulus: "2+2?" }] } };

  it("answers the signed request, no-store, from one L0176 compile of init data {} with the activity, carrying the api's identity", async () => {
    const res = await request(appWith()).post("/preview/sign").send({ activity }).expect(200);
    expect(res.body).toEqual({ request: SIGNED });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    const received = langApp.received();
    expect(received).toHaveLength(1);
    expect(received[0].body).toEqual({ code: INIT_DATA_CODE, data: activity, auth: null, options: {} });
    expect(received[0].headers["x-caller-identity"]).toBe(MINTED);
  });

  it("answers why when L0176 returns the activity unsigned", async () => {
    langApp.setData(INIT_DATA_CODE, { data: { ...activity, signing: { unsigned: "gateway-only", message: "Signing goes through the gateway." } }, errors: [] });
    const res = await request(appWith()).post("/preview/sign").send({ activity }).expect(200);
    expect(res.body).toEqual({ signing: { unsigned: "gateway-only", message: "Signing goes through the gateway." } });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("relays L0176's compile errors as a 422", async () => {
    langApp.setData(INIT_DATA_CODE, { data: null, errors: [{ message: "bad question", from: -1, to: -1 }] });
    const res = await request(appWith()).post("/preview/sign").send({ activity }).expect(422);
    expect(res.body.errors).toEqual([{ message: "bad question", from: -1, to: -1 }]);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("is a 502 when L0176 doesn't answer", async () => {
    langApp.setData(INIT_DATA_CODE, undefined);
    const res = await request(appWith()).post("/preview/sign").send({ activity }).expect(502);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("checks the activity's shape only, and sends only type and data", async () => {
    const app = appWith();
    for (const body of [{}, { activity: null }, { activity: [] }, { activity: { type: "items" } }, { activity: { type: "other", data: {} } }, { activity: { type: "questions", data: [] } }]) {
      const res = await request(app).post("/preview/sign").send(body).expect(400);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect(charges).toEqual([]);
    await request(app).post("/preview/sign").send({ activity: { type: "items", data: { items: [] }, request: { stale: true }, signing: { unsigned: "x" } } }).expect(200);
    expect(langApp.received()[0].body.data).toEqual({ type: "items", data: { items: [] } });
  });

  it("refuses a body over its cap with a 413, before anything is charged or sent", async () => {
    const big = { activity: { type: "questions", data: { text: "x".repeat(PREVIEW_SIGN_LIMIT_BYTES + 1) } } };
    const res = await request(appWith()).post("/preview/sign").send(big).expect(413);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(charges).toEqual([]);
    expect(langApp.calls()).toBe(0);
  });

  it("REGRESSION, private dynamic preview: an activity from a private artifact is signed with nothing stored and nothing made public", async () => {
    // A private connection artifact's task, and the activity its Form resolved.
    const privateId = await taskStorer.create({ task: l0176("PRIVATE-MARKER source"), auth: { uid: "0xowner" } });
    await request(appWith()).get("/data").query({ id: privateId }).expect(404);
    const resolved = { type: "questions", data: { questions: [{ type: "mcq", stimulus: "PRIVATE-MARKER what is 2+2" }] } };
    const before = await snapshot();
    const res = await request(appWith())
      .post("/preview/sign")
      .set("Authorization", "user:0xowner")
      .send({ activity: resolved, connectionId: "conn-1" })
      .expect(200);
    expect(res.body).toEqual({ request: SIGNED });
    expect(res.headers["cache-control"]).toBe("no-store");
    // No task, no compile record, nothing else: the store is unchanged.
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toMatch(/PRIVATE-MARKER what is/);
    expect((after.tasks ?? []).filter(t => t.acls?.public)).toEqual((before.tasks ?? []).filter(t => t.acls?.public));
    // One system-path compile: no connection, no user token forwarded.
    const received = langApp.received();
    expect(received).toHaveLength(1);
    expect(received[0].body).toEqual({ code: INIT_DATA_CODE, data: resolved, auth: null, options: {} });
    expect(received[0].body).not.toHaveProperty("connectionId");
    expect(JSON.stringify(received[0])).not.toMatch(/user:0xowner/);
  });
});

describe("the api's identity on compiles", () => {
  it("compiles to L0176 carry X-Caller-Identity; other languages' don't", async () => {
    const a = await taskStorer.create({ task: TASK_A });
    const t = await taskStorer.create({ task: TASK1 });
    await request(appWith()).get("/data").query({ id: `${a}+${t}` }).expect(200);
    const received = langApp.received();
    expect(received).toHaveLength(2);
    const byLang = Object.fromEntries(received.map(r => [r.body.code.root === 2 ? "0176" : "0000", r.headers]));
    expect(byLang["0176"]["x-caller-identity"]).toBe(MINTED);
    expect(byLang["0000"]["x-caller-identity"]).toBeUndefined();
  });

  it("a failed mint sends the compile without it, and the compile still answers", async () => {
    const app = appWith({ callerIdToken: async () => { throw new Error("metadata down"); } });
    const a = await taskStorer.create({ task: TASK_A });
    const res = await request(app).get("/data").query({ id: a }).expect(200);
    expect(res.body.data).toEqual({ data: PREVIEW.data, errors: [] });
    expect(langApp.received()[0].headers["x-caller-identity"]).toBeUndefined();
  });
});
