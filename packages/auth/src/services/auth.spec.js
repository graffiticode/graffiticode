import { createLocalJWKSet } from "jose";
import { createApp } from "../app.js";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildVerifyAccessToken } from "./auth.js";

describe("services/auth", () => {
  let appDeps;
  beforeEach(() => {
    appDeps = createApp();
  });

  afterEach(async () => {
    await cleanUpFirebase();
  });

  it("should propagate additional claims through the refresh token", async () => {
    const uid = "abc123";
    const additionalClaims = { foo: "bar" };
    const { refreshToken } = await appDeps.authService.generateTokens({ uid, additionalClaims });

    const accessToken = await appDeps.authService.generateAccessToken({ refreshToken });

    const certs = await appDeps.keysService.getPublicCerts();
    const JWKS = createLocalJWKSet({ keys: certs });
    const { payload } = await buildVerifyAccessToken({ JWKS })(accessToken);
    expect(payload).toHaveProperty("foo", "bar");
  });
});
