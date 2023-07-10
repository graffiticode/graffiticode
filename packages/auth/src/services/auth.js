import { NotFoundError, UnauthenticatedError } from "@graffiticode/common/errors";
import { importJWK, jwtVerify, SignJWT } from "jose";
import { getAuth } from "../firebase.js";

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

const buildCreateAccessToken = ({ keysService }) => async ({ uid, additionalClaims }) => {
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

const buildGenerateAccessToken = ({ getRefreshToken, createAccessToken }) => async ({ refreshToken }) => {
  const { uid, additionalClaims } = await getRefreshToken(refreshToken);
  return createAccessToken({ uid, additionalClaims });
};

const buildCreateFirebaseCustomToken = ({ firebaseAuth }) => async ({ uid, additionalClaims }) => {
  const firebaseCustomToken = await firebaseAuth.createCustomToken(uid, additionalClaims);
  return firebaseCustomToken;
};

const buildGenerateFirebaseCustomToken = ({ getRefreshToken, createFirebaseCustomToken }) => async ({ refreshToken }) => {
  const { uid, additionalClaims } = await getRefreshToken(refreshToken);
  return createFirebaseCustomToken({ uid, additionalClaims });
};

const buildGenerateTokens = ({ refreshTokenStorer, generateRefreshToken, createAccessToken, createFirebaseCustomToken }) => async ({ uid, additionalClaims }) => {
  const refreshToken = await generateRefreshToken({ uid, additionalClaims });

  try {
    const [accessToken, firebaseCustomToken] = await Promise.all([
      createAccessToken({ uid, additionalClaims }),
      createFirebaseCustomToken({ uid, additionalClaims }),
    ]);
    return { refreshToken, accessToken, firebaseCustomToken };
  } catch (err) {
    console.warn(`Failed to generate ephemeral tokens, removing refreshToken ${refreshToken}`);
    refreshTokenStorer.deleteRefreshToken(refreshToken)
      .catch(err => console.error(`Failed to remove refreshToken ${refreshToken}: ${err.message}`));
    throw err;
  }
};

export const buildAuthService = ({ refreshTokenStorer, keysService }) => {
  const firebaseAuth = getAuth();

  const generateRefreshToken = buildGenerateRefreshToken({ refreshTokenStorer });
  const getRefreshToken = buildGetRefreshToken({ refreshTokenStorer });
  const revokeRefreshToken = buildRevokeRefreshToken({ refreshTokenStorer });

  const createAccessToken = buildCreateAccessToken({ keysService });
  const generateAccessToken = buildGenerateAccessToken({ getRefreshToken, createAccessToken });

  const createFirebaseCustomToken = buildCreateFirebaseCustomToken({ firebaseAuth });
  const generateFirebaseCustomToken = buildGenerateFirebaseCustomToken({ getRefreshToken, createFirebaseCustomToken });

  const generateTokens = buildGenerateTokens({ refreshTokenStorer, generateRefreshToken, createAccessToken, createFirebaseCustomToken });
  return { revokeRefreshToken, generateAccessToken, generateFirebaseCustomToken, generateTokens };
};
