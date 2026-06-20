import express from "express";
import request from "supertest";
import { jest } from "@jest/globals";
import { UnauthenticatedError } from "../errors/http.js";
import buildAuthHandler from "./auth.js";

describe("routes/auth", () => {
  let validateToken;
  let app;
  beforeEach(() => {
    validateToken = jest.fn();

    app = express();
    app.use(buildAuthHandler({ validateToken }));
    const echoAuth = (req, res) => {
      res.status(200).json({ auth: req.auth });
    };
    app.get("/", echoAuth);
    // A public read path: invalid tokens degrade to anonymous here.
    app.get("/data", echoAuth);
    app.use((err, req, res, next) => {
      console.log(err);
      res.sendStatus(500);
    });
  });

  it("should have null authContext if no auth token", async () => {
    validateToken.mockResolvedValue({ uid: "1" });

    const res = await request(app)
      .get("/")
      .expect(200);

    expect(res.body).toHaveProperty("auth.token", null);
    expect(res.body).toHaveProperty("auth.context", null);
    expect(validateToken).toHaveBeenCalledTimes(0);
  });

  it("should have authContext if auth token", async () => {
    const token = "abc123";
    validateToken.mockResolvedValue({ uid: "1" });

    const res = await request(app)
      .get("/")
      .set("Authorization", token)
      .expect(200);

    expect(res.body).toHaveProperty("auth.token", token);
    expect(res.body).toHaveProperty("auth.context", { uid: "1" });
    expect(validateToken).toHaveBeenCalledWith(token);
  });

  it("should have authContext if auth token with Bearer prefix", async () => {
    const token = "abc123";
    validateToken.mockResolvedValue({ uid: "1" });

    const res = await request(app)
      .get("/")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveProperty("auth.token", token);
    expect(res.body).toHaveProperty("auth.context", { uid: "1" });
    expect(validateToken).toHaveBeenCalledWith(token);
  });

  it("should have authContext if token in query", async () => {
    const token = "abc123";
    validateToken.mockResolvedValue({ uid: "1" });

    const res = await request(app)
      .get("/")
      .query({ access_token: token })
      .expect(200);

    expect(res.body).toHaveProperty("auth.token", token);
    expect(res.body).toHaveProperty("auth.context", { uid: "1" });
    expect(validateToken).toHaveBeenCalledWith(token);
  });

  it("should use token from query before headers", async () => {
    const token1 = "abc123";
    const token2 = "def456";
    validateToken.mockResolvedValue({ uid: "1" });

    const res = await request(app)
      .get("/")
      .query({ access_token: token1 })
      .set("Authorization", token2)
      .expect(200);

    expect(res.body).toHaveProperty("auth.token", token1);
    expect(res.body).toHaveProperty("auth.context", { uid: "1" });
    expect(validateToken).toHaveBeenCalledWith(token1);
  });

  it("should return 401 if invalid token", async () => {
    const token = "abc123";
    validateToken.mockRejectedValue(new UnauthenticatedError("no context for abc123"));

    const res = await request(app)
      .get("/")
      .set("Authorization", token)
      .expect(401);

    expect(res.body).toHaveProperty("error.message", "no context for abc123");
    expect(validateToken).toHaveBeenCalledWith(token);
  });

  it("should degrade to anonymous on invalid token for a public read path", async () => {
    const token = "abc123";
    validateToken.mockRejectedValue(new UnauthenticatedError("no context for abc123"));

    const res = await request(app)
      .get("/data")
      .set("Authorization", token)
      .expect(200);

    // Degraded request is equivalent to anonymous: no context AND no raw token.
    expect(res.body).toHaveProperty("auth.token", null);
    expect(res.body).toHaveProperty("auth.context", null);
    expect(validateToken).toHaveBeenCalledWith(token);
  });

  it("should return 401 if auth provider fails", async () => {
    const token = "abc123";
    validateToken.mockRejectedValue(new Error("unknown failure"));

    await request(app)
      .get("/")
      .set("Authorization", token)
      .expect(500, "Internal Server Error");

    expect(validateToken).toHaveBeenCalledWith(token);
  });
});
