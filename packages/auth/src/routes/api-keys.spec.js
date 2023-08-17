import { startAuthApp } from "../testing/app.js";
import { signInAndGetIdToken } from "../testing/firebase.js";

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

    const { token } = await client.apiKeys.create(accessToken);

    const { firebaseCustomToken } = await client.apiKeys.authenticate({ token });
    const apiKeyAccessToken = await signInAndGetIdToken(firebaseCustomToken);
    await expect(client.verifyToken(apiKeyAccessToken)).resolves.toHaveProperty("uid", uid);
  });

  it("should return unauthorized when calling create with an api key token", async () => {
    const uid = "abc123";
    const { accessToken } = await authApp.authService.generateTokens({ uid });
    const { token } = await client.apiKeys.create(accessToken);
    const { firebaseCustomToken } = await client.apiKeys.authenticate({ token });
    const apiKeyAccessToken = await signInAndGetIdToken(firebaseCustomToken);

    await expect(client.apiKeys.create(apiKeyAccessToken)).rejects.toThrow("Forbidden");
  });

  it("should remove valid api key", async () => {
    const uid = "abc123";
    const { accessToken } = await authApp.authService.generateTokens({ uid });
    const { id, token } = await client.apiKeys.create(accessToken);

    await client.apiKeys.remove({ token: accessToken, id });

    await expect(client.apiKeys.authenticate({ token })).rejects.toThrow("invalid api-key");
  });

  it("should throw error if no token is provided when calling remove", async () => {
    await expect(client.apiKeys.remove({ apiKey: "foo" })).rejects.toThrow("must provide a token");
  });

  it("should throw error if no id is provided when calling remove", async () => {
    await expect(client.apiKeys.remove({ token: "foo" })).rejects.toThrow("must provide an id");
  });

  it("should return unauthorized when calling remove with an api key token", async () => {
    const uid = "abc123";
    const { accessToken } = await authApp.authService.generateTokens({ uid });
    const { id, token } = await client.apiKeys.create(accessToken);
    const { firebaseCustomToken } = await client.apiKeys.authenticate({ token });
    const apiKeyAccessToken = await signInAndGetIdToken(firebaseCustomToken);

    await expect(client.apiKeys.remove({ token: apiKeyAccessToken, id })).rejects.toThrow("Forbidden");
  });

  it("should return unauthorized when calling remove for another user", async () => {
    const uid = "abc123";
    const otherUid = "def456";
    const { accessToken } = await authApp.authService.generateTokens({ uid });
    const { accessToken: otherAccessToken } = await authApp.authService.generateTokens({ uid: otherUid });
    const { id } = await client.apiKeys.create(accessToken);

    await expect(client.apiKeys.remove({ token: otherAccessToken, id })).rejects.toThrow("Forbidden");
  });
});
