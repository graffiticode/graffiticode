import { buildHttpHandler, parseTokenFromRequest } from "@graffiticode/common/http";
import { UnauthenticatedError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { createLocalJWKSet } from "jose";
import { buildVerifyAccessToken } from "../services/auth.js";

export const buildGraffiticodeAuthenticator = ({ keysService }) => buildHttpHandler(async (req, res, next) => {
  req.auth = null;

  const token = parseTokenFromRequest(req);
  if (isNonEmptyString(token)) {
    try {
      const certs = await keysService.getPublicCerts();
      const JWKS = createLocalJWKSet({ keys: certs });
      const verifyAccessToken = buildVerifyAccessToken({ JWKS });
      const { payload, protectedHeader } = await verifyAccessToken(token);
      req.auth = {
        token: { ...payload, ...protectedHeader },
        uid: payload.sub,
      };
    } catch (err) {
      throw new UnauthenticatedError();
    }
  }

  next();
});
