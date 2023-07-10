import { buildHttpHandler, parseTokenFromRequest } from "@graffiticode/common/http";
import { UnauthenticatedError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";

export const buildGraffiticodeAuthenticator = ({ authService }) => buildHttpHandler(async (req, res, next) => {
  req.auth = null;

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
