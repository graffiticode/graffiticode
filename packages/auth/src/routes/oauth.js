import { InvalidArgumentError } from "@graffiticode/common/errors";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/http";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { Router } from "express";

const buildRefreshTokenCommand = ({ authService }) => ({
  async validate(req) {
    const { refresh_token: refreshToken } = req.body;
    if (!isNonEmptyString(refreshToken)) {
      throw new InvalidArgumentError("must provide a refresh_token");
    }
    return { refreshToken };
  },
  async execute({ refreshToken }) {
    const [accessToken, firebaseCustomToken] = await Promise.all([
      authService.generateAccessToken({ refreshToken }),
      authService.generateFirebaseCustomToken({ refreshToken }),
    ]);
    return { access_token: accessToken, firebaseCustomToken };
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

const buildRevokeToken = ({ authService }) => buildHttpHandler(async (req, res) => {
  const { token } = req.body;
  if (!isNonEmptyString(token)) {
    throw new InvalidArgumentError("must provide a token");
  }

  await authService.revokeRefreshToken({ refreshToken: token });

  sendSuccessResponse(res, null);
});

const buildRevokeRouter = (deps) => {
  const router = new Router();
  router.post("/", buildRevokeToken(deps));
  return router;
};

const buildVerifyHandler = ({ authService }) => buildHttpHandler(async (req, res) => {
  const { idToken } = req.body;
  if (!isNonEmptyString(idToken)) {
    throw new InvalidArgumentError("must provide a idToken");
  }

  try {
    const token = await authService.verifyToken({ token: idToken });

    sendSuccessResponse(res, { uid: token.uid, token });
  } catch (error) {
    console.log(error);
    console.log(error.stack);
    throw error;
  }
});

export const buildOAuthRouter = deps => {
  const router = new Router();
  router.use("/token", buildTokenRouter(deps));
  router.use("/revoke", buildRevokeRouter(deps));
  router.post("/verify", buildVerifyHandler(deps));
  return router;
};
