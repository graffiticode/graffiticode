import { Router } from "express";
import { InvalidArgumentError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/http";

const buildExchange = ({ authService }) => buildHttpHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!isNonEmptyString(refreshToken)) {
    throw new InvalidArgumentError("must provide a refreshToken");
  }
  const accessToken = await authService.generateAccessToken({ refreshToken });
  sendSuccessResponse(res, { accessToken });
});

const buildRevoke = ({ authService }) => buildHttpHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!isNonEmptyString(refreshToken)) {
    throw new InvalidArgumentError("must provide a refreshToken");
  }
  await authService.revokeRefreshToken({ refreshToken });
  sendSuccessResponse(res, null);
});

export const buildRefreshTokensRouter = (deps) => {
  const router = new Router();

  router.post("/exchange", buildExchange(deps));
  router.post("/revoke", buildRevoke(deps));

  return router;
};
