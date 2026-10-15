// A system preview session's signature allowance (the system-preview rate
// limits plan, design point 3). Policy's sessions are stateless JWTs, so the
// count lives here, where every execution is already claimed atomically:
// before a system-session `sign` executes, Broker claims one of the session's
// SYSTEM_SESSION_MAX_SIGNINGS slots (stores.js `slots`), and with every slot
// taken refuses `session-exhausted` before any signing.
//
// Retention: a slot must outlive every execution token its session can
// produce, or a cleaned-up slot could be claimed again. Tokens are minted only
// while the session is valid (Policy verifies it at mint), and each lives at
// most the execution profile's maximum lifetime after it is minted, so the
// last one expires by sexp + PROFILES.execution.maxTtlSeconds. Each slot
// expires (cleanup-only TTL) SLOT_RETENTION_MARGIN_S after that.
//
// `sexp` is the session's expiry, signed into every token Policy mints under
// a system session. A system-session token without it isn't valid under this
// contract: `bad-token`.

import { PROFILES, parsePositiveInt } from "@graffiticode/policy";

export const DEFAULT_SYSTEM_SESSION_MAX_SIGNINGS = 4;
export const SLOT_RETENTION_MARGIN_S = 300;
// The longest an execution token lives after it's minted (60 s).
export const MAX_EXECUTION_TOKEN_LIFETIME_S = PROFILES.execution.maxTtlSeconds;

// SYSTEM_SESSION_MAX_SIGNINGS: 1 to 100, default 4.
export const parseSystemSessionMaxSignings = env =>
  parsePositiveInt(env, "SYSTEM_SESSION_MAX_SIGNINGS", DEFAULT_SYSTEM_SESSION_MAX_SIGNINGS, 100);

// When a slot of the session expiring at `sexp` (epoch s) may be cleaned up
// (epoch ms).
export const slotExpiresAt = (sexp: number) => (sexp + MAX_EXECUTION_TOKEN_LIFETIME_S + SLOT_RETENTION_MARGIN_S) * 1000;

// A session id that can name a slot document (Policy's are UUIDs).
const SID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

// Is this verified token's system-session claim set well formed? A system
// token needs `sexp`, a whole number of seconds after the token was issued
// (the session was still valid when it was minted) and no later than a
// session can last, and a `sid` that names slots. Other provenances aren't
// checked here.
export const systemSessionClaimsValid = (claims): boolean => {
  if (claims.prv !== "system") return true;
  const { sexp, iat, sid } = claims;
  if (!Number.isSafeInteger(sexp) || typeof iat !== "number") return false;
  if (sexp < iat || sexp > iat + PROFILES.session.maxTtlSeconds) return false;
  return typeof sid === "string" && SID_RE.test(sid);
};
