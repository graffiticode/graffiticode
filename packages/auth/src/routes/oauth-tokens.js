import { InvalidArgumentError, NotFoundError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/http";
import { Router } from "express";
import { requireInternalAuth } from "../middleware/internal-auth.js";

/**
 * Routes for OAuth token management.
 * All routes require internal API key authentication.
 */

const buildCreate = ({ oauthTokensService }) => buildHttpHandler(async (req, res) => {
  const {
    provider_id,
    access_token,
    refresh_token,
    firebase_id_token,
    firebase_refresh_token,
    firebase_token_expires_at,
    client_id,
    client_name,
    scope,
    resource,
  } = req.body;

  if (!isNonEmptyString(provider_id)) {
    throw new InvalidArgumentError("must provide provider_id");
  }
  if (!isNonEmptyString(access_token)) {
    throw new InvalidArgumentError("must provide access_token");
  }
  if (!isNonEmptyString(refresh_token)) {
    throw new InvalidArgumentError("must provide refresh_token");
  }
  if (!isNonEmptyString(firebase_id_token)) {
    throw new InvalidArgumentError("must provide firebase_id_token");
  }
  // firebase_refresh_token is optional - may be empty for direct token usage
  if (typeof firebase_token_expires_at !== "number") {
    throw new InvalidArgumentError("must provide firebase_token_expires_at as number");
  }
  if (!isNonEmptyString(client_id)) {
    throw new InvalidArgumentError("must provide client_id");
  }

  const token = await oauthTokensService.createToken({
    providerId: provider_id,
    tokenData: {
      access_token,
      refresh_token,
      firebase_id_token,
      firebase_refresh_token,
      firebase_token_expires_at,
      client_id,
      client_name: client_name || "Unknown",
      scope: scope || "graffiticode",
      resource,
    },
  });

  sendSuccessResponse(res, { token });
});

const buildGet = ({ oauthTokensService }) => buildHttpHandler(async (req, res) => {
  const { access_token, refresh_token } = req.query;

  let token;
  if (isNonEmptyString(access_token)) {
    token = await oauthTokensService.getByAccessToken(access_token);
  } else if (isNonEmptyString(refresh_token)) {
    token = await oauthTokensService.getByRefreshToken(refresh_token);
  } else {
    throw new InvalidArgumentError("must provide access_token or refresh_token query parameter");
  }

  if (!token) {
    throw new NotFoundError("Token not found");
  }

  sendSuccessResponse(res, { token });
});

const buildUpdate = ({ oauthTokensService }) => buildHttpHandler(async (req, res) => {
  const { access_token } = req.params;

  if (!isNonEmptyString(access_token)) {
    throw new InvalidArgumentError("must provide access_token");
  }

  const updates = {};
  const allowedFields = [
    "firebase_id_token",
    "firebase_refresh_token",
    "firebase_token_expires_at",
  ];

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    throw new InvalidArgumentError("must provide at least one field to update");
  }

  const token = await oauthTokensService.updateToken(access_token, updates);

  sendSuccessResponse(res, { token });
});

const buildDelete = ({ oauthTokensService }) => buildHttpHandler(async (req, res) => {
  const { access_token } = req.params;

  if (!isNonEmptyString(access_token)) {
    throw new InvalidArgumentError("must provide access_token");
  }

  await oauthTokensService.deleteToken(access_token);

  sendSuccessResponse(res, {});
});

const buildRotate = ({ oauthTokensService }) => buildHttpHandler(async (req, res) => {
  const {
    old_refresh_token,
    access_token,
    refresh_token,
    firebase_id_token,
    firebase_refresh_token,
    firebase_token_expires_at,
    client_id,
    client_name,
    scope,
    resource,
  } = req.body;

  if (!isNonEmptyString(old_refresh_token)) {
    throw new InvalidArgumentError("must provide old_refresh_token");
  }
  if (!isNonEmptyString(access_token)) {
    throw new InvalidArgumentError("must provide access_token");
  }
  if (!isNonEmptyString(refresh_token)) {
    throw new InvalidArgumentError("must provide refresh_token");
  }
  if (!isNonEmptyString(firebase_id_token)) {
    throw new InvalidArgumentError("must provide firebase_id_token");
  }
  if (!isNonEmptyString(firebase_refresh_token)) {
    throw new InvalidArgumentError("must provide firebase_refresh_token");
  }
  if (typeof firebase_token_expires_at !== "number") {
    throw new InvalidArgumentError("must provide firebase_token_expires_at as number");
  }
  // client_id is required for the new token entry
  if (!isNonEmptyString(client_id)) {
    throw new InvalidArgumentError("must provide client_id");
  }

  // rotateTokens finds the existing token by old_refresh_token, deletes it, and creates the new one
  const token = await oauthTokensService.rotateTokens(old_refresh_token, {
    access_token,
    refresh_token,
    firebase_id_token,
    firebase_refresh_token,
    firebase_token_expires_at,
    client_id,
    client_name: client_name || "Unknown",
    scope: scope || "graffiticode",
    resource,
  });

  sendSuccessResponse(res, { token });
});

export const buildOAuthTokensRouter = deps => {
  const router = new Router();

  // All routes require internal API key authentication
  router.use(requireInternalAuth);

  router.post("/", buildCreate(deps));
  router.get("/", buildGet(deps));
  router.patch("/:access_token", buildUpdate(deps));
  router.delete("/:access_token", buildDelete(deps));
  router.post("/rotate", buildRotate(deps));

  return router;
};
