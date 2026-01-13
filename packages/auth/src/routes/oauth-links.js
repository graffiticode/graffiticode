import { InvalidArgumentError, UnauthorizedError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/http";
import { Router } from "express";

const buildCreate = ({ firebaseAuth, oauthService }) => buildHttpHandler(async (req, res) => {
  if (!req.auth) {
    throw new UnauthorizedError();
  }
  if (req.auth.token.apiKey) {
    throw new UnauthorizedError("Cannot create OAuth link with API key");
  }
  const { uid } = req.auth;

  const { provider, idToken } = req.body;
  if (!isNonEmptyString(provider)) {
    throw new InvalidArgumentError("must provide provider");
  }
  if (!isNonEmptyString(idToken)) {
    throw new InvalidArgumentError("must provide idToken");
  }

  // Verify the Google ID token
  const decodedToken = await firebaseAuth.verifyIdToken(idToken);
  const providerId = decodedToken.uid;
  const email = decodedToken.email || null;

  const oauthLink = await oauthService.createLink({ uid, provider, providerId, email });

  sendSuccessResponse(res, {
    id: oauthLink.id,
    provider: oauthLink.provider,
    email: oauthLink.email
  });
});

const buildList = ({ oauthService }) => buildHttpHandler(async (req, res) => {
  if (!req.auth) {
    throw new UnauthorizedError();
  }
  const { uid } = req.auth;

  const oauthLinks = await oauthService.listLinks({ uid });

  const links = oauthLinks.map(link => ({
    id: link.id,
    provider: link.provider,
    email: link.email,
    createdAt: link.createdAt,
  }));

  sendSuccessResponse(res, { links });
});

const buildDelete = ({ oauthService }) => buildHttpHandler(async (req, res) => {
  if (!req.auth) {
    throw new UnauthorizedError();
  }
  if (req.auth.token.apiKey) {
    throw new UnauthorizedError("Cannot delete OAuth link with API key");
  }
  const { uid } = req.auth;

  const { provider } = req.params;
  if (!isNonEmptyString(provider)) {
    throw new InvalidArgumentError("must provide provider");
  }

  await oauthService.removeLink({ uid, provider });

  sendSuccessResponse(res, {});
});

export const buildOAuthLinksRouter = deps => {
  const router = new Router();
  router.post("/", buildCreate(deps));
  router.get("/", buildList(deps));
  router.delete("/:provider", buildDelete(deps));
  return router;
};
