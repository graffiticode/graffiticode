// Characterization tests: these pin the CURRENT behavior of
// middleware/internal-auth.js (written before the TypeScript migration), not a
// judgment of it.
import { jest } from "@jest/globals";
import { createHttpApp } from "@graffiticode/common/http";
import request from "supertest";
import { requireInternalAuth } from "./internal-auth.js";

describe("middleware/internal-auth", () => {
  const saved = process.env.INTERNAL_API_KEY;
  let app;
  let errorSpy;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    app = createHttpApp(app => {
      app.get("/internal", requireInternalAuth, (req, res) => res.json({ reached: true }));
    });
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = saved;
    errorSpy.mockRestore();
  });

  it("answers 500 with its own body when INTERNAL_API_KEY is not configured", async () => {
    delete process.env.INTERNAL_API_KEY;
    const res = await request(app).get("/internal").set("X-Internal-API-Key", "anything");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ status: "error", error: { message: "Internal API key not configured" } });
    expect(errorSpy).toHaveBeenCalledWith("INTERNAL_API_KEY not configured");
  });

  it("treats an empty INTERNAL_API_KEY as not configured", async () => {
    process.env.INTERNAL_API_KEY = "";
    const res = await request(app).get("/internal").set("X-Internal-API-Key", "");
    expect(res.status).toBe(500);
  });

  it("rejects a missing key with 403 through the app error handler", async () => {
    process.env.INTERNAL_API_KEY = "secret";
    const res = await request(app).get("/internal");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ status: "error", error: { code: 403, message: "Invalid internal API key" }, data: null });
  });

  it("rejects a wrong key, compared exactly", async () => {
    process.env.INTERNAL_API_KEY = "secret";
    for (const key of ["wrong", "SECRET", "secretx", "Bearer secret"]) {
      const res = await request(app).get("/internal").set("X-Internal-API-Key", key);
      expect(res.status).toBe(403);
    }
  });

  it("sees header values with surrounding whitespace already trimmed by HTTP parsing", async () => {
    process.env.INTERNAL_API_KEY = "secret";
    for (const key of ["secret ", " secret"]) {
      const res = await request(app).get("/internal").set("X-Internal-API-Key", key);
      expect(res.status).toBe(200);
    }
  });

  it("passes the matching key through", async () => {
    process.env.INTERNAL_API_KEY = "secret";
    const res = await request(app).get("/internal").set("X-Internal-API-Key", "secret");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });
});
