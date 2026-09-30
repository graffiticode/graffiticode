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
