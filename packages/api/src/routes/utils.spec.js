// Characterization tests: these pin the CURRENT behavior of routes/utils.js
// (written before the TypeScript migration), not a judgment of it. A change to
// one of these expectations is a behavior change and needs its own review.
import express from "express";
import request from "supertest";
import { InvalidArgumentError, NotFoundError } from "../errors/http.js";
import {
  buildHttpHandler,
  createCompileSuccessResponse,
  createError,
  createErrorResponse,
  createSuccessResponse,
  getStorageTypeForRequest,
  parseAuthTokenFromRequest,
  parseIdempotencyKey,
  parseIdsFromRequest,
  parseOriginFromRequest,
  setImmutableCacheHeaders,
  setNoStoreCacheHeaders,
} from "./utils.js";

const fakeReq = ({ query = {}, body = {}, headers = {} } = {}) => ({
  query,
  body,
  get: name => headers[name.toLowerCase()],
});

const fakeRes = () => {
  const headers = {};
  return { headers, set: (name, value) => { headers[name] = value; } };
};

describe("routes/utils", () => {
  describe("parseIdsFromRequest", () => {
    it("returns [] when id is missing, empty or not a string", () => {
      expect(parseIdsFromRequest(fakeReq())).toEqual([]);
      expect(parseIdsFromRequest(fakeReq({ query: { id: "" } }))).toEqual([]);
      expect(parseIdsFromRequest(fakeReq({ query: { id: ["a", "b"] } }))).toEqual([]);
    });

    it("splits on commas and turns spaces (decoded '+') back into '+'", () => {
      expect(parseIdsFromRequest(fakeReq({ query: { id: "a" } }))).toEqual(["a"]);
      expect(parseIdsFromRequest(fakeReq({ query: { id: "a b c,d" } }))).toEqual(["a+b+c", "d"]);
      expect(parseIdsFromRequest(fakeReq({ query: { id: "a,,b" } }))).toEqual(["a", "", "b"]);
    });
  });

  it("parseOriginFromRequest returns query.origin as is", () => {
    expect(parseOriginFromRequest(fakeReq({ query: { origin: "x" } }))).toBe("x");
    expect(parseOriginFromRequest(fakeReq())).toBeUndefined();
  });

  describe("parseAuthTokenFromRequest", () => {
    it("prefers query.access_token over the Authorization header", () => {
      const req = fakeReq({ query: { access_token: "q" }, headers: { authorization: "Bearer h" } });
      expect(parseAuthTokenFromRequest(req)).toBe("q");
    });

    it("strips a 'Bearer ' prefix, and passes any other header value through", () => {
      expect(parseAuthTokenFromRequest(fakeReq({ headers: { authorization: "Bearer h" } }))).toBe("h");
      expect(parseAuthTokenFromRequest(fakeReq({ headers: { authorization: "h" } }))).toBe("h");
      expect(parseAuthTokenFromRequest(fakeReq({ headers: { authorization: "bearer h" } }))).toBe("bearer h");
      expect(parseAuthTokenFromRequest(fakeReq({ headers: { authorization: "Bearer " } }))).toBe("");
    });

    it("returns null with no token", () => {
      expect(parseAuthTokenFromRequest(fakeReq())).toBeNull();
    });
  });

  describe("buildHttpHandler", () => {
    const appWith = handler => {
      const app = express();
      app.get("/", buildHttpHandler(handler));
      // eslint-disable-next-line n/handle-callback-err
      app.use((err, req, res, next) => res.status(599).json({ passedOn: err.message }));
      return app;
    };

    it("sends an HttpError as an error response with no-store", async () => {
      const app = appWith(async (req, res) => {
        res.set("Cache-Control", "public, max-age=31536000, immutable");
        throw new NotFoundError("nope");
      });
      const res = await request(app).get("/");
      expect(res.status).toBe(404);
      expect(res.headers["cache-control"]).toBe("no-store");
      // `category` (spec FAIL-01, W3) is the one reviewed addition to this body.
      expect(res.body).toEqual({ status: "error", error: { code: 404, message: "nope", category: "malformed" } });
    });

    it("keeps the error code separate from the HTTP status", async () => {
      const app = appWith(async () => {
        const err = new InvalidArgumentError("bad");
        err.code = 4001;
        throw err;
      });
      const res = await request(app).get("/");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ status: "error", error: { code: 4001, message: "bad", category: "malformed" } });
    });

    it("passes any other error to next()", async () => {
      const app = appWith(async () => { throw new Error("boom"); });
      const res = await request(app).get("/");
      expect(res.status).toBe(599);
      expect(res.body).toEqual({ passedOn: "boom" });
    });

    it("lets a handler respond normally", async () => {
      const app = appWith(async (req, res) => res.json({ ok: true }));
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  it("builds response envelopes", () => {
    expect(createError(1, "m")).toEqual({ code: 1, message: "m" });
    expect(createErrorResponse({ code: 1 })).toEqual({ status: "error", error: { code: 1 } });
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    expect(createCompileSuccessResponse({ id: "i", data: 2, extra: 3 })).toEqual({ status: "success", id: "i", data: 2 });
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    expect(createSuccessResponse({ data: 2, extra: 3 })).toEqual({ status: "success", data: 2 });
  });

  it("sets cache headers", () => {
    const pub = fakeRes();
    setImmutableCacheHeaders(pub, { isPublic: true });
    expect(pub.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    const priv = fakeRes();
    setImmutableCacheHeaders(priv, { isPublic: false });
    expect(priv.headers["Cache-Control"]).toBe("private, max-age=31536000, immutable");
    const none = fakeRes();
    setNoStoreCacheHeaders(none);
    expect(none.headers["Cache-Control"]).toBe("no-store");
  });

  it("getStorageTypeForRequest reads x-graffiticode-storage-type, defaulting to ephemeral", () => {
    expect(getStorageTypeForRequest(fakeReq({ headers: { "x-graffiticode-storage-type": "persistent" } }))).toBe("persistent");
    expect(getStorageTypeForRequest(fakeReq())).toBe("ephemeral");
  });

  describe("parseIdempotencyKey", () => {
    it("returns null when absent", () => {
      expect(parseIdempotencyKey(undefined)).toBeNull();
      expect(parseIdempotencyKey(null)).toBeNull();
      expect(parseIdempotencyKey("")).toBeNull();
    });

    it("accepts a well-formed key only with a connection", () => {
      expect(parseIdempotencyKey("a:b.c-d_1", { connectionId: "c" })).toBe("a:b.c-d_1");
      expect(() => parseIdempotencyKey("k")).toThrow("an idempotency key requires a connectionId");
    });

    it("rejects a malformed key before checking the connection", () => {
      expect(() => parseIdempotencyKey("a b")).toThrow("idempotency key must be 1-190 characters of [A-Za-z0-9_:.-]");
      expect(() => parseIdempotencyKey("x".repeat(191), { connectionId: "c" })).toThrow(InvalidArgumentError);
      expect(() => parseIdempotencyKey(5, { connectionId: "c" })).toThrow(InvalidArgumentError);
    });
  });
});
