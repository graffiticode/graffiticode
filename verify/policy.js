// Candidate checks for the policy service (deploy.json services.policy.verify).
// Denial-only by design: proves startup, the KMS key load, real Google token
// verification and the callers map, without registering a new caller. Allowed
// paths are covered by compiled-module integration tests, not here.

import { callerDenials, check, kmsPublicJwk, protectedExecutionState, request } from "./lib.js";

export default async ctx => {
  const { fetch, candidateUrl: base, headers, config, cloud, log } = ctx;

  const jwks = await request({ fetch, base, path: "/v1/jwks", headers });
  check(jwks.status === 200, `/v1/jwks: expected 200, got ${jwks.status}`);
  const expected = await kmsPublicJwk(cloud, config.env.POLICY_KMS_KEY_VERSION);
  const keys = jwks.json?.keys ?? [];
  check(keys.length === 1, `/v1/jwks: expected one key, got ${keys.length}`);
  const [key] = keys;
  check(key.kid === config.env.POLICY_KMS_KID && key.alg === "ES256" && key.use === "sig",
    `/v1/jwks: unexpected key metadata ${JSON.stringify({ kid: key.kid, alg: key.alg, use: key.use })}`);
  check(["kty", "crv", "x", "y"].every(k => key[k] === expected[k]), "/v1/jwks: key does not match the KMS public key");
  log(`  /v1/jwks: ${key.kid} matches ${config.env.POLICY_KMS_KEY_VERSION}`);

  await protectedExecutionState(ctx);
  await callerDenials(ctx, { path: "/v1/snapshot", audience: "urn:graffiticode:policy", body: {} });
  // Broker's route (W2): the same identity checks guard it.
  await callerDenials(ctx, { path: "/v1/authorize-execution", audience: "urn:graffiticode:policy", body: {} });
};
