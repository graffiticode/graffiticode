import { createLocalJWKSet } from "jose";
import { createStorers } from "../storage/index.js";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildVerifyAccessToken } from "./auth.js";
import { createServices } from "./index.js";

describe("services/auth", () => {
  let services;

  beforeEach(() => {
    const storers = createStorers();
    services = createServices(storers);
  });

  afterEach(async () => {
    await cleanUpFirebase();
  });

  it("should propagate additional claims through the refresh token", async () => {
    const uid = "abc123";
    const additionalClaims = { foo: "bar" };
    const { refreshToken } = await services.authService.generateTokens({ uid, additionalClaims });

    const accessToken = await services.authService.generateAccessToken({ refreshToken });

    const certs = await services.keysService.getPublicCerts();
    const JWKS = createLocalJWKSet({ keys: certs });
    const { payload } = await buildVerifyAccessToken({ JWKS })(accessToken);
    expect(payload).toHaveProperty("foo", "bar");
  });
});
