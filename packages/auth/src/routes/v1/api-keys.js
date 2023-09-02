import { InvalidArgumentError, UnauthorizedError, UnauthenticatedError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/http";
import { Router } from "express";

const buildCreate = ({ apiKeyService }) => buildHttpHandler(async (req, res) => {
  if (!req.auth) {
    throw new UnauthorizedError();
  }
  if (req.auth.token.apiKey) {
    throw new UnauthorizedError();
  }
  const { uid } = req.auth;

  const { id, token } = await apiKeyService.create({ uid });

  sendSuccessResponse(res, { id, token });
});

const buildDelete = ({ apiKeyService }) => buildHttpHandler(async (req, res) => {
  if (!req.auth) {
    throw new UnauthorizedError();
  }
  if (req.auth.token.apiKey) {
    throw new UnauthorizedError();
  }
  const { uid } = req.auth;

  const { id } = req.params;
  if (!isNonEmptyString(id)) {
    throw new InvalidArgumentError("must provide an id");
  }

  await apiKeyService.remove({ requestingUid: uid, id });

  sendSuccessResponse(res, {});
});

const buildAuthenticate = ({ authService, apiKeyService }) => buildHttpHandler(async (req, res) => {
  const { id } = req.params;
  const { token } = req.body;
  if (!isNonEmptyString(token)) {
    throw new UnauthenticatedError();
  }
  const authContext = await apiKeyService.authenticateWithId({ id, token });
  const accessToken = await authService.createAccessToken(authContext);
  sendSuccessResponse(res, { accessToken });
});

export const buildApiKeysRouter = deps => {
  const router = new Router();
  router.post("/", buildCreate(deps));
  router.delete("/:id", buildDelete(deps));
  router.post("/:id/authenticate", buildAuthenticate(deps));
  return router;
};
