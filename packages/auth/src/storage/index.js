import { buildApiKeyStorer } from "./api-keys.js";
import { buildEthereumStorer } from "./ethereum.js";
import { buildKeyStorer } from "./keys.js";
import { buildRefreshTokenStorer } from "./refresh-tokens.js";

export const createStorers = () => {
  const apiKeyStorer = buildApiKeyStorer();
  const ethereumStorer = buildEthereumStorer();
  const keyStorer = buildKeyStorer();
  const refreshTokenStorer = buildRefreshTokenStorer();
  return { apiKeyStorer, ethereumStorer, keyStorer, refreshTokenStorer };
};
