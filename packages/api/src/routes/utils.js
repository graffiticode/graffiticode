import { categoryForStatus, classify } from "@graffiticode/common/failures";
import { isNonEmptyString } from "../util.js";
import { HttpError, InvalidArgumentError } from "./../errors/http.js";

const normalizeIds = ids => ids.map(id => id.split(/[ ]/g).join("+"));

export const parseIdsFromRequest = req => {
  const id = req.query.id;
  if (isNonEmptyString(id)) {
    return normalizeIds(id.split(","));
  }
  return [];
};

export const parseOriginFromRequest = req => {
  return req.query.origin;
};

export const parseAuthTokenFromRequest = req => {
  const { access_token: queryAccessToken } = req.query;
  if (isNonEmptyString(queryAccessToken)) {
    return queryAccessToken;
  }
  let headerAuthToken = req.get("Authorization");
  if (isNonEmptyString(headerAuthToken)) {
    if (headerAuthToken.startsWith("Bearer ")) {
      headerAuthToken = headerAuthToken.slice("Bearer ".length);
    }
    return headerAuthToken;
  }
  return null;
};

const handleError = (err, res, next) => {
  if (err instanceof HttpError) {
    // Errors are never cacheable. With no Cache-Control, Cloudflare's rule on
    // /task and /data stored 404s under its default TTL and served them to every
    // caller — its cache key ignores Authorization — so one anonymous probe of a
    // private task hid it from its owner, and a just-published item stayed 404.
    // Also overrides any immutable header a route set before it threw.
    setNoStoreCacheHeaders(res);
    // The failure category (spec FAIL-01): a relayed refusal's reason decides
    // it; otherwise the status does. Status and message are unchanged.
    const category = err.reason ? classify(err.reason).category : categoryForStatus(err.statusCode);
    // A refusal that ends (a 429) says when; browsers may read it cross-origin.
    if (err.retryAfter) {
      res.set("Retry-After", String(err.retryAfter));
      res.set("Access-Control-Expose-Headers", "Retry-After");
    }
    res
      .status(err.statusCode)
      .json(createErrorResponse({ ...createError(err.code, err.message), ...(err.reason ? { reason: err.reason } : {}), category }));
  } else {
    next(err);
  }
};

export const buildHttpHandler = handler => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (err) {
    handleError(err, res, next);
  }
};

// A connection selection names an owner's external-API connection to compile
// through. It is caller input — authorization is decided later by policy — so
// only its shape is checked here. Anonymous callers cannot select one.
const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
export const parseConnectionId = (value, { auth } = {}) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !CONNECTION_ID_RE.test(value)) {
    throw new InvalidArgumentError("connectionId must be 1-128 characters of [A-Za-z0-9_-]");
  }
  if (!auth) {
    throw new InvalidArgumentError("connectionId requires an authenticated caller");
  }
  return value;
};

export const createError = (code, message) => ({ code, message });

export const createErrorResponse = error => ({ status: "error", error });

export const createCompileSuccessResponse = ({ id, data }) => ({ status: "success", id, data });

export const createSuccessResponse = ({ data }) => ({ status: "success", data });

// TaskIds are content-addressed (SHA256 of {lang, code}), so a given id's
// content never changes. Advertise that: `public` responses are byte-identical
// for every caller and safe to share on a CDN; `private` ones are browser
// disk-cacheable per-user only.
export const setImmutableCacheHeaders = (res, { isPublic }) =>
  res.set(
    "Cache-Control",
    `${isPublic ? "public" : "private"}, max-age=31536000, immutable`
  );

// The counterpart for a compile whose output expires (a language answering
// `cache: false`; see data.js). The id is still immutable, but the *data* it
// compiles to is not, so it must not be held anywhere — not the browser disk
// cache, not the Cloudflare cache rule on /data.
export const setNoStoreCacheHeaders = res =>
  res.set("Cache-Control", "no-store");

export const getStorageTypeForRequest = req => {
  return (
    req.get("x-graffiticode-storage-type") || "ephemeral"
  );
};

// A publication id names a published item to view. Anyone may present one;
// policy decides whether it is live.
const PUBLICATION_ID_RE = /^pub-[A-Za-z0-9-]{1,100}$/;

export const parsePublicationId = value => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !PUBLICATION_ID_RE.test(value)) {
    throw new InvalidArgumentError("publication must be a publication id");
  }
  return value;
};

// An idempotency key (Idempotency-Key header or body.idempotencyKey) makes a
// retried compile through a connection continue the same invocation, so its
// writes are not repeated. Clients send the same key on every retry of one
// request and a new key for a deliberate rerun. Only meaningful, so only
// accepted, with a selected connection.
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_:.-]{1,190}$/;

// @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
export const parseIdempotencyKey = (value, { connectionId } = {}) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_RE.test(value)) {
    throw new InvalidArgumentError("idempotency key must be 1-190 characters of [A-Za-z0-9_:.-]");
  }
  if (!connectionId) {
    throw new InvalidArgumentError("an idempotency key requires a connectionId");
  }
  return value;
};
