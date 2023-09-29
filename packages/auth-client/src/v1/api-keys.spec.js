import { startAuthApp } from "@graffiticode/auth/testing";
import { InvalidArgumentError, UnauthenticatedError } from "@graffiticode/common/errors";
import { createClient } from "./index.js";

const uid = "abc123";
const otherUid = "def456";

describe("api-keys", () => {
  let authApp;
  let client;

  beforeEach(async () => {
    authApp = await startAuthApp();
    client = createClient({ url: authApp.url });
  });

  afterEach(async () => {
    await authApp.cleanUp();
  });

  describe("create", () => {
    it("should return invalid argument if no accessToken is provided", async () => {
      await expect(client.createApiKey())
        .rejects.toThrow(InvalidArgumentError, "must provide an accessToken");
    });

    it("should return valid api key for valid accessToken", async () => {
      const { accessToken } = await authApp.authService.generateTokens({ uid });

      const apiKey = await client.createApiKey({ accessToken });

      expect(apiKey).toHaveProperty("id");
      expect(apiKey).toHaveProperty("token");
      const authContext = await authApp.apiKeyService.authenticateWithId(apiKey);
      expect(authContext).toHaveProperty("uid", uid);
      expect(authContext).toHaveProperty("additionalClaims.apiKey", true);
      expect(authContext).toHaveProperty("additionalClaims.apiKeyId", apiKey.id);
    });

    it("should use accessToken from context", async () => {
      const { accessToken } = await authApp.authService.generateTokens({ uid });
      client._context.set("accessToken", accessToken);

      const apiKey = await client.createApiKey();

      expect(apiKey).toHaveProperty("id");
      expect(apiKey).toHaveProperty("token");
      const authContext = await authApp.apiKeyService.authenticateWithId(apiKey);
      expect(authContext).toHaveProperty("uid", uid);
      expect(authContext).toHaveProperty("additionalClaims.apiKey", true);
      expect(authContext).toHaveProperty("additionalClaims.apiKeyId", apiKey.id);
    });
  });

  describe("delete", () => {
    it("should return invalid argument if no accessToken is provided", async () => {
      await expect(client.deleteApiKey())
        .rejects.toThrow(InvalidArgumentError, "must provide an accessToken");
    });

    it("should return invalid argument if no apiKeyId is provided", async () => {
      const { accessToken } = await authApp.authService.generateTokens({ uid });

      await expect(client.deleteApiKey({ accessToken }))
        .rejects.toThrow(InvalidArgumentError, "must provide an apiKeyId");
    });

    it("should return unauthorized if access token is derived from an API Key", async () => {
      const { id, token } = await authApp.apiKeyService.create({ uid });
      const authContext = await authApp.apiKeyService.authenticateWithId({ id, token });
      const accessToken = await authApp.authService.createAccessToken(authContext);

      await expect(client.deleteApiKey({ accessToken, apiKeyId: id }))
        .rejects.toThrow("Forbidden");
    });

    it("should return not found for non-exist api key", async () => {
      const { accessToken } = await authApp.authService.generateTokens({ uid });

      await expect(client.deleteApiKey({ accessToken, apiKeyId: "does-not-exist" }))
        .rejects.toThrow("Not Found");
    });

    it("should return unauthorized if API key was created by another user", async () => {
      const { id } = await authApp.apiKeyService.create({ uid });
      const { accessToken } = await authApp.authService.generateTokens({ uid: otherUid });

      await expect(client.deleteApiKey({ accessToken, apiKeyId: id }))
        .rejects.toThrow("Forbidden");
    });

    it("should delete API key with valid access token", async () => {
      const { id, token } = await authApp.apiKeyService.create({ uid });
      const { accessToken } = await authApp.authService.generateTokens({ uid });

      await expect(client.deleteApiKey({ accessToken, apiKeyId: id })).resolves.toBe();

      // Should not be able to authenticate with the API Key after it has been deleted
      await expect(authApp.apiKeyService.authenticateWithId({ id, token }))
        .rejects.toThrow(UnauthenticatedError);
    });
  });

  describe("signInWithApiKey", () => {
    it("should return invalid argument for missing api key id", async () => {
      const { token: apiKeySecret } = await authApp.apiKeyService.create({ uid });

      await expect(client.signInWithApiKey({ apiKeySecret }))
        .rejects.toThrow("must provide an apiKeyId");
    });

    it("should return invalid argument for missing api key secret", async () => {
      const { id: apiKeyId } = await authApp.apiKeyService.create({ uid });

      await expect(client.signInWithApiKey({ apiKeyId }))
        .rejects.toThrow("must provide an apiKeySecret");
    });

    it("should return unauthenticated for non existant api key id", async () => {
      const { token: apiKeySecret } = await authApp.apiKeyService.create({ uid });

      await expect(client.signInWithApiKey({ apiKeyId: "does-not-exist", apiKeySecret }))
        .rejects.toThrow();
    });

    it("should return unauthenticated for incorrect api key secret", async () => {
      const { id: apiKeyId } = await authApp.apiKeyService.create({ uid });

      await expect(client.signInWithApiKey({ apiKeyId, apiKeySecret: "api-key-secret-does-not-match" }))
        .rejects.toThrow();
    });

    it("should return access token for valid api key", async () => {
      const { id: apiKeyId, token: apiKeySecret } = await authApp.apiKeyService.create({ uid });

      const { accessToken } = await client.signInWithApiKey({ apiKeyId, apiKeySecret });

      const accessTokenAuthContext = await authApp.authService.verifyToken({ token: accessToken });
      expect(accessTokenAuthContext).toHaveProperty("uid", uid);
      expect(accessTokenAuthContext).toHaveProperty("apiKey", true);
    });
  });
});
