import { buildApiKeyStorer } from "./api-keys.js";
import { buildEthereumStorer } from "./ethereum.js";
import { buildKeyStorer } from "./keys.js";
import { buildOAuthLinkStorer } from "./oauth-links.js";
import { buildOAuthTokenStorer } from "./oauth-tokens.js";
import { buildRefreshTokenStorer } from "./refresh-tokens.js";

export const createStorers = () => {
  const apiKeyStorer = buildApiKeyStorer();
  const ethereumStorer = buildEthereumStorer();
  const keyStorer = buildKeyStorer();
  const oauthLinkStorer = buildOAuthLinkStorer();
  const oauthTokenStorer = buildOAuthTokenStorer();
  const refreshTokenStorer = buildRefreshTokenStorer();
  return { apiKeyStorer, ethereumStorer, keyStorer, oauthLinkStorer, oauthTokenStorer, refreshTokenStorer };
};
