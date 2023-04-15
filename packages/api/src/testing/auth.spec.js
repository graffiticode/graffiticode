import { buildFakeAuthProvider, buildArtCompilerAuthApplication } from "./auth.js";
import request from "supertest";

describe("testing/auth", () => {
  describe("provider", () => {
    let authProvider;
    beforeEach(() => {
      authProvider = buildFakeAuthProvider();
    });

    it("should throw error if token is not present", async () => {
      const token = "abc123";

      await expect(authProvider.validate(token)).rejects.toThrow("no context for");
    });

    it("should throw provided error", async () => {
      const token = "abc123";
      const err = new Error("custom error");
      authProvider.addContextForToken(token, err);

      await expect(authProvider.validate(token)).rejects.toThrow(err);
    });

    it("should return context", async () => {
      const token = "abc123";
      const context = { id: 1 };
      authProvider.addContextForToken(token, context);

      await expect(authProvider.validate(token)).resolves.toBe(context);
    });
  });

  describe("app", () => {
    let authApp;
    beforeEach(() => {
      authApp = buildArtCompilerAuthApplication();
    });

    it("/validateSignIn should return 400 if missing jwt", async () => {
      const res = await request(authApp.app)
        .post("/validateSignIn")
        .send({})
        .expect(400);

      expect(res.body).toHaveProperty("error.message", "must provide a token");
    });

    it("/validateSignIn should return 400 if jwt is empty", async () => {
      const res = await request(authApp.app)
        .post("/validateSignIn")
        .send({ jwt: "" })
        .expect(400);

      expect(res.body).toHaveProperty("error.message", "must provide a token");
    });

    it("/validateSignIn should return 401 if jwt is missing", async () => {
      const token = "abc123";

      await request(authApp.app)
        .post("/validateSignIn")
        .send({ jwt: token })
        .expect(401);
    });

    it("/validateSignIn should return 500 if providing error", async () => {
      const token = "abc123";
      authApp.addIdForToken(token, new Error("auth provider failure"));

      await request(authApp.app)
        .post("/validateSignIn")
        .send({ jwt: token })
        .expect(500);
    });

    it("/validateSignIn should return 500 if providing error", async () => {
      const token = "abc123";
      authApp.addIdForToken(token, 1);

      const res = await request(authApp.app)
        .post("/validateSignIn")
        .send({ jwt: token })
        .expect(200);

      expect(res.body).toHaveProperty("id", 1);
    });
  });
});
