import { UnauthenticatedError } from "@graffiticode/common/errors";
import { createLocalJWKSet } from "jose";
import { createApp } from "../app.js";
import { cleanUpFirebase, signInAndGetIdToken } from "../testing/firebase.js";
import { buildAuthService, buildVerifyAccessToken } from "./auth.js";

const uid = "abc123";

describe("services/auth", () => {
  let appDeps;
  beforeEach(() => {
    appDeps = createApp();
  });

  afterEach(async () => {
    await cleanUpFirebase();
  });

  it("should propagate additional claims through the refresh token", async () => {
    const additionalClaims = { foo: "bar" };
    const { refreshToken } = await appDeps.authService.generateTokens({ uid, additionalClaims });

    const accessToken = await appDeps.authService.generateAccessToken({ refreshToken });

    const certs = await appDeps.keysService.getPublicCerts();
    const JWKS = createLocalJWKSet({ keys: certs });
    const { payload } = await buildVerifyAccessToken({ JWKS })(accessToken);
    expect(payload).toHaveProperty("foo", "bar");
  });

  describe("verifyToken", () => {
    it("should return auth context for accessToken", async () => {
      const token = await appDeps.authService.createAccessToken({ uid });

      const authContext = await appDeps.authService.verifyToken({ token });

      expect(authContext).toHaveProperty("uid", uid);
    });

    it("should return auth context for firebaseCustomToken", async () => {
      const customToken = await appDeps.authService.createFirebaseCustomToken({ uid });
      const token = await signInAndGetIdToken(customToken);

      const authContext = await appDeps.authService.verifyToken({ token });

      expect(authContext).toHaveProperty("uid", uid);
    });

    it("should throw Unauthenticated for invalid access token", async () => {
      let token = await appDeps.authService.createAccessToken({ uid });
      token = [...token.split(".").slice(0, 2), "not-a-valid-signature"].join(".");

      await expect(appDeps.authService.verifyToken({ token })).rejects.toThrow(UnauthenticatedError);
    });

    // Firebase's verdict on the token itself is the client's problem (401);
    // anything else is still a server error.
    const failingFirebase = code => buildAuthService({
      firebaseAuth: { verifyIdToken: async () => { throw Object.assign(new Error(code), { code }); } },
      refreshTokenStorer: {},
      keysService: appDeps.keysService
    });

    it.each(["auth/id-token-expired", "auth/id-token-revoked", "auth/user-disabled"])(
      "should throw Unauthenticated when Firebase reports %s", async code => {
        await expect(failingFirebase(code).verifyToken({ token: "t" })).rejects.toThrow(UnauthenticatedError);
      });

    it("should rethrow other Firebase failures", async () => {
      const promise = failingFirebase("auth/internal-error").verifyToken({ token: "t" });
      await expect(promise).rejects.toMatchObject({ code: "auth/internal-error" });
      await expect(promise).rejects.not.toBeInstanceOf(UnauthenticatedError);
    });
  });
});
