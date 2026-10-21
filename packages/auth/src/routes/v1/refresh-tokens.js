import { Router } from "express";
import { InvalidArgumentError, UnauthenticatedError, UnauthorizedError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/http";
import { requireCleanupAuth } from "../../middleware/internal-auth.js";

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

// The session routes act for the person, so an access token minted from an API key may not
// use them (as with /v1/api-keys).
const requireSessionCaller = req => {
  if (!req.auth) {
    throw new UnauthenticatedError();
  }
  if (req.auth.token?.apiKey) {
    throw new UnauthorizedError();
  }
  return req.auth.uid;
};

const buildListSessions = ({ authService }) => buildHttpHandler(async (req, res) => {
  const uid = requireSessionCaller(req);
  // The caller's own refresh token, if it sends one, marks its session as current. It travels
  // in a header so it never lands in a URL or a request log.
  const currentToken = req.get("x-refresh-token");
  const sessions = await authService.listSessions({ uid, currentToken: isNonEmptyString(currentToken) ? currentToken : undefined });
  sendSuccessResponse(res, sessions);
});

const buildDeleteSession = ({ authService }) => buildHttpHandler(async (req, res) => {
  const uid = requireSessionCaller(req);
  const { id } = req.params;
  if (!isNonEmptyString(id)) {
    throw new InvalidArgumentError("must provide an id");
  }
  await authService.revokeSession({ uid, id });
  sendSuccessResponse(res, null);
});

const buildDeleteAllSessions = ({ authService }) => buildHttpHandler(async (req, res) => {
  const uid = requireSessionCaller(req);
  // Revokes every refresh token for the user (including OAuth-issued ones)
  // except the caller's own, if given. Access tokens already issued remain
  // valid until they expire (5m).
  const { refreshToken } = req.body || {};
  const exceptToken = isNonEmptyString(refreshToken) ? refreshToken : undefined;
  await authService.revokeAllSessions({ uid, exceptToken });
  sendSuccessResponse(res, null);
});

export const buildRefreshTokensRouter = (deps) => {
  // @ts-expect-error TS-MIGRATE: express Router is callable; its types reject `new`
  const router = new Router();

  router.post("/exchange", buildExchange(deps));
  router.post("/revoke", buildRevoke(deps));
  router.post("/clean-expired", requireCleanupAuth, buildCleanExpired(deps));
  router.get("/sessions", buildListSessions(deps));
  router.delete("/sessions/:id", buildDeleteSession(deps));
  router.delete("/sessions", buildDeleteAllSessions(deps));

  return router;
};
