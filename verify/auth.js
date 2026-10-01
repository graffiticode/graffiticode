// Candidate checks for the auth service (deploy.json services.auth.verify).
//
// Exchanges the dedicated verification account's API key (Secret Manager
// `verify-api-key`, read with the deployer's credentials) on the candidate and
// checks the access token it mints validates there as that account. That
// account holds no connections, so the key can never act externally. Refresh is
// not checked here: API-key login issues no refresh token; the refresh flow is
// covered by the auth emulator suites.

import { check, expectError, request } from "./lib.js";

export const VERIFY_UID = "a35c2c8948de39fd03bb60d9d44259612dc56470";

// The verification account's API key, read with the deployer's credentials.
export const readVerifyApiKey = async cloud => {
  const key = String(await cloud(["secrets", "versions", "access", "latest", "--secret=verify-api-key"], { json: false })).trim();
  check(key.length > 0, "verify-api-key is empty");
  return key;
};

// Exchange the key on `base` and return an access token for VERIFY_UID.
export const accessTokenFor = async ({ fetch, cloud, base }) => {
  const token = await readVerifyApiKey(cloud);
  const res = await request({ fetch, base, path: "/authenticate/api-key", method: "POST", body: { token } });
  check(res.status === 200 && res.json?.status === "success", `/authenticate/api-key: expected 200 success, got ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
  const { accessToken, firebaseCustomToken } = res.json.data ?? {};
  check(typeof accessToken === "string" && accessToken.split(".").length === 3, "/authenticate/api-key: no access token");
  check(typeof firebaseCustomToken === "string" && firebaseCustomToken.length > 0, "/authenticate/api-key: no firebase custom token");
  return accessToken;
};

export default async ctx => {
  const { fetch, candidateUrl: base, cloud, log } = ctx;

  const accessToken = await accessTokenFor({ fetch, cloud, base });
  const verified = await request({ fetch, base, path: "/oauth/verify", method: "POST", body: { idToken: accessToken } });
  check(verified.status === 200 && verified.json?.data?.uid === VERIFY_UID,
    `/oauth/verify: expected uid ${VERIFY_UID}, got ${verified.status} ${JSON.stringify(verified.json?.data?.uid ?? verified.json?.error ?? null)}`);
  log(`  /authenticate/api-key + /oauth/verify: access token validates as ${VERIFY_UID}`);

  expectError("/authenticate/api-key with a malformed key",
    await request({ fetch, base, path: "/authenticate/api-key", method: "POST", body: { token: "not-a-real-key" } }), 401, "invalid api-key");
  expectError("/authenticate/api-key without a key",
    await request({ fetch, base, path: "/authenticate/api-key", method: "POST", body: {} }), 400, "must provide a token");
  log("  /authenticate/api-key: 401 for a malformed key, 400 without one");
};
