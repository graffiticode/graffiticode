import { buildHttpHandler, parseTokenFromRequest } from "@graffiticode/common/http";
import { UnauthenticatedError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";

export const buildGraffiticodeAuthenticator = ({ authService }) => buildHttpHandler(async (req, res, next) => {
  req.auth = null;

  // Skip token verification for internal API key authenticated routes
  // These routes handle their own authentication via X-Internal-API-Key header
  if (req.headers["x-internal-api-key"]) {
    return next();
  }

  const token = parseTokenFromRequest(req);
  if (isNonEmptyString(token)) {
    try {
      const decodedToken = await authService.verifyToken({ token });
      req.auth = {
        token: decodedToken,
        uid: decodedToken.uid,
      };
    } catch (err) {
      throw new UnauthenticatedError();
    }
  }

  next();
});
