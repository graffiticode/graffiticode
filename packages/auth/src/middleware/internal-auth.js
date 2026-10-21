import { timingSafeEqual } from "node:crypto";
import { UnauthorizedError } from "@graffiticode/common/errors";

/**
 * Middleware to authenticate internal service-to-service requests.
 * Checks for X-Internal-API-Key header matching INTERNAL_API_KEY env var.
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

  if (!apiKey || apiKey !== expectedKey) {
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
