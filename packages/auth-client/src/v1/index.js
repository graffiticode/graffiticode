import { isNonEmptyString } from "@graffiticode/common/utils";
import bent from "bent";
import { createRemoteJWKSet } from "jose";
import "dotenv/config";
import {
  buildCreateApiKey,
  buildDeleteApiKey,
  buildSignInWithApiKey,
} from "./api-keys.js";
import {
  buildGetEthereumNonce,
  buildSignInWithEthereum,
} from "./ethereum.js";
import { buildVerifyAccessToken } from "./tokens.js";

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

export const createClient = ({ url = "https://auth.graffiticode.com", apiKeyId, apiKeyToken }) => {
  const context = initializeContext({ apiKeyId, apiKeyToken });
  const deps = createDeps({ url });

  return {
    // Tokens
    verifyAccessToken: buildVerifyAccessToken(context, deps),

    // Ethereum
    getEthereumNonce: buildGetEthereumNonce(context, deps),
    signInWithEthereum: buildSignInWithEthereum(context, deps),

    // Api Keys
    createApiKey: buildCreateApiKey(context, deps),
    deleteApiKey: buildDeleteApiKey(context, deps),
    signInWithApiKey: buildSignInWithApiKey(context, deps),
  };
};
