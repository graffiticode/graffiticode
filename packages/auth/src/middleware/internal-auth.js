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
