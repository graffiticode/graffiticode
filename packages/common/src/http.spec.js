import express from "express";
import request from "supertest";

import { buildHttpHandler, createError, createErrorResponse, createSuccessResponse, errorHandler, translateError } from "./http.js";
import { InvalidArgumentError, NotFoundError, UnauthenticatedError, UnauthorizedError, NotImplementedError } from "./errors.js";

describe("http", () => {
  describe("translateError", () => {
    it("should translate unknown error to server error with code 500", async () => {
      expect(translateError(new Error("must provide have foo"))).toEqual({
        code: 500,
        message: "must provide have foo",
      });
    });
    it("should translate InvalidArgumentError", async () => {
      expect(translateError(new InvalidArgumentError("must provide have foo"))).toEqual({
        code: 400,
        message: "must provide have foo",
      });
    });
    it("should translate NotFoundError", async () => {
      expect(translateError(new NotFoundError("must provide have foo"))).toEqual({
        code: 404,
        message: "must provide have foo",
      });
    });
    it("should translate UnauthenticatedError", async () => {
      expect(translateError(new UnauthenticatedError("must provide have foo"))).toEqual({
        code: 401,
        message: "must provide have foo",
      });
    });
    it("should translate UnauthorizedError", async () => {
      expect(translateError(new UnauthorizedError("must provide have foo"))).toEqual({
        code: 403,
        message: "must provide have foo",
      });
    });
    it("should translate NotImplementedError", async () => {
      expect(translateError(new NotImplementedError("must provide have foo"))).toEqual({
        code: 501,
        message: "must provide have foo",
      });
    });
  });

  describe("buildHttpHandler", () => {
    it("should send data returned from handler", async () => {
      const handler = async () => 42;
      const app = express();
      app.use(buildHttpHandler(handler));
      app.use(errorHandler);

      await request(app)
        .get("/")
        .expect(200, createSuccessResponse(42));
    });

    it("should send error returned from handler", async () => {
      const err = new InvalidArgumentError();
      const handler = async () => {
        throw err;
      };
      const app = express();
      app.use(buildHttpHandler(handler));
      app.use(errorHandler);

      await request(app)
        .get("/")
        .expect(400, createErrorResponse(createError(400, "")));
    });
  });
});
