import { buildApiKeyService } from "./api-key.js";
import { buildAuthService } from "./auth.js";
import { buildEthereumService } from "./ethereum.js";
import { buildKeysService } from "./keys.js";
import { buildLinkedEmailsService } from "./linked-emails.js";
import { buildOAuthService } from "./oauth.js";
import { buildOAuthTokensService } from "./oauth-tokens.js";
import { checkUnfenced } from "../storage/oauth-migration.js";

export const createServices = ({
  firebaseAuth,
  apiKeyStorer,
  ethereumStorer,
  keyStorer,
  linkedEmailStorer,
  oauthLinkStorer,
  oauthTokenStorer,
  refreshTokenStorer,
}) => {
  const keysService = buildKeysService({ keyStorer });
  const authService = buildAuthService({ firebaseAuth, refreshTokenStorer, keysService });
  const ethereumService = buildEthereumService({ ethereumStorer });
  const apiKeyService = buildApiKeyService({ apiKeyStorer });
  const linkedEmailsService = buildLinkedEmailsService({ linkedEmailStorer });
  const oauthService = buildOAuthService({ oauthLinkStorer, linkedEmailsService });
  const oauthTokensService = buildOAuthTokensService({ oauthLinkStorer, oauthTokenStorer, checkUnfenced });

  return {
    apiKeyService,
    authService,
    ethereumService,
    keysService,
    linkedEmailsService,
    oauthService,
    oauthTokensService,
  };
};
