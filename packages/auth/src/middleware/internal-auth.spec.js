// Characterization tests: these pin the CURRENT behavior of
// middleware/internal-auth.js (written before the TypeScript migration), not a
// judgment of it.
import { jest } from "@jest/globals";
import { createHttpApp } from "@graffiticode/common/http";
import request from "supertest";
import { requireCleanupAuth, requireInternalAuth } from "./internal-auth.js";

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
    // `category` (spec FAIL-01, W3) is the one reviewed addition to this body.
    expect(res.body).toEqual({ status: "error", error: { code: 403, message: "Invalid internal API key", category: "permission" }, data: null });
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

describe("middleware/internal-auth requireCleanupAuth (2026-10-21)", () => {
  const saved = { internal: process.env.INTERNAL_API_KEY, cleanup: process.env.CLEANUP_API_KEY };
  let app;
  let errorSpy;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    process.env.INTERNAL_API_KEY = "internal-key";
    process.env.CLEANUP_API_KEY = "cleanup-key";
    app = createHttpApp(app => {
      app.post("/clean", requireCleanupAuth, (req, res) => res.json({ reached: true }));
      app.post("/internal", requireInternalAuth, (req, res) => res.json({ reached: true }));
    });
  });
  afterEach(() => {
    for (const [k, v] of [["INTERNAL_API_KEY", saved.internal], ["CLEANUP_API_KEY", saved.cleanup]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    errorSpy.mockRestore();
  });

  it("accepts the cleanup key on the cleanup route", async () => {
    const res = await request(app).post("/clean").set("X-Cleanup-API-Key", "cleanup-key");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });

  it("refuses a wrong cleanup key, including one of another length", async () => {
    for (const key of ["cleanup-kez", "x", "cleanup-key-and-more"]) {
      expect((await request(app).post("/clean").set("X-Cleanup-API-Key", key)).status).toBe(403);
    }
  });

  it("refuses the internal key sent as the cleanup key", async () => {
    expect((await request(app).post("/clean").set("X-Cleanup-API-Key", "internal-key")).status).toBe(403);
  });

  it("answers 500 when a cleanup key is sent but CLEANUP_API_KEY isn't configured", async () => {
    delete process.env.CLEANUP_API_KEY;
    const res = await request(app).post("/clean").set("X-Cleanup-API-Key", "cleanup-key");
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith("CLEANUP_API_KEY not configured");
  });

  it("falls back to the internal key when no cleanup key is sent", async () => {
    expect((await request(app).post("/clean").set("X-Internal-API-Key", "internal-key")).status).toBe(200);
    expect((await request(app).post("/clean").set("X-Internal-API-Key", "wrong")).status).toBe(403);
    expect((await request(app).post("/clean")).status).toBe(403);
  });

  it("doesn't open any other internal route: the cleanup key isn't the internal key", async () => {
    expect((await request(app).post("/internal").set("X-Cleanup-API-Key", "cleanup-key")).status).toBe(403);
    expect((await request(app).post("/internal").set("X-Internal-API-Key", "cleanup-key")).status).toBe(403);
  });
});
