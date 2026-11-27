import { jest } from "@jest/globals";
import http from "node:http";
import { buildCompile } from "./compile.js";
import { REFUSAL_BODY_LIMIT } from "./bounded-body.js";

// A real language service on a local port, so the client's fetch, its
// deadline and its bounded body read run exactly as in production.
const startServer = async handler => {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      handler(req, res, requests.length);
    });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve(undefined));
    }),
  };
};

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("compile", () => {
  let server;
  let lines;
  const log = line => lines.push(String(line));
  /** @type {(options?: object) => (lang: string, req: object, opts?: object) => Promise<any>} */
  const client = (options = {}) => buildCompile(/** @type {any} */ ({
    getBaseUrlForLanguage: async () => server.url,
    delays: [0, 0],
    deadlines: { read: 200, other: 300 },
    log,
    ...options,
  }));

  beforeEach(() => {
    lines = [];
  });
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("posts the request to the language and returns its answer", async () => {
    server = await startServer((_req, res) => json(res, 200, { data: { ok: 1 }, errors: [] }));
    const getBaseUrlForLanguage = /** @type {any} */ (jest.fn()).mockResolvedValue(server.url);
    const compile = client({ getBaseUrlForLanguage });

    await expect(compile("LTest", { code: 1 }, { headers: { "X-Caller-Identity": "id-token" } })).resolves.toEqual({ data: { ok: 1 }, errors: [] });

    expect(getBaseUrlForLanguage).toHaveBeenCalledWith("LTest", { uid: undefined });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toEqual(expect.objectContaining({ method: "POST", url: "/compile", body: { code: 1 } }));
    expect(server.requests[0].headers["x-caller-identity"]).toBe("id-token");
  });

  it("accepts a 202, and posts to the path it is given", async () => {
    server = await startServer((_req, res) => json(res, 202, { data: 2, errors: [] }));
    await expect(client()("L0184", { model: {} }, { path: "/interpret" })).resolves.toEqual({ data: 2, errors: [] });
    expect(server.requests[0].url).toBe("/interpret");
  });

  describe("a refusal (4xx) is answered, not lost", () => {
    it("keeps the language's reason and its category", async () => {
      server = await startServer((_req, res) => json(res, 403, { status: "error", error: { code: 403, message: "not permitted", reason: "not-granted" } }));
      const out = await client()("L0176", { code: {} });
      expect(out.responseLost).toBeUndefined();
      expect(out.refused).toBe(true);
      expect(out.errors).toEqual([expect.objectContaining({ code: "not-granted", category: "permission", status: 403, from: -1, to: -1 })]);
      expect(out.errors[0].message).toContain("not permitted");
    });

    it("takes a string error code as the reason", async () => {
      server = await startServer((_req, res) => json(res, 409, { error: { code: "plan-mismatch", message: "m" } }));
      const out = await client()("L0176", { code: {} });
      expect(out.errors[0]).toEqual(expect.objectContaining({ code: "plan-mismatch", category: "conflict" }));
    });

    it("reads the Rust server's string error as the message, with the status's category", async () => {
      server = await startServer((_req, res) => json(res, 400, { error: "Missing required parameters: code and data" }));
      const out = await client()("L0184", { code: {} });
      expect(out.refused).toBe(true);
      expect(out.errors[0].code).toBeUndefined();
      expect(out.errors[0]).toEqual(expect.objectContaining({ category: "malformed", status: 400 }));
      expect(out.errors[0].message).toContain("Missing required parameters");
    });

    it.each([
      [400, "malformed"],
      [401, "authentication"],
      [403, "permission"],
      [429, "unavailable"],
    ])("gives a body-less %i the status's category", async (status, category) => {
      server = await startServer((_req, res) => { res.writeHead(status); res.end(); });
      const out = await client()("L0184", { code: {} });
      expect(out.refused).toBe(true);
      expect(out.errors[0]).toEqual(expect.objectContaining({ category, status }));
      expect(out.errors[0].code).toBeUndefined();
    });

    it("treats a malformed body as none", async () => {
      server = await startServer((_req, res) => { res.writeHead(403, { "Content-Type": "application/json" }); res.end("{not json"); });
      const out = await client()("L0176", { code: {} });
      expect(out.errors[0]).toEqual(expect.objectContaining({ category: "permission", status: 403 }));
      expect(out.errors[0].code).toBeUndefined();
    });

    it("gives an unknown reason the unknown category", async () => {
      server = await startServer((_req, res) => json(res, 403, { error: { reason: "some-unknown-reason" } }));
      const out = await client()("L0176", { code: {} });
      expect(out.errors[0]).toEqual(expect.objectContaining({ code: "some-unknown-reason", category: "unavailable" }));
    });

    it("is never sent again, even on the read path", async () => {
      server = await startServer((_req, res) => json(res, 401, { error: { reason: "no-user" } }));
      const out = await client()("L0184", { model: {} }, { path: "/interpret", retryReset: true });
      expect(out.refused).toBe(true);
      expect(server.requests).toHaveLength(1);
    });

    it("stops reading an oversized body at the limit", async () => {
      let written = 0;
      let closed = false;
      server = await startServer((_req, res) => {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.on("close", () => { closed = true; });
        const chunk = Buffer.alloc(64 * 1024, "x");
        // One chunk per turn, until the client hangs up or 10 MB is out.
        const pump = () => {
          if (closed) return;
          if (written >= 10 * 1024 * 1024) {
            res.end();
            return;
          }
          written += chunk.length;
          if (res.write(chunk)) setImmediate(pump);
          else res.once("drain", pump);
        };
        pump();
      });
      const out = await client()("L0176", { code: {} });
      expect(out.refused).toBe(true);
      expect(out.errors[0]).toEqual(expect.objectContaining({ category: "permission", status: 403 }));
      // The client hung up long before the server had written 10 MB.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(closed).toBe(true);
      expect(written).toBeLessThan(10 * 1024 * 1024);
      const logged = lines.find(line => line.startsWith("ERROR language call"));
      expect(logged).toContain(`"bytesRead":${REFUSAL_BODY_LIMIT}`);
      expect(logged).toContain("\"truncated\":true");
    });

    it("logs a registered reason as itself, and any other as a fixed marker", async () => {
      const MARKER = "SENTINEL-reason-8d2e";
      server = await startServer((_req, res, n) => json(res, 403, { error: { reason: n === 1 ? "not-granted" : `leak-${MARKER}` } }));
      await client()("L0176", { code: {} });
      const out = await client()("L0176", { code: {} });
      // The caller still gets the reason the language sent; only logs drop it.
      expect(out.errors[0].code).toBe(`leak-${MARKER}`);
      const logged = lines.filter(line => line.startsWith("ERROR language call")).map(line => JSON.parse(line.replace("ERROR language call ", "")));
      expect(logged.map(l => l.reason)).toEqual(["not-granted", "unregistered-reason"]);
      for (const line of lines) expect(line).not.toContain(MARKER);
    });

    it("logs only allowlisted fields, never the body", async () => {
      const SENTINEL = "SENTINEL-6f1c-secret";
      server = await startServer((_req, res) => json(res, 403, { error: { reason: "not-granted", message: `token ${SENTINEL}`, detail: { secret: SENTINEL } } }));
      await client()("L0176", { code: { secret: SENTINEL } });
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).not.toContain(SENTINEL);
      const logged = JSON.parse(lines.find(line => line.startsWith("ERROR language call")).replace("ERROR language call ", ""));
      expect(Object.keys(logged).sort()).toEqual(["attempt", "bytesRead", "category", "code", "lang", "path", "reason", "status", "truncated"]);
    });
  });

  describe("a lost answer", () => {
    it("is a body that stalls past the deadline, and the socket is closed", async () => {
      let closed = false;
      server = await startServer((_req, res) => {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.write("{\"error\":");
        res.on("close", () => { closed = true; });
      });
      const out = await client()("L0176", { code: {} });
      expect(out.responseLost).toBe(true);
      expect(out.refused).toBeUndefined();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(closed).toBe(true);
    });

    it("is a 5xx, which a call that may act never sends again", async () => {
      server = await startServer((_req, res) => json(res, 500, { error: { reason: "boom" } }));
      const out = await client()("L0176", { code: {} });
      expect(out.responseLost).toBe(true);
      expect(out.refused).toBeUndefined();
      expect(server.requests).toHaveLength(1);
    });

    it("is a reset on a call that may act, never sent again", async () => {
      server = await startServer(req => req.socket.destroy());
      const out = await client()("L0176", { code: {} });
      expect(out.responseLost).toBe(true);
      expect(server.requests).toHaveLength(1);
    });

    it("is a call that never answers, which a call that may act never sends again", async () => {
      server = await startServer(() => {});
      const out = await client()("L0000", { code: {} });
      expect(out.responseLost).toBe(true);
      expect(server.requests).toHaveLength(1);
      expect(lines.some(line => line.includes("gave no answer in 300 ms"))).toBe(true);
    });
  });

  describe("a call with no effects (retryReset)", () => {
    it("is sent again after a reset", async () => {
      server = await startServer((req, res, n) => (n === 1 ? req.socket.destroy() : json(res, 200, { data: 1, errors: [] })));
      await expect(client()("L0184", { model: {} }, { path: "/interpret", retryReset: true })).resolves.toEqual({ data: 1, errors: [] });
      expect(server.requests).toHaveLength(2);
    });

    it("is sent at most twice more, and then its answer is lost", async () => {
      server = await startServer(req => req.socket.destroy());
      const out = await client()("L0184", { model: {} }, { path: "/interpret", retryReset: true });
      expect(out.responseLost).toBe(true);
      expect(server.requests).toHaveLength(3);
    });

    it("is sent again after a 503 (the auth service couldn't judge the token)", async () => {
      server = await startServer((_req, res, n) => (n === 1 ? json(res, 503, {}) : json(res, 200, { data: 3, errors: [] })));
      await expect(client()("L0184", { model: {} }, { path: "/interpret", retryReset: true })).resolves.toEqual({ data: 3, errors: [] });
      expect(server.requests).toHaveLength(2);
    });

    it("is sent again when it doesn't answer by its deadline", async () => {
      server = await startServer((_req, res, n) => (n === 1 ? undefined : json(res, 200, { data: 4, errors: [] })));
      await expect(client()("L0184", { model: {} }, { path: "/interpret", retryReset: true })).resolves.toEqual({ data: 4, errors: [] });
      expect(server.requests).toHaveLength(2);
    });

    it("is not sent again after any other 5xx", async () => {
      server = await startServer((_req, res) => json(res, 500, {}));
      const out = await client()("L0184", { model: {} }, { path: "/interpret", retryReset: true });
      expect(out.responseLost).toBe(true);
      expect(server.requests).toHaveLength(1);
    });
  });
});
