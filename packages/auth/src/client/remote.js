import bent from "bent";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { buildApiKeyClient } from "./api-keys.js";
import { getDataOrThrowError } from "./utils.js";
import { buildEthereumClient } from "./ethereum.js";

const buildVerifyAccessToken = ({ JWKS }) => async (access_token) => {
  const { payload: { sub: uid } } = await jwtVerify(
    access_token,
    JWKS,
    { issuer: "urn:graffiticode:auth" }
  );
  return { uid };
};

const buildExchangeRefreshToken = ({ postJSON }) => async (refresh_token) => {
  const grant_type = "refresh_token";
  const res = await postJSON("/oauth/token", { grant_type, refresh_token });
  const { access_token } = await getDataOrThrowError(res);
  return { access_token };
};

const buildRevokeRefreshToken = ({ postJSON }) => async (token) => {
  const res = await postJSON("/oauth/revoke", { token });
  await getDataOrThrowError(res);
};

export const createClient = (url = "https://auth.graffiticode.com") => {
  const JWKS = createRemoteJWKSet(new URL(`${url}/certs`));
  const getJSON = bent(url, "GET", "json", 200, 400, 401);
  const postJSON = bent(url, "POST", "json", 200, 400, 401);
  return {
    verifyAccessToken: buildVerifyAccessToken({ JWKS }),

    exchangeRefreshToken: buildExchangeRefreshToken({ postJSON }),
    revokeRefreshToken: buildRevokeRefreshToken({ postJSON }),

    ethereum: buildEthereumClient({ getJSON, postJSON }),
    apiKey: buildApiKeyClient({ postJSON }),
  };
};
