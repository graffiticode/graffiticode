import { buildApiKeyService } from "./api-key.js";
import { buildAuthService } from "./auth.js";
import { buildEthereumService } from "./ethereum.js";
import { buildKeysService } from "./keys.js";
import { buildOAuthService } from "./oauth.js";
import { buildOAuthTokensService } from "./oauth-tokens.js";

export const createServices = ({ firebaseAuth, apiKeyStorer, ethereumStorer, keyStorer, oauthLinkStorer, oauthTokenStorer, refreshTokenStorer }) => {
  const keysService = buildKeysService({ keyStorer });
  const authService = buildAuthService({ firebaseAuth, refreshTokenStorer, keysService });
  const ethereumService = buildEthereumService({ ethereumStorer });
  const apiKeyService = buildApiKeyService({ apiKeyStorer });
  const oauthService = buildOAuthService({ oauthLinkStorer });
  const oauthTokensService = buildOAuthTokensService({ oauthLinkStorer, oauthTokenStorer });

  return {
    apiKeyService,
    authService,
    ethereumService,
    keysService,
    oauthService,
    oauthTokensService,
  };
};
