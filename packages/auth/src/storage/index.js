import { buildApiKeyStorer } from "./api-keys.js";
import { buildEmailInviteStorer } from "./email-invites.js";
import { buildEmailTransferRequestStorer } from "./email-transfer-requests.js";
import { buildEthereumStorer } from "./ethereum.js";
import { buildKeyStorer } from "./keys.js";
import { buildLinkedEmailStorer } from "./linked-emails.js";
import { buildOAuthFlowStorer } from "./oauth-flow.js";
import { buildOAuthLinkStorer } from "./oauth-links.js";
import { buildOAuthTokenStorer } from "./oauth-tokens.js";
import { buildRefreshTokenStorer } from "./refresh-tokens.js";

export const createStorers = () => {
  const apiKeyStorer = buildApiKeyStorer();
  const emailInviteStorer = buildEmailInviteStorer();
  const emailTransferRequestStorer = buildEmailTransferRequestStorer();
  const ethereumStorer = buildEthereumStorer();
  const keyStorer = buildKeyStorer();
  const linkedEmailStorer = buildLinkedEmailStorer();
  const oauthLinkStorer = buildOAuthLinkStorer();
  const oauthTokenStorer = buildOAuthTokenStorer();
  const refreshTokenStorer = buildRefreshTokenStorer();
  // Ephemeral OAuth flow records (identity-less, short-lived).
  const oauthClientStorer = buildOAuthFlowStorer("oauth-clients");
  const oauthPendingStorer = buildOAuthFlowStorer("oauth-pending");
  const oauthCodeStorer = buildOAuthFlowStorer("oauth-codes");
  return {
    apiKeyStorer,
    emailInviteStorer,
    emailTransferRequestStorer,
    ethereumStorer,
    keyStorer,
    linkedEmailStorer,
    oauthLinkStorer,
    oauthTokenStorer,
    refreshTokenStorer,
    oauthClientStorer,
    oauthPendingStorer,
    oauthCodeStorer,
  };
};
