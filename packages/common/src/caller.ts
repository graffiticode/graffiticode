// Caller (service) identity for policy, broker and auth routes.
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
//   { role: "console" }                 connection management routes (policy)
//   { role: "gateway" }                 invocations and publications (policy)

import { UnauthenticatedError, UnauthorizedError, UnavailableError } from "./errors.js";

// Why a caller token failed verification, without the token or its claims:
// google-auth-library puts the token's header or payload after the first
// colon of its messages ("No pem found for envelope: {...}", "Token used too
// late, 1 > 0: {...}"), so only what comes before it is kept.
const failureDetail = (err: unknown): string =>
  String((err as Error)?.message ?? err).split(":")[0].slice(0, 120);

// Reaching Google's certificates failed: a network error or a 5xx while
// fetching them. That isn't the caller's fault, and a retry may succeed.
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
const verifierUnavailable = (err: unknown): boolean => {
  const e = err as { code?: unknown; response?: { status?: unknown }; message?: unknown; cause?: { code?: unknown } };
  const status = e?.response?.status;
  return NETWORK_CODES.has(String(e?.code)) || NETWORK_CODES.has(String(e?.cause?.code)) ||
    (typeof status === "number" && status >= 500) ||
    /fetch failed|socket hang up|request to https:\/\/www\.googleapis\.com\/oauth2/i.test(String(e?.message));
};

// One line per refused caller (stderr, so Cloud Logging keeps it beside the
// request). Before 2026-10-27 these refusals left no trace but the 401.
const logRefusal = (log: (line: string) => void, fields: Record<string, unknown>) =>
  log(JSON.stringify({ event: "caller-identity", outcome: "refused", ...fields }));

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

export const createCallerIdentity = ({ verifyIdToken, audience, callers, requireServerlessMatch = true, log = line => console.warn(line) }) =>
  async req => {
    const forwardedEmail = () => decodeUnverifiedEmail(req.get("X-Serverless-Authorization"));
    const token = req.get("X-Caller-Identity");
    if (!token) {
      logRefusal(log, { reason: "missing", invoker: forwardedEmail() });
      throw new UnauthenticatedError("missing X-Caller-Identity");
    }
    let claims;
    try {
      claims = await verifyIdToken(token, audience);
    } catch (err) {
      const unavailable = verifierUnavailable(err);
      logRefusal(log, { reason: unavailable ? "verifier-unavailable" : "invalid", detail: failureDetail(err), invoker: forwardedEmail() });
      // The caller's token may be fine: say so, so it can retry.
      if (unavailable) throw new UnavailableError("caller identity could not be verified; retry");
      throw new UnauthenticatedError("invalid X-Caller-Identity");
    }
    if (!claims?.email || claims.email_verified !== true) {
      logRefusal(log, { reason: "no-verified-email", invoker: forwardedEmail() });
      throw new UnauthenticatedError("caller identity has no verified email");
    }
    const caller = Object.prototype.hasOwnProperty.call(callers, claims.email) ? callers[claims.email] : null;
    if (!caller) throw new UnauthorizedError("unknown caller");
    if (requireServerlessMatch) {
      const forwarded = forwardedEmail();
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
