import { buildEthereumStorer } from "./ethereum.js";
import { buildKeyStorer } from "./keys.js";
import { buildRefreshTokenStorer } from "./refresh-tokens.js";

export const createStorers = () => {
  const ethereumStorer = buildEthereumStorer();
  const keyStorer = buildKeyStorer();
  const refreshTokenStorer = buildRefreshTokenStorer();
  return { ethereumStorer, keyStorer, refreshTokenStorer };
};
