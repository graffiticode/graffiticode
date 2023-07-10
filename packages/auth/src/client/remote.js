import bent from "bent";
import { createRemoteJWKSet } from "jose";
import { buildVerifyAccessToken } from "../services/auth.js";
import { buildApiKeysClient } from "./api-keys.js";
import { getDataOrThrowError } from "./utils.js";
import { buildEthereumClient } from "./ethereum.js";

const buildClientVerifyAccessToken = ({ JWKS }) => {
  const verifyAccessToken = buildVerifyAccessToken({ JWKS });
  return async (token) => {
    const { payload, protectedHeader } = await verifyAccessToken(token);
    return { uid: payload.sub, token: { ...payload, ...protectedHeader } };
  };
};

const buildVerifyToken = ({ postJSON }) => async (idToken) => {
  const res = await postJSON("/oauth/verify", { idToken });
  const data = await getDataOrThrowError(res);
  return data;
};

const buildExchangeRefreshToken = ({ postJSON }) => async (refresh_token) => {
  const grant_type = "refresh_token";
  const res = await postJSON("/oauth/token", { grant_type, refresh_token });
  const data = await getDataOrThrowError(res);
  return data;
};

const buildRevokeRefreshToken = ({ postJSON }) => async (token) => {
  const res = await postJSON("/oauth/revoke", { token });
  await getDataOrThrowError(res);
};

export const createClient = (url = "https://auth.graffiticode.com") => {
  const JWKS = createRemoteJWKSet(new URL(`${url}/certs`));
  const getJSON = bent(url, "GET", "json", 200, 400, 401);
  const postJSON = bent(url, "POST", "json", 200, 400, 401);
  const deleteJSON = bent(url, "DELETE", "json", 200, 400);
  return {
    verifyAccessToken: buildClientVerifyAccessToken({ JWKS }),
    verifyToken: buildVerifyToken({ postJSON }),

    exchangeRefreshToken: buildExchangeRefreshToken({ postJSON }),
    revokeRefreshToken: buildRevokeRefreshToken({ postJSON }),

    ethereum: buildEthereumClient({ getJSON, postJSON }),
    apiKeys: buildApiKeysClient({ postJSON, deleteJSON }),
  };
};
