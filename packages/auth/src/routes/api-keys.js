import { InvalidArgumentError, UnauthorizedError } from "@graffiticode/common/errors";
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

  const { token: apiKey } = await apiKeyService.create({ uid });

  sendSuccessResponse(res, { apiKey });
});

const buildDelete = ({ apiKeyService }) => buildHttpHandler(async (req, res) => {
  if (!req.auth) {
    throw new UnauthorizedError();
  }
  if (req.auth.token.apiKey) {
    throw new UnauthorizedError();
  }
  const { uid } = req.auth;

  const { apiKey } = req.params;
  if (!isNonEmptyString(apiKey)) {
    throw new InvalidArgumentError("must provide an apiKey");
  }

  await apiKeyService.remove({ requestingUid: uid, apiKey });

  sendSuccessResponse(res, {});
});

export const buildApiKeysRouter = deps => {
  const router = new Router();
  router.post("/", buildCreate(deps));
  router.delete("/:apiKey", buildDelete(deps));
  return router;
};
