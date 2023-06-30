import { NotFoundError } from "@graffiticode/common/errors";
import { generateNonce } from "../../utils.js";

const buildCreateRefreshToken = ({ refreshTokens }) => async ({ uid }) => {
  const refreshToken = await generateNonce(16);
  refreshTokens.set(refreshToken, {
    uid,
    count: 0,
    expires: Date.now() + 2 * 7 * 24 * 60 * 60 * 1000
  });
  return refreshToken;
};

const buildGetRefreshToken = ({ refreshTokens }) => async refreshToken => {
  if (refreshTokens.has(refreshToken)) {
    return refreshTokens.get(refreshToken);
  }
  throw new NotFoundError(`${refreshToken} does not exist`);
};

const buildDeleteRefreshToken = ({ refreshTokens }) => async refreshToken => {
  refreshTokens.delete(refreshToken);
};

export const buildMemoryTokenStorer = () => {
  const refreshTokens = new Map();
  const createRefreshToken = buildCreateRefreshToken({ refreshTokens });
  const deleteRefreshToken = buildDeleteRefreshToken({ refreshTokens });
  const getRefreshToken = buildGetRefreshToken({ refreshTokens });
  return { createRefreshToken, deleteRefreshToken, getRefreshToken };
};
