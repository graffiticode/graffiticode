import { NotFoundError, UnauthenticatedError } from "@graffiticode/common/errors";
import { importJWK, SignJWT } from "jose";

const buildGenerateRefreshToken = ({ tokenStorer }) => async ({ uid }) => {
  const refreshToken = await tokenStorer.createRefreshToken({ uid });
  console.log(`Generated refreshToken for ${uid}`);
  return refreshToken;
};

const buildGetRefreshToken = ({ tokenStorer }) => async (refreshToken) => {
  try {
    return await tokenStorer.getRefreshToken(refreshToken);
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new UnauthenticatedError(err.message);
    }
    throw err;
  }
};

const buildRevokeRefreshToken = ({ tokenStorer }) => async (refreshToken) => {
  await tokenStorer.deleteRefreshToken(refreshToken);
};

const buildGenerateAccessToken = ({ getRefreshToken, keys }) => async ({ refreshToken }) => {
  const { uid } = await getRefreshToken(refreshToken);
  const { kid, alg, privateJwk } = await keys.getCurrentKey();

  const privateKey = await importJWK(privateJwk, alg);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ typ: "JWT", alg, kid })
    .setIssuer("urn:graffiticode:auth")
    .setSubject(uid)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  console.log(`Generated access token for ${uid} signed with key ${kid}`);

  return jwt;
};

const buildGenerateTokens = ({ tokenStorer, generateRefreshToken, generateAccessToken }) => async ({ uid }) => {
  const refreshToken = await generateRefreshToken({ uid });
  let accessToken;
  try {
    accessToken = await generateAccessToken({ refreshToken });
  } catch (err) {
    console.warn(`Failed to generate accessToken, removing refreshToken ${refreshToken}`);
    tokenStorer.deleteRefreshToken(refreshToken)
      .catch(err => console.error(`Failed to remove refreshToken ${refreshToken}: ${err.message}`));
    throw err;
  }
  return { refreshToken, accessToken };
};

export const buildAuthService = ({ tokenStorer, keys }) => {
  const generateRefreshToken = buildGenerateRefreshToken({ tokenStorer });
  const getRefreshToken = buildGetRefreshToken({ tokenStorer });
  const revokeRefreshToken = buildRevokeRefreshToken({ tokenStorer });
  const generateAccessToken = buildGenerateAccessToken({ getRefreshToken, keys });
  const generateTokens = buildGenerateTokens({ tokenStorer, generateRefreshToken, generateAccessToken });
  return { revokeRefreshToken, generateAccessToken, generateTokens };
};
