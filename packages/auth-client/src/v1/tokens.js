import { UnauthenticatedError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { jwtVerify, errors } from "jose";

const ISSUER = "urn:graffiticode:auth";

export const buildVerifyAccessToken = (context, { JWKS }) => async (token) => {
  if (!isNonEmptyString(token) && context.has("accessToken")) {
    token = context.get("accessToken");
  }
  if (!isNonEmptyString(token)) {
    throw new Error("must provide a token");
  }
  let verifyResult;
  try {
    verifyResult = await jwtVerify(token, JWKS, { issuer: ISSUER });
  } catch (err) {
    if (err instanceof errors.JOSEError) {
      throw new UnauthenticatedError(err.code);
    }
    throw err;
  }
  const { payload, protectedHeader } = verifyResult;
  return { uid: payload.sub, token: { ...payload, ...protectedHeader } };
};
