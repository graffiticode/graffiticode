import { Router } from "express";
import { InvalidArgumentError, UnauthenticatedError } from "@graffiticode/common/errors";
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

const buildCleanExpired = ({ authService }) => buildHttpHandler(async (req, res) => {
  await authService.cleanExpiredRefreshTokens();
  sendSuccessResponse(res, null);
});

const buildListSessions = ({ authService }) => buildHttpHandler(async (req, res) => {
  if (!req.auth) {
    throw new UnauthenticatedError();
  }
  const { uid } = req.auth;
  const sessions = await authService.listSessions({ uid });
  sendSuccessResponse(res, sessions);
});

const buildDeleteSession = ({ authService }) => buildHttpHandler(async (req, res) => {
  if (!req.auth) {
    throw new UnauthenticatedError();
  }
  const { uid } = req.auth;
  const { id } = req.params;
  if (!isNonEmptyString(id)) {
    throw new InvalidArgumentError("must provide an id");
  }
  await authService.revokeSession({ uid, id });
  sendSuccessResponse(res, null);
});

const buildDeleteAllSessions = ({ authService }) => buildHttpHandler(async (req, res) => {
  if (!req.auth) {
    throw new UnauthenticatedError();
  }
  const { uid } = req.auth;
  await authService.revokeAllSessions({ uid });
  sendSuccessResponse(res, null);
});

export const buildRefreshTokensRouter = (deps) => {
  const router = new Router();

  router.post("/exchange", buildExchange(deps));
  router.post("/revoke", buildRevoke(deps));
  router.post("/clean-expired", buildCleanExpired(deps));
  router.get("/sessions", buildListSessions(deps));
  router.delete("/sessions/:id", buildDeleteSession(deps));
  router.delete("/sessions", buildDeleteAllSessions(deps));

  return router;
};
