// The token profiles the policy authority issues (RFC 8725). They share a
// signing key but never a validation profile: each has its own `typ`, audience
// and lifetime, the algorithm is fixed, and the issuer is fixed. A session
// token presented to the broker, or an execution or session token presented
// as an intent, fails verification rather than being read as another kind.
//
//   intent    aud=policy  typ=gc-intent+jwt   30 min   a user's deliberate save or
//                                                      authoring action, issued to
//                                                      the console (entry point)
//   session   aud=policy  typ=gc-session+jwt  ~15 min  one compile's admission
//   execution aud=broker  typ=gc-exec+jwt     <=60 s   one broker operation

import { SignJWT, jwtVerify, importJWK, createLocalJWKSet } from "jose";
import { randomUUID } from "node:crypto";

export const ISSUER = "urn:graffiticode:policy";
export const ALG = "ES256";

export const PROFILES = Object.freeze({
  // Long enough to cover a Cloud Tasks job and its re-dispatches (900 s
  // deadline), so a retried save keeps its save-action id.
  intent: Object.freeze({ typ: "gc-intent+jwt", audience: "urn:graffiticode:policy", ttlSeconds: 30 * 60 }),
  session: Object.freeze({ typ: "gc-session+jwt", audience: "urn:graffiticode:policy", ttlSeconds: 15 * 60 }),
  execution: Object.freeze({ typ: "gc-exec+jwt", audience: "urn:graffiticode:broker", ttlSeconds: 60 }),
});

// A signer holds the private key; verification needs only the public JWKS.
// (Production signs through Cloud KMS; this local signer is for tests and
// local development.)
export const createLocalSigner = async ({ privateJwk, kid }) => {
  const key = await importJWK(privateJwk, ALG);
  return {
    kid,
    sign: (claims, { typ, audience, ttlSeconds }) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: ALG, kid, typ })
        .setIssuer(ISSUER)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .setJti(randomUUID())
        .sign(key),
  };
};

export const issueToken = (signer, profileName, claims) => {
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new Error(`unknown token profile ${profileName}`);
  }
  return signer.sign(claims, profile);
};

// Verifies with the profile's fixed algorithm, issuer, audience and `typ`.
// Expiry is checked here, independently of any storage TTL.
export const verifyToken = async (jwks, profileName, token) => {
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new Error(`unknown token profile ${profileName}`);
  }
  const keySet = typeof jwks === "function" ? jwks : createLocalJWKSet(jwks);
  const { payload, protectedHeader } = await jwtVerify(token, keySet, {
    algorithms: [ALG],
    issuer: ISSUER,
    audience: profile.audience,
    typ: profile.typ,
  });
  if (typeof payload.jti !== "string" || typeof payload.exp !== "number") {
    throw new Error("token is missing jti or exp");
  }
  return { claims: payload, header: protectedHeader };
};
