import { NotFoundError, UnauthenticatedError } from "@graffiticode/common/errors";
import { createLocalJWKSet, importJWK, jwtVerify, SignJWT } from "jose";

const ISSUER = "urn:graffiticode:auth";

export const buildVerifyAccessToken = ({ JWKS }) => async (token) => {
  const { payload, protectedHeader } = await jwtVerify(token, JWKS, { issuer: ISSUER });
  return { payload, protectedHeader };
};

const buildVerifyToken = ({ firebaseAuth, keysService }) => async ({ token }) => {
  try {
    const decodedToken = await firebaseAuth.verifyIdToken(token, true);
    return decodedToken;
  } catch (err) {
    if (err.code !== "auth/argument-error") {
      console.warn(`Failed to verify token with firebase: ${err.code}`);
      throw err;
    }
  }

  try {
    const certs = await keysService.getPublicCerts();
    const JWKS = createLocalJWKSet({ keys: certs });
    const verifyAccessToken = buildVerifyAccessToken({ JWKS });
    const { payload, protectedHeader } = await verifyAccessToken(token);
    return { ...payload, ...protectedHeader, uid: payload.sub };
  } catch (err) {
    console.warn(`Failed to verify token with JOSE: ${err.code}`);
  }

  throw new UnauthenticatedError();
};

const buildGenerateRefreshToken = ({ refreshTokenStorer }) => async ({ uid, additionalClaims }) => {
  const { token } = await refreshTokenStorer.createRefreshToken({ uid, additionalClaims });
  return token;
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
    console.log(err);
    console.log(err.stack);
    console.warn("Failed to generate ephemeral tokens, removing refreshToken");
    refreshTokenStorer.deleteRefreshToken(refreshToken)
      .catch(err => console.error(`Failed to remove refreshToken ${refreshToken}: ${err.message}`));
    throw err;
  }
};

export const buildAuthService = ({ firebaseAuth, refreshTokenStorer, keysService }) => {
  const verifyToken = buildVerifyToken({ firebaseAuth, keysService });

  const generateRefreshToken = buildGenerateRefreshToken({ refreshTokenStorer });
  const getRefreshToken = buildGetRefreshToken({ refreshTokenStorer });
  const revokeRefreshToken = buildRevokeRefreshToken({ refreshTokenStorer });

  const createAccessToken = buildCreateAccessToken({ keysService });
  const generateAccessToken = buildGenerateAccessToken({ getRefreshToken, createAccessToken });

  const createFirebaseCustomToken = buildCreateFirebaseCustomToken({ firebaseAuth });
  const generateFirebaseCustomToken = buildGenerateFirebaseCustomToken({ getRefreshToken, createFirebaseCustomToken });

  const generateTokens = buildGenerateTokens({ refreshTokenStorer, generateRefreshToken, createAccessToken, createFirebaseCustomToken });

  return { verifyToken, revokeRefreshToken, createFirebaseCustomToken, generateAccessToken, generateFirebaseCustomToken, generateTokens };
};
