import { isNonEmptyString } from "@graffiticode/common/utils";
import bent from "bent";
import { createRemoteJWKSet } from "jose";
import "dotenv/config";
import { buildVerifyAccessToken } from "./access-tokens.js";
import { buildCreateApiKey, buildDeleteApiKey, buildSignInWithApiKey } from "./api-keys.js";
import { buildGetEthereumNonce, buildSignInWithEthereum } from "./ethereum.js";
import { buildSignInWithGoogle, buildCreateOAuthLink, buildGetOAuthLinks, buildDeleteOAuthLink } from "./oauth.js";
import { buildExchangeRefreshToken, buildRevokeRefreshToken } from "./refresh-tokens.js";

const initializeContext = ({ apiKeyId, apiKeyToken } = {}) => {
  const context = new Map();
  if (isNonEmptyString(apiKeyId)) {
    context.set("apiKeyId", apiKeyId);
  } else if (isNonEmptyString(process.env.GRAFFITICODE_API_KEY_ID)) {
    context.set("apiKeyId", process.env.GRAFFITICODE_API_KEY_ID);
  }
  if (isNonEmptyString(apiKeyToken)) {
    context.set("apiKeyToken", apiKeyToken);
  } else if (isNonEmptyString(process.env.GRAFFITICODE_API_KEY_TOKEN)) {
    context.set("apiKeyToken", process.env.GRAFFITICODE_API_KEY_TOKEN);
  }
  return context;
};

const createDeps = ({ url }) => {
  const v1Url = `${url}/v1`;
  const deps = {
    JWKS: createRemoteJWKSet(new URL(`${v1Url}/certs`)),
    getJSON: bent(v1Url, "GET", "json", 200, 400, 401),
    postJSON: bent(v1Url, "POST", "json", 200, 400, 401),
    deleteJSON: bent(v1Url, "DELETE", "json", 200, 400),
  };
  return deps;
};

const buildUnimplemented = () => async () => {
  throw new Error("Unimplemented");
};

export const createClient = ({ url = "https://auth.graffiticode.com", apiKeyId, apiKeyToken }) => {
  const context = initializeContext({ apiKeyId, apiKeyToken });
  const deps = createDeps({ url });

  return {
    _context: context,

    // Access Tokens
    verifyAccessToken: buildVerifyAccessToken(context, deps),

    // Refresh Tokens
    exchangeRefreshToken: buildExchangeRefreshToken(context, deps),
    revokeRefreshToken: buildRevokeRefreshToken(context, deps),

    // Ethereum
    getEthereumNonce: buildGetEthereumNonce(context, deps),
    signInWithEthereum: buildSignInWithEthereum(context, deps),

    // Api Keys
    createApiKey: buildCreateApiKey(context, deps),
    deleteApiKey: buildDeleteApiKey(context, deps),
    listApiKeys: buildUnimplemented(context, deps),
    signInWithApiKey: buildSignInWithApiKey(context, deps),

    // OAuth
    signInWithGoogle: buildSignInWithGoogle(context, deps),
    createOAuthLink: buildCreateOAuthLink(context, deps),
    getOAuthLinks: buildGetOAuthLinks(context, deps),
    deleteOAuthLink: buildDeleteOAuthLink(context, deps),
  };
};
