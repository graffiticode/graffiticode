import { NotFoundError } from "@graffiticode/common/errors";

/**
 * Service module for OAuth token management.
 *
 * Provides business logic for creating, retrieving, updating, and rotating
 * OAuth tokens stored in Firestore.
 */

// `checkUnfenced` (storage/oauth-migration.js) refuses every write early once
// the OAuth store is fenced for the migration, so a fenced store answers
// migration_fenced whether or not the token exists; the storers refuse
// atomically either way.
export const buildOAuthTokensService = ({ oauthLinkStorer, oauthTokenStorer, checkUnfenced = async () => {} }) => {
  /**
   * Create or update a token for a given provider ID and client.
   * If a token already exists for this client, it will be replaced.
   *
   * Auto-creates an oauth-link if one doesn't exist for the provider ID.
   */
  const createToken = async ({ providerId, email, tokenData }) => {
    // Refused once fenced (the storer refuses too, atomically); checked first
    // so a refused write leaves no link behind either.
    await checkUnfenced();
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
    await checkUnfenced();
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
    await checkUnfenced();
    const existingToken = await oauthTokenStorer.findByAccessToken(accessToken);
    if (!existingToken) {
      throw new NotFoundError("Token not found");
    }

    await oauthTokenStorer.remove(existingToken.link_id, existingToken.id);
  };

  /**
   * Rotate tokens (OAuth 2.1 refresh flow): the old token is replaced by the
   * new one in one transaction.
   */
  const rotateTokens = async (oldRefreshToken, newTokenData) => {
    await checkUnfenced();
    return oauthTokenStorer.rotate(oldRefreshToken, newTokenData);
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
