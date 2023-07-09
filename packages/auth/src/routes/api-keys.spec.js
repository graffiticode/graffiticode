import { startAuthApp } from "../testing/app.js";

describe("routes/api-keys", () => {
  let authApp;
  let client;
  beforeEach(async () => {
    authApp = await startAuthApp();
    client = authApp.client;
  });

  afterEach(async () => {
    await authApp.cleanUp();
  });

  it("should throw error if no token is provided when calling create", async () => {
    await expect(client.apiKeys.create()).rejects.toThrow("must provide a token");
  });

  it("should return valid api key when calling create", async () => {
    const uid = "abc123";
    const { accessToken } = await authApp.authService.generateTokens({ uid });

    const { apiKey } = await client.apiKeys.create(accessToken);

    const { access_token } = await client.apiKeys.authenticate({ apiKey });
    await expect(client.verifyAccessToken(access_token)).resolves.toHaveProperty("uid", uid);
  });

  it("should return unauthorized when calling create with an api key token", async () => {
    const uid = "abc123";
    const { accessToken } = await authApp.authService.generateTokens({ uid });
    const { apiKey } = await client.apiKeys.create(accessToken);
    const { access_token: apiKeyAccessToken } = await client.apiKeys.authenticate({ apiKey });

    await expect(client.apiKeys.create(apiKeyAccessToken)).rejects.toThrow("Forbidden");
  });

  it("should remove valid api key", async () => {
    const uid = "abc123";
    const { accessToken } = await authApp.authService.generateTokens({ uid });
    const { apiKey } = await client.apiKeys.create(accessToken);

    await client.apiKeys.remove({ token: accessToken, apiKey });

    await expect(client.apiKeys.authenticate({ apiKey })).rejects.toThrow("invalid api-key");
  });

  it("should throw error if no token is provided when calling remove", async () => {
    await expect(client.apiKeys.remove({ apiKey: "foo" })).rejects.toThrow("must provide a token");
  });

  it("should throw error if no apiKey is provided when calling remove", async () => {
    await expect(client.apiKeys.remove({ token: "foo" })).rejects.toThrow("must provide a apiKey");
  });

  it("should return unauthorized when calling remove with an api key token", async () => {
    const uid = "abc123";
    const { accessToken } = await authApp.authService.generateTokens({ uid });
    const { apiKey } = await client.apiKeys.create(accessToken);
    const { access_token: apiKeyAccessToken } = await client.apiKeys.authenticate({ apiKey });

    await expect(client.apiKeys.remove({ token: apiKeyAccessToken, apiKey })).rejects.toThrow("Forbidden");
  });

  it("should return unauthorized when calling remove for another user", async () => {
    const uid = "abc123";
    const otherUid = "def456";
    const { accessToken } = await authApp.authService.generateTokens({ uid });
    const { accessToken: otherAccessToken } = await authApp.authService.generateTokens({ uid: otherUid });
    const { apiKey } = await client.apiKeys.create(accessToken);

    await expect(client.apiKeys.remove({ token: otherAccessToken, apiKey })).rejects.toThrow("Forbidden");
  });
});
