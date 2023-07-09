import { NotFoundError, UnauthenticatedError } from "@graffiticode/common/errors";
import { importJWK, jwtVerify, SignJWT } from "jose";

const ISSUER = "urn:graffiticode:auth";

export const buildVerifyAccessToken = ({ JWKS }) => async (token) => {
  const { payload, protectedHeader } = await jwtVerify(token, JWKS, { issuer: ISSUER });
  return { payload, protectedHeader };
};

const buildGenerateRefreshToken = ({ refreshTokenStorer }) => async ({ uid, additionalClaims }) => {
  const refreshToken = await refreshTokenStorer.createRefreshToken({ uid, additionalClaims });
  console.log(`Generated refreshToken for ${uid}`);
  return refreshToken;
};

const buildGetRefreshToken = ({ refreshTokenStorer }) => async (refreshToken) => {
  try {
    return await refreshTokenStorer.getRefreshToken(refreshToken);
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new UnauthenticatedError(err.message);
    }
    throw err;
  }
};

const buildRevokeRefreshToken = ({ refreshTokenStorer }) => async (refreshToken) => {
  await refreshTokenStorer.deleteRefreshToken(refreshToken);
};

const buildGenerateAccessToken = ({ getRefreshToken, keysService }) => async ({ refreshToken }) => {
  const { uid, additionalClaims } = await getRefreshToken(refreshToken);
  const { kid, alg, privateJwk } = await keysService.getCurrentKey();

  const privateKey = await importJWK(privateJwk, alg);
  const jwt = await new SignJWT({ ...additionalClaims })
    .setProtectedHeader({ typ: "JWT", alg, kid })
    .setIssuer(ISSUER)
    .setSubject(uid)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  console.log(`Generated access token for ${uid} signed with key ${kid}`);

  return jwt;
};

const buildGenerateTokens = ({ refreshTokenStorer, generateRefreshToken, generateAccessToken }) => async ({ uid, additionalClaims }) => {
  const refreshToken = await generateRefreshToken({ uid, additionalClaims });
  let accessToken;
  try {
    accessToken = await generateAccessToken({ refreshToken });
  } catch (err) {
    console.warn(`Failed to generate accessToken, removing refreshToken ${refreshToken}`);
    refreshTokenStorer.deleteRefreshToken(refreshToken)
      .catch(err => console.error(`Failed to remove refreshToken ${refreshToken}: ${err.message}`));
    throw err;
  }
  return { refreshToken, accessToken };
};

export const buildAuthService = ({ refreshTokenStorer, keysService }) => {
  const generateRefreshToken = buildGenerateRefreshToken({ refreshTokenStorer });
  const getRefreshToken = buildGetRefreshToken({ refreshTokenStorer });
  const revokeRefreshToken = buildRevokeRefreshToken({ refreshTokenStorer });
  const generateAccessToken = buildGenerateAccessToken({ getRefreshToken, keysService });
  const generateTokens = buildGenerateTokens({ refreshTokenStorer, generateRefreshToken, generateAccessToken });
  return { revokeRefreshToken, generateAccessToken, generateTokens };
};
