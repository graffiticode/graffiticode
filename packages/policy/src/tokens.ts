// The token profiles the policy authority issues (RFC 8725). They share a
// signing key but never a validation profile: each has its own `typ`, audience
// and lifetime, the algorithm is fixed, and the issuer is fixed. A session
// token presented to the broker, or an execution or session token presented
// as an invocation, fails verification rather than being read as another kind.
//
//   invocation aud=policy typ=gc-invocation+jwt 30 min one logical invocation,
//                                                      issued to the gateway
//   session   aud=policy  typ=gc-session+jwt  ~15 min  one compile's admission
//   execution aud=broker  typ=gc-exec+jwt     <=60 s   one broker operation
//   admission aud=policy  typ=gc-admission+jwt 15 min  one admitted plan,
//                                                      held by the gateway and
//                                                      presented at each snapshot
//
// PROFILES is the one schema both issuance (every signer) and verification
// use (spec TOKEN-01): `typ`, audience, issued and maximum lifetime, and the
// claims each profile must carry. Claims a later release requires (execution
// provenance, admission plans) join their profile with that release.

import { SignJWT, jwtVerify, importJWK, createLocalJWKSet, decodeProtectedHeader } from "jose";
import { randomUUID } from "node:crypto";

export const ISSUER = "urn:graffiticode:policy";
export const ALG = "ES256";

// How far ahead of the verifier's clock an `iat` may be. Signers and verifiers
// run on different machines.
export const CLOCK_SKEW_SECONDS = 10;

// Every profile's registered claims, set by issuance and never by a caller.
export const RESERVED_CLAIMS = Object.freeze(["iss", "aud", "iat", "exp", "nbf", "jti"]);

const STRING = "string";
const NUMBER = "number";
const BOOLEAN = "boolean";
const STRINGS = "string[]";
const OBJECT = "object";

const CHECKS = {
  [STRING]: v => typeof v === "string" && v.length > 0,
  [NUMBER]: v => typeof v === "number" && Number.isFinite(v),
  [BOOLEAN]: v => typeof v === "boolean",
  [STRINGS]: v => Array.isArray(v) && v.every(s => typeof s === "string"),
  [OBJECT]: v => v !== null && typeof v === "object" && !Array.isArray(v),
};
const isType = (value, type) => CHECKS[type](value);

const profile = ({ typ, audience, ttlSeconds, required, optional = {} }) => Object.freeze({
  typ,
  audience,
  ttlSeconds,
  maxTtlSeconds: ttlSeconds,
  required: Object.freeze(required),
  optional: Object.freeze(optional),
});

export const PROFILES = Object.freeze({
  // A retry past expiry sends its idempotency key again and gets the same
  // invocation in a fresh token.
  invocation: profile({
    typ: "gc-invocation+jwt",
    audience: "urn:graffiticode:policy",
    ttlSeconds: 30 * 60,
    required: { sub: STRING, conn: STRING, inv: STRING, seq: NUMBER },
    optional: { pub: STRING, cv: NUMBER },
  }),
  session: profile({
    typ: "gc-session+jwt",
    audience: "urn:graffiticode:policy",
    ttlSeconds: 15 * 60,
    required: { sub: STRING, own: STRING, conn: STRING, backend: STRING, lang: STRING, inv: STRING, stg: STRING, rv: NUMBER, fns: STRINGS },
    // Contract v2 (W4): `cv` on every session; a user session bound to an
    // admitted plan adds `pld` (its digest) and `bind` (its stage).
    optional: { pub: STRING, sys: BOOLEAN, cv: NUMBER, pld: STRING, bind: OBJECT },
  }),
  execution: profile({
    typ: "gc-exec+jwt",
    audience: "urn:graffiticode:broker",
    ttlSeconds: 60,
    // `prv` (provenance.js) is required with Broker relying on it (W2): a token
    // from a Policy that predates it is refused, and the caller mints a fresh
    // one for the same operation. `pub` names a publication's.
    required: { sub: STRING, own: STRING, conn: STRING, backend: STRING, lang: STRING, fn: STRING, op: STRING, sid: STRING, opid: STRING, argd: STRING, rv: NUMBER, prv: STRING },
    // Contract v2 (W4): `cv`, and for user provenance the plan (`pld`) and
    // stage (`stg`) its session was bound to.
    optional: { pub: STRING, cv: NUMBER, pld: STRING, stg: STRING },
  }),
  // One admitted plan for one invocation (W4): issued to the gateway by
  // admission, and presented with each stage's snapshot. Policy's audience.
  admission: profile({
    typ: "gc-admission+jwt",
    audience: "urn:graffiticode:policy",
    ttlSeconds: 15 * 60,
    required: { sub: STRING, conn: STRING, inv: STRING, pld: STRING, cv: NUMBER },
  }),
});

const profileNamed = name => {
  const found = Object.prototype.hasOwnProperty.call(PROFILES, name) ? PROFILES[name] : null;
  if (!found) throw new Error(`unknown token profile ${name}`);
  return found;
};

// The claims a profile requires are present with the right types, and its
// optional ones, when present, too.
const checkProfileClaims = (prof, claims) => {
  for (const [name, type] of Object.entries(prof.required)) {
    if (!isType(claims[name], type)) throw new Error(`token claim ${name} is missing or not a ${type}`);
  }
  for (const [name, type] of Object.entries(prof.optional)) {
    if (claims[name] !== undefined && !isType(claims[name], type)) throw new Error(`token claim ${name} is not a ${type}`);
  }
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

// The protected header and payload of a token, built the same way by every
// signer so that the local and KMS signers issue identical tokens for the same
// input.
export const tokenParts = ({ claims, profile: prof, kid, now, jti }) => {
  if (typeof kid !== "string" || kid === "") throw new Error("signer has no kid");
  const reserved = RESERVED_CLAIMS.filter(c => Object.prototype.hasOwnProperty.call(claims, c));
  if (reserved.length) throw new Error(`claims may not set ${reserved.join(", ")}`);
  checkProfileClaims(prof, claims);
  if (!(prof.ttlSeconds > 0 && prof.ttlSeconds <= prof.maxTtlSeconds)) throw new Error("token lifetime exceeds its profile");
  const header = { alg: ALG, kid, typ: prof.typ };
  const payload = { ...claims, iss: ISSUER, aud: prof.audience, iat: now, exp: now + prof.ttlSeconds, jti };
  return { header, payload };
};

// A signer holds the private key; verification needs only the public JWKS.
// (Production signs through Cloud KMS; this local signer is for tests and
// local development.) `now` and `newJti` are injectable so that signers can be
// compared.
export const createLocalSigner = async ({ privateJwk, kid, now = nowSeconds, newJti = () => String(randomUUID()) }) => {
  const key = await importJWK(privateJwk, ALG);
  return {
    kid,
    sign: async (claims, prof) => {
      const { header, payload } = tokenParts({ claims, profile: prof, kid, now: now(), jti: newJti() });
      return new SignJWT(payload).setProtectedHeader(header).sign(key);
    },
  };
};

export const issueToken = async (signer, profileName, claims) => signer.sign(claims, profileNamed(profileName));

// Verifies with the profile's fixed algorithm, issuer, audience and `typ`,
// then everything else the profile requires: a key id the JWKS names, a token
// id, an issued-at time not in the future, an expiry no further from it than
// the profile's maximum lifetime, and the profile's claims. Expiry is checked
// here, independently of any storage TTL.
export const verifyToken = async (jwks, profileName, token, options: { currentDate?: Date } = {}) => {
  const { currentDate } = options;
  const prof = profileNamed(profileName);
  let kid;
  try {
    ({ kid } = decodeProtectedHeader(token));
  } catch {
    throw new Error("token header is malformed");
  }
  if (typeof kid !== "string" || kid === "") throw new Error("token has no kid");
  if (typeof jwks !== "function" && !(jwks.keys || []).some(k => k.kid === kid)) {
    throw new Error("token kid is not in the key set");
  }
  const keySet = typeof jwks === "function" ? jwks : createLocalJWKSet(jwks);
  const { payload, protectedHeader } = await jwtVerify(token, keySet, {
    algorithms: [ALG],
    issuer: ISSUER,
    audience: prof.audience,
    typ: prof.typ,
    requiredClaims: ["iat", "exp", "jti"],
    currentDate,
  });
  const now = Math.floor((currentDate ?? new Date()).getTime() / 1000);
  if (typeof payload.jti !== "string" || payload.jti === "") throw new Error("token jti is missing");
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number") throw new Error("token is missing iat or exp");
  if (payload.iat > now + CLOCK_SKEW_SECONDS) throw new Error("token iat is in the future");
  if (payload.exp <= payload.iat || payload.exp - payload.iat > prof.maxTtlSeconds) {
    throw new Error("token lifetime exceeds its profile");
  }
  checkProfileClaims(prof, payload);
  return { claims: payload, header: protectedHeader };
};
