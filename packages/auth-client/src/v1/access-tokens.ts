import { InvalidArgumentError, UnauthenticatedError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { jwtVerify, errors } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { Context } from "../utils.js";

const ISSUER = "urn:graffiticode:auth";

export const buildVerifyAccessToken = (context: Context, { JWKS }: { JWKS: JWTVerifyGetKey }) => async ({ accessToken }: { accessToken?: string } = {}) => {
  if (!isNonEmptyString(accessToken) && context.has("accessToken")) {
    accessToken = context.get("accessToken");
  }
  if (!isNonEmptyString(accessToken)) {
    throw new InvalidArgumentError("must provide an accessToken");
  }
  let verifyResult;
  try {
    verifyResult = await jwtVerify(accessToken, JWKS, { issuer: ISSUER });
  } catch (err) {
    if (err instanceof errors.JOSEError) {
      throw new UnauthenticatedError(err.code);
    }
    throw err;
  }
  const { payload, protectedHeader } = verifyResult;
  return { uid: payload.sub, token: { ...payload, ...protectedHeader } };
};
