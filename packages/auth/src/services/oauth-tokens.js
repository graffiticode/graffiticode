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
   * Auto-creates an oauth-link if one doesn't exist for the provider ID.
   */
  const createToken = async ({ providerId, email, tokenData }) => {
    let oauthLink;
    try {
      oauthLink = await oauthLinkStorer.findByProviderId({
        provider: "google",
        providerId,
      });
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        throw err;
      }
      // Auto-create oauth-link for new OAuth users
      oauthLink = await oauthLinkStorer.create({
        uid: providerId,
        provider: "google",
        providerId,
        email: email || "",
      });
    }

    // Remove any existing token for this client (upsert behavior)
    try {
      await oauthTokenStorer.removeByClientId(oauthLink.id, tokenData.client_id);
    } catch (err) {
      // Ignore if no existing token - that's expected for new sessions
      if (!(err instanceof NotFoundError)) {
        throw err;
      }
    }

    // Create the new token
    const token = await oauthTokenStorer.create(oauthLink.id, tokenData);

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
