import { addHexPrefix, isValidAddress } from "@ethereumjs/util";
import { InvalidArgumentError, UnauthenticatedError } from "@graffiticode/common/errors";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/http";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { Router } from "express";

const buildApiKeyAuthenticate = ({ apiKeyService, authService }) => buildHttpHandler(async (req, res) => {
  const { token } = req.body;
  if (!isNonEmptyString(token)) {
    throw new InvalidArgumentError("must provide a token");
  }

  const authContext = await apiKeyService.authenticate({ token });
  const firebaseCustomToken = await authService.createFirebaseCustomToken(authContext);

  sendSuccessResponse(res, { firebaseCustomToken });
});

const buildApiKeyRouter = (deps) => {
  const router = new Router();
  router.post("/", buildApiKeyAuthenticate(deps));
  return router;
};

const buildEthereumGetNonce = ({ ethereumService }) => buildHttpHandler(async (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(addHexPrefix(address))) {
    throw new InvalidArgumentError(`invalid address: ${address}`);
  }
  const nonce = await ethereumService.getNonce({ address });
  sendSuccessResponse(res, nonce);
});

const buildEthereumAuthenticate = ({ authService, ethereumService }) => buildHttpHandler(async (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(addHexPrefix(address))) {
    throw new InvalidArgumentError(`invalid address: ${address}`);
  }
  let { nonce, signature } = req.body;
  if (!isNonEmptyString(nonce)) {
    throw new InvalidArgumentError("must provide a nonce");
  }
  signature = addHexPrefix(signature);
  if (!isNonEmptyString(signature)) {
    throw new InvalidArgumentError("must provide a signature");
  }

  const authContext = await ethereumService.authenticate({ address, nonce, signature });

  const { accessToken, refreshToken, firebaseCustomToken } = await authService.generateTokens(authContext);

  sendSuccessResponse(res, { access_token: accessToken, refresh_token: refreshToken, firebaseCustomToken });
});

const buildEthereumRouter = (deps) => {
  const router = new Router();
  router.get("/:address", buildEthereumGetNonce(deps));
  router.post("/:address", buildEthereumAuthenticate(deps));
  return router;
};

const buildGoogleAuthenticate = ({ firebaseAuth, authService, oauthService }) => buildHttpHandler(async (req, res) => {
  const { idToken } = req.body;
  if (!isNonEmptyString(idToken)) {
    throw new InvalidArgumentError("must provide idToken");
  }

  // Verify the Google ID token
  let decodedToken;
  try {
    decodedToken = await firebaseAuth.verifyIdToken(idToken);
  } catch (err) {
    throw new UnauthenticatedError("Invalid Google ID token");
  }

  const providerId = decodedToken.uid;

  // Look up the linked Ethereum address
  const authContext = await oauthService.authenticate({ provider: "google", providerId });

  // Generate tokens for the linked Ethereum address
  const { accessToken, refreshToken, firebaseCustomToken } = await authService.generateTokens(authContext);

  sendSuccessResponse(res, { access_token: accessToken, refresh_token: refreshToken, firebaseCustomToken });
});

const buildGoogleRouter = (deps) => {
  const router = new Router();
  router.post("/", buildGoogleAuthenticate(deps));
  return router;
};

export const buildAuthenticateRouter = deps => {
  const router = new Router();
  router.use("/api-key", buildApiKeyRouter(deps));
  router.use("/ethereum", buildEthereumRouter(deps));
  router.use("/google", buildGoogleRouter(deps));
  return router;
};
