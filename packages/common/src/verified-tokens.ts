// Successful user-token verifications, remembered briefly (Policy and api).
//
// Every request through Policy or the gateway asks the auth service
// (/oauth/verify) about its user token, and one compile asks about the same
// token many times. When auth adds an instance, a request routed to it waits
// out a cold start: on 2026-10-27 a verify took 21 s, and an execution token
// minted before it expired on the way to Broker. Remembering a token that
// verified for a short time takes most of those calls off auth.
//
// The trade: a token auth would now refuse (revoked) keeps working here for
// at most `ttlMs` after it last verified, and never past its own `exp`.
// Refusals are never remembered, so a token that failed (or met an
// unreachable auth) is always asked again. Entries are keyed by the token's
// SHA-256, never the token itself.

import { createHash } from "node:crypto";

type Verify<T> = (token: string) => Promise<T>;

// The token's own expiry, in ms, when it is a JWT that carries one. Read only
// after auth verified the token, so its payload is auth's.
const expiresAt = (token: string): number => {
  try {
    const exp = JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8"))?.exp;
    return typeof exp === "number" ? exp * 1000 : Infinity;
  } catch {
    return Infinity;
  }
};

export const cacheVerifications = <T>(verify: Verify<T>, { ttlMs = 60_000, max = 10_000, now = () => Date.now() }: { ttlMs?: number, max?: number, now?: () => number } = {}): Verify<T> => {
  const remembered = new Map<string, { value: T, until: number }>();
  return async token => {
    const key = createHash("sha256").update(String(token)).digest("base64url");
    const hit = remembered.get(key);
    if (hit && hit.until > now()) return hit.value;
    remembered.delete(key);
    const value = await verify(token);
    const until = Math.min(now() + ttlMs, expiresAt(token));
    if (until > now()) {
      // Oldest first (a Map keeps insertion order).
      while (remembered.size >= max) remembered.delete(remembered.keys().next().value as string);
      remembered.set(key, { value, until });
    }
    return value;
  };
};
