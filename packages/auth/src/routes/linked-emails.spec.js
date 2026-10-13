import request from "supertest";
import { createHttpApp } from "@graffiticode/common/http";
import { buildLinkedEmailsRouter } from "./linked-emails.js";

const KEY = "test-internal-key";

describe("routes/linked-emails internal lookup", () => {
  let app;
  let prevKey;
  beforeEach(() => {
    prevKey = process.env.INTERNAL_API_KEY;
    process.env.INTERNAL_API_KEY = KEY;
    const linkedEmailsService = {
      lookup: async ({ email }) => (email === "a@b.c" ? { uid: "u1", id: "e1" } : null),
    };
    app = createHttpApp(a => a.use("/linked-emails", buildLinkedEmailsRouter({ linkedEmailsService })));
  });
  afterEach(() => {
    process.env.INTERNAL_API_KEY = prevKey;
  });

  it("looks up an email sent in the body", async () => {
    const hit = await request(app).post("/linked-emails/internal/lookup").set("X-Internal-API-Key", KEY).send({ email: "a@b.c" }).expect(200);
    expect(hit.body.data).toEqual({ matched: true, uid: "u1", id: "e1" });
    const miss = await request(app).post("/linked-emails/internal/lookup").set("X-Internal-API-Key", KEY).send({ email: "x@y.z" }).expect(200);
    expect(miss.body.data).toEqual({ matched: false });
    await request(app).post("/linked-emails/internal/lookup").set("X-Internal-API-Key", KEY).send({}).expect(400);
  });

  it("refuses the lookup without the internal API key", async () => {
    await request(app).post("/linked-emails/internal/lookup").send({ email: "a@b.c" }).expect(403);
  });

  it("still answers the deprecated query form", async () => {
    const res = await request(app).get("/linked-emails/internal/lookup?email=a%40b.c").set("X-Internal-API-Key", KEY).expect(200);
    expect(res.body.data).toMatchObject({ matched: true, uid: "u1" });
  });
});

describe("routes/linked-emails internal search", () => {
  let app;
  let prevKey;
  let calls;
  const emails = [
    { uid: "u1", email: "alice@example.com" },
    { uid: "u1", email: "alice@work.org" },
    { uid: "u2", email: "bob@example.com" },
  ];
  beforeEach(() => {
    prevKey = process.env.INTERNAL_API_KEY;
    process.env.INTERNAL_API_KEY = KEY;
    calls = [];
    const linkedEmailsService = {
      search: async ({ fragment }) => {
        calls.push(fragment);
        return emails.filter(e => e.email.includes(fragment)).map(e => e.uid);
      },
    };
    app = createHttpApp(a => a.use("/linked-emails", buildLinkedEmailsRouter({ linkedEmailsService })));
  });
  afterEach(() => {
    process.env.INTERNAL_API_KEY = prevKey;
  });

  const search = (body) =>
    request(app).post("/linked-emails/internal/search").set("X-Internal-API-Key", KEY).send(body);

  it("returns deduplicated uids whose email contains the fragment", async () => {
    const res = await search({ fragment: "  ALICE " }).expect(200);
    expect(res.body.data).toEqual({ uids: ["u1"] });
    expect(calls).toEqual(["alice"]);
    const both = await search({ fragment: "example" }).expect(200);
    expect(both.body.data.uids.sort()).toEqual(["u1", "u2"]);
  });

  it("returns an empty list when nothing matches", async () => {
    const res = await search({ fragment: "zzz" }).expect(200);
    expect(res.body.data).toEqual({ uids: [] });
  });

  it("rejects a fragment shorter than two characters", async () => {
    await search({ fragment: " a " }).expect(400);
    await search({}).expect(400);
    expect(calls).toEqual([]);
  });

  it("refuses the search without the internal API key", async () => {
    await request(app).post("/linked-emails/internal/search").send({ fragment: "alice" }).expect(403);
  });

  it("never returns an email address", async () => {
    const res = await search({ fragment: "example.com" }).expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/@/);
  });
});
