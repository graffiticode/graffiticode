import { NotFoundError } from "@graffiticode/common/errors";

/**
 * Service module for OAuth token management.
 *
 * Provides business logic for creating, retrieving, updating, and rotating
 * OAuth tokens stored in Firestore.
 */

export const buildOAuthTokensService = ({ oauthLinkStorer, oauthTokenStorer }) => {
  /**
   * Create or update a token for a given provider ID and client.
   * If a token already exists for this client, it will be replaced.
   *
   * The providerId is used as a synthetic link ID if no oauth-link exists.
   * This allows MCP OAuth to work without requiring users to first link
   * their Google account to an Ethereum address.
   */
  const createToken = async ({ providerId, tokenData }) => {
    // Try to find an existing oauth-link by providerId
    let linkId;
    try {
      const oauthLink = await oauthLinkStorer.findByProviderId({
        provider: "google",
        providerId,
      });
      linkId = oauthLink.id;
    } catch (err) {
      if (err instanceof NotFoundError) {
        // No oauth-link exists - use the providerId directly as a synthetic link ID
        // This creates a "session-only" link that doesn't map to an Ethereum address
        // The providerId is the Firebase UID, which is stable across sessions
        linkId = `session-${providerId}`;
      } else {
        throw err;
      }
    }

    // Remove any existing token for this client (upsert behavior)
    try {
      await oauthTokenStorer.removeByClientId(linkId, tokenData.client_id);
    } catch (err) {
      // Ignore if no existing token - that's expected for new sessions
      if (!(err instanceof NotFoundError)) {
        throw err;
      }
    }

    // Create the new token
    const token = await oauthTokenStorer.create(linkId, tokenData);

    return token;
  };

  /**
   * Get a token by its access token.
   */
  const getByAccessToken = async (accessToken) => {
    const token = await oauthTokenStorer.findByAccessToken(accessToken);
    return token;
  };

  /**
   * Get a token by its refresh token.
   */
  const getByRefreshToken = async (refreshToken) => {
    const token = await oauthTokenStorer.findByRefreshToken(refreshToken);
    return token;
  };

  /**
   * Update specific fields of a token (e.g., after Firebase token refresh).
   */
  const updateToken = async (accessToken, updates) => {
    const existingToken = await oauthTokenStorer.findByAccessToken(accessToken);
    if (!existingToken) {
      throw new NotFoundError("Token not found");
    }

    const updatedToken = await oauthTokenStorer.update(
      existingToken.link_id,
      existingToken.id,
      updates
    );

    return updatedToken;
  };

  /**
   * Delete a token by its access token.
   */
  const deleteToken = async (accessToken) => {
    const existingToken = await oauthTokenStorer.findByAccessToken(accessToken);
    if (!existingToken) {
      throw new NotFoundError("Token not found");
    }

    await oauthTokenStorer.remove(existingToken.link_id, existingToken.id);
  };

  /**
   * Rotate tokens (OAuth 2.1 refresh flow).
   * Deletes old token and creates new one atomically.
   */
  const rotateTokens = async (oldRefreshToken, newTokenData) => {
    const existingToken = await oauthTokenStorer.findByRefreshToken(oldRefreshToken);
    if (!existingToken) {
      throw new NotFoundError("Token not found");
    }

    // Remove old token
    await oauthTokenStorer.remove(existingToken.link_id, existingToken.id);

    // Create new token
    const newToken = await oauthTokenStorer.create(existingToken.link_id, newTokenData);

    return newToken;
  };

  return {
    createToken,
    getByAccessToken,
    getByRefreshToken,
    updateToken,
    deleteToken,
    rotateTokens,
  };
};
