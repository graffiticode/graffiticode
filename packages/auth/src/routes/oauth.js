import { Router } from "express";
import { InvalidArgumentError } from "../errors/http.js";
import { isNonEmptyString } from "../utils.js";
import { buildHttpHandler, sendSuccessResponse } from "./utils.js";

const buildRefreshTokenCommand = ({ auth }) => ({
  async validate(req) {
    const { refresh_token } = req.body;
    if (!isNonEmptyString(refresh_token)) {
      throw new InvalidArgumentError("must provide a refresh_token");
    }
    return { refresh_token };
  },
  async execute({ refresh_token }) {
    const access_token = await auth.generateAccessToken({ refreshToken: refresh_token });
    return { access_token };
  }
});

const buildTokenExchange = (deps) => {
  const types = new Map();
  types.set("refresh_token", buildRefreshTokenCommand(deps));
  return buildHttpHandler(async (req, res) => {
    const { grant_type } = req.body;
    if (!isNonEmptyString(grant_type)) {
      throw new InvalidArgumentError("must provide a grant_type");
    }
    if (!types.has(grant_type)) {
      throw new InvalidArgumentError(`unknown grant_type ${grant_type}`);
    }
    const { validate, execute } = types.get(grant_type);
    const exeReq = await validate(req);
    const data = await execute(exeReq);
    sendSuccessResponse(res, data);
  });
};

const buildTokenRouter = (deps) => {
  const router = new Router();
  router.post("/", buildTokenExchange(deps));
  return router;
};

const buildRevokeToken = ({ auth }) => buildHttpHandler(async (req, res) => {
  const { token } = req.body;
  if (!isNonEmptyString(token)) {
    throw new InvalidArgumentError("must provide a token");
  }

  await auth.revokeRefreshToken(token);

  sendSuccessResponse(res, null);
});

const buildRevokeRouter = (deps) => {
  const router = new Router();
  router.post("/", buildRevokeToken(deps));
  return router;
};

export const buildOAuthRouter = deps => {
  const router = new Router();
  router.use("/token", buildTokenRouter(deps));
  router.use("/revoke", buildRevokeRouter(deps));
  return router;
};
