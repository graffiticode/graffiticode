import { addHexPrefix, isValidAddress, stripHexPrefix } from "@ethereumjs/util";
import { InvalidArgumentError, UnauthenticatedError } from "@graffiticode/common/errors";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/http";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { Router } from "express";

import { requireInternalAuth } from "../middleware/internal-auth.js";

const buildApiKeyAuthenticate = ({ apiKeyService, authService }) => buildHttpHandler(async (req, res) => {
  const { token } = req.body;
  if (!isNonEmptyString(token)) {
    throw new InvalidArgumentError("must provide a token");
  }

  const authContext = await apiKeyService.authenticate({ token });
  const firebaseCustomToken = await authService.createFirebaseCustomToken(authContext);
  // Also mint a short-lived (5-min) ES256 access token. Trusted server-to-server
  // callers (e.g. the MCP server building a render URL) need a JWT they can hand
  // to api.graffiticode.org without exposing the raw, long-lived API key. The
  // existing firebaseCustomToken response field is unchanged for back-compat.
  const accessToken = await authService.createAccessToken(authContext);

  sendSuccessResponse(res, { firebaseCustomToken, accessToken });
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

// Server-to-server existence check. The console's admin SDK runs in a
// different Firebase project than the one that holds wallet auth records,
// so it can't check getUser(uid) directly; this route does the lookup
// on the project that owns the records.
const buildEthereumExistsInternal = ({ firebaseAuth }) => buildHttpHandler(async (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(addHexPrefix(address))) {
    throw new InvalidArgumentError(`invalid address: ${address}`);
  }
  const uid = stripHexPrefix(address).toLowerCase();
  try {
    await firebaseAuth.getUser(uid);
    sendSuccessResponse(res, { exists: true });
  } catch (err) {
    if (err?.code === "auth/user-not-found") {
      sendSuccessResponse(res, { exists: false });
      return;
    }
    throw err;
  }
});

const buildEthereumRouter = (deps) => {
  const router = new Router();
  // More-specific internal route must precede the catch-all "/:address".
  router.get("/internal/exists/:address", requireInternalAuth, buildEthereumExistsInternal(deps));
  router.get("/:address", buildEthereumGetNonce(deps));
  router.post("/:address", buildEthereumAuthenticate(deps));
  return router;
};

const buildGoogleAuthenticate = ({ firebaseAuth, authService, oauthLinkStorer, linkedEmailsService }) => buildHttpHandler(async (req, res) => {
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

  const sub = decodedToken.uid;
  const email = decodedToken.email;
  const emailVerified = decodedToken.email_verified === true;

  // Resolve the account: stable Google sub -> verified email (the unified
  // linked-emails registry) -> reject. We never auto-create here; accounts are
  // created (wallet-anchored) by the console sign-in flows. Resolving by
  // verified email is safe because Google is the only OAuth provider and we
  // require email_verified, and registry emails are themselves verified.
  let uid;

  if (await oauthLinkStorer.existsByProviderId({ provider: "google", providerId: sub })) {
    ({ uid } = await oauthLinkStorer.findByProviderId({ provider: "google", providerId: sub }));
  } else if (emailVerified && isNonEmptyString(email)) {
    const record = await linkedEmailsService.lookup({ email });
    if (record) {
      uid = record.uid;
      // Record the stable Google sub -> uid mapping so future sign-ins resolve
      // directly (and survive a Google-side email change). Best-effort: ignore
      // conflicts (e.g. a concurrent sign-in) and never roll back the account.
      try {
        await oauthLinkStorer.create({ uid, provider: "google", providerId: sub, email });
      } catch (err) {
        // Already recorded — fine.
      }
    }
  }

  if (!uid) {
    throw new UnauthenticatedError(
      "No Graffiticode account for this email. Sign in at console.graffiticode.org first, then reconnect."
    );
  }

  // Generate tokens for the resolved account.
  const authContext = { uid, additionalClaims: { oauth: true, oauthProvider: "google" } };
  const { accessToken, refreshToken, firebaseCustomToken } = await authService.generateTokens(authContext);

  // Include uid in response so callers can verify the correct user is being authenticated
  sendSuccessResponse(res, { access_token: accessToken, refresh_token: refreshToken, firebaseCustomToken, uid: authContext.uid });
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
