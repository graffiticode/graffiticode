// Caller (service) identity for policy and broker routes.
//
// Both services are private: Cloud Run IAM admits only invoker service
// accounts, using the Google ID token in X-Serverless-Authorization. Cloud Run
// strips that token's signature before forwarding it, so it cannot be verified
// here. The caller therefore also sends X-Caller-Identity: a Google ID token
// for its own service account, audience = this service's URN, which IS
// verified here (signature, issuer, audience, expiry, verified email). The
// caller is taken only from that token, and must match the (already
// IAM-checked) forwarded X-Serverless-Authorization email, so the two cannot
// disagree.
//
// `callers` maps a service-account email to what it may do:
//   { role: "compiler", lang: "0176" }  snapshot + mint (policy), execute (broker)
//   { role: "console" }                 intents and management routes (policy)

import { UnauthenticatedError, UnauthorizedError } from "@graffiticode/common/errors";

const decodeUnverifiedEmail = header => {
  const token = String(header || "").replace(/^Bearer\s+/i, "");
  const [, payload] = token.split(".");
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).email ?? null;
  } catch {
    return null;
  }
};

export const createCallerIdentity = ({ verifyIdToken, audience, callers, requireServerlessMatch = true }) =>
  async req => {
    const token = req.get("X-Caller-Identity");
    if (!token) throw new UnauthenticatedError("missing X-Caller-Identity");
    let claims;
    try {
      claims = await verifyIdToken(token, audience);
    } catch {
      throw new UnauthenticatedError("invalid X-Caller-Identity");
    }
    if (!claims?.email || claims.email_verified !== true) {
      throw new UnauthenticatedError("caller identity has no verified email");
    }
    const caller = Object.prototype.hasOwnProperty.call(callers, claims.email) ? callers[claims.email] : null;
    if (!caller) throw new UnauthorizedError("unknown caller");
    if (requireServerlessMatch) {
      const forwarded = decodeUnverifiedEmail(req.get("X-Serverless-Authorization"));
      if (forwarded !== claims.email) throw new UnauthorizedError("caller identity does not match invoker");
    }
    return { ...caller, email: claims.email };
  };

// Production verifier: Google-signed ID tokens only.
export const buildGoogleIdTokenVerifier = ({ OAuth2Client }) => {
  const client = new OAuth2Client();
  return async (token, audience) => {
    const ticket = await client.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    if (!["accounts.google.com", "https://accounts.google.com"].includes(payload?.iss)) {
      throw new Error("unexpected issuer");
    }
    return payload;
  };
};
