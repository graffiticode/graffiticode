import { createHash, timingSafeEqual } from "node:crypto";
import { UnauthorizedError } from "@graffiticode/common/errors";

// Constant-time equality for keys of any length: compare digests, which are always 32 bytes, so neither the
// length nor the first differing byte of a wrong key shows in the timing.
const digest = value => createHash("sha256").update(String(value)).digest();
const sameKey = (given, expected) => timingSafeEqual(digest(given), digest(expected));

/**
 * Middleware to authenticate internal service-to-service requests.
 * Checks for X-Internal-API-Key header matching INTERNAL_API_KEY env var.
 *
 * Rotation (2026-10-24): INTERNAL_API_KEY_PREVIOUS, when set, is accepted too, so the key can be rotated
 * without an outage: auth first holds the new key as current and the old one as previous, the senders
 * (console, app, mcp-service) move to the new key, then auth drops the previous one and the old key is
 * refused. An unset current key still fails closed (500); an unset or empty previous key is ignored.
 */
export const requireInternalAuth = (req, res, next) => {
  const apiKey = req.headers["x-internal-api-key"];
  const expectedKey = process.env.INTERNAL_API_KEY;

  if (!expectedKey) {
    console.error("INTERNAL_API_KEY not configured");
    return res.status(500).json({
      status: "error",
      error: { message: "Internal API key not configured" },
    });
  }

  const accepted = [expectedKey, process.env.INTERNAL_API_KEY_PREVIOUS].filter(Boolean);
  // Every accepted key is compared, not just until the first match, so which one matched doesn't show either.
  const matched = apiKey ? accepted.map(key => sameKey(apiKey, key)).includes(true) : false;
  if (!matched) {
    throw new UnauthorizedError("Invalid internal API key");
  }

  next();
};

/**
 * The refresh-token cleanup's own key (2026-10-21). The scheduled cleanup job holds only this
 * one, which no other route accepts, so it can't reach auth's other internal routes
 * (linked-emails internal/sign-in, oauth-clients, oauth-tokens). A request carrying
 * X-Cleanup-API-Key must match CLEANUP_API_KEY; one without it falls back to the internal key.
 */
export const requireCleanupAuth = (req, res, next) => {
  const apiKey = req.headers["x-cleanup-api-key"];
  if (apiKey === undefined) return requireInternalAuth(req, res, next);
  const expectedKey = process.env.CLEANUP_API_KEY;
  if (!expectedKey) {
    console.error("CLEANUP_API_KEY not configured");
    return res.status(500).json({
      status: "error",
      error: { message: "Cleanup API key not configured" },
    });
  }
  const given = Buffer.from(String(apiKey));
  const expected = Buffer.from(expectedKey);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new UnauthorizedError("Invalid cleanup API key");
  }
  next();
};
