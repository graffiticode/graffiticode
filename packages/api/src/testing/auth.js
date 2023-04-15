import express from "express";
import morgan from "morgan";
import { UnauthenticatedError, InvalidArgumentError } from "../errors/http.js";
import { buildHttpHandler } from "../routes/utils.js";
import { isNonNullObject, isNonEmptyString } from "../util.js";

export const buildFakeAuthProvider = () => {
  const contextsByToken = new Map();
  return {
    addContextForToken: (token, context) => contextsByToken.set(token, context),
    validate: async token => {
      if (!contextsByToken.has(token)) {
        throw new UnauthenticatedError(`no context for ${token}`);
      }
      const context = contextsByToken.get(token);
      if (context instanceof Error) {
        throw context;
      }
      return context;
    }
  };
};

export const buildArtCompilerAuthApplication = () => {
  const idsByToken = new Map();

  const app = express();
  app.use(morgan("dev"));
  app.use(express.json({}));
  app.use(express.urlencoded({ extended: true }));

  // ArtCompiler Auth
  app.post("/validateSignIn", buildHttpHandler(async (req, res) => {
    if (!isNonNullObject(req.body) || !isNonEmptyString(req.body.jwt)) {
      throw new InvalidArgumentError("must provide a token");
    }
    const token = req.body.jwt;
    if (!idsByToken.has(token)) {
      throw new UnauthenticatedError();
    }
    const id = idsByToken.get(token);
    if (id instanceof Error) {
      throw id;
    }
    res.status(200).json({ id });
  }));

  // Graffiticode Auth
  app.post("/validate", buildHttpHandler(async (req, res) => {
    if (!isNonNullObject(req.body) || !isNonEmptyString(req.body.token)) {
      throw new InvalidArgumentError("must provide a token");
    }
    const token = req.body.token;
    if (!idsByToken.has(token)) {
      throw new UnauthenticatedError();
    }
    const uid = idsByToken.get(token);
    if (uid instanceof Error) {
      throw uid;
    }
    res.status(200).json({ uid });
  }));

  /* eslint-disable n/handle-callback-err */
  app.use((err, req, res, next) => {
    res.sendStatus(500);
  });

  return {
    app,
    addIdForToken: (token, id) => idsByToken.set(token, id),
    listen: (...params) => app.listen(...params)
  };
};
