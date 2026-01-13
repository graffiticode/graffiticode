import { buildApiKeyService } from "./api-key.js";
import { buildAuthService } from "./auth.js";
import { buildEthereumService } from "./ethereum.js";
import { buildKeysService } from "./keys.js";
import { buildOAuthService } from "./oauth.js";

export const createServices = ({ firebaseAuth, apiKeyStorer, ethereumStorer, keyStorer, oauthLinkStorer, refreshTokenStorer }) => {
  const keysService = buildKeysService({ keyStorer });
  const authService = buildAuthService({ firebaseAuth, refreshTokenStorer, keysService });
  const ethereumService = buildEthereumService({ ethereumStorer });
  const apiKeyService = buildApiKeyService({ apiKeyStorer });
  const oauthService = buildOAuthService({ oauthLinkStorer });

  return {
    apiKeyService,
    authService,
    ethereumService,
    keysService,
    oauthService,
  };
};
