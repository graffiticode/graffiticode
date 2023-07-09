import { buildApiKeyService } from "./api-key.js";
import { buildAuthService } from "./auth.js";
import { buildEthereumService } from "./ethereum.js";
import { buildKeysService } from "./keys.js";

export const createServices = ({ apiKeyStorer, ethereumStorer, keyStorer, refreshTokenStorer }) => {
  const keysService = buildKeysService({ keyStorer });
  const authService = buildAuthService({ refreshTokenStorer, keysService });
  const ethereumService = buildEthereumService({ ethereumStorer });
  const apiKeyService = buildApiKeyService({ apiKeyStorer });

  return {
    apiKeyService,
    authService,
    ethereumService,
    keysService,
  };
};
