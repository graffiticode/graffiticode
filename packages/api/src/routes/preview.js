// POST /preview/sign { activity }: the one door to system preview signing
// (plan: system preview signing rate limits, design point 1). L0176's View
// sends the activity its Form resolved here to have it signed for
// l0176.graffiticode.org under the system preview session.
//
// Stateless by design. POST /compile would store the posted data as a task,
// and an anonymous task is created public, even over a matching private one
// (storage/tasks.js): an activity resolved from a private connection artifact
// would be published. So this stores nothing (no task, no compile record),
// answers no-store, and dispatches exactly one L0176 compile of the fixed
// `init data {}` program with the activity inline, through comp.js, with the
// api's identity and no connection. A connectionId or user token in the
// request is ignored and never forwarded. Each call is one signing stage on
// the per-client limit (signing-limit.js).
//
// Response: { request } (signed), { signing: { unsigned, message } }
// (L0176 answered unsigned), or an error: 400 a malformed activity, 413 too
// large, 422 L0176's compile errors, 429 the limit, 502 no answer from L0176.
import { Router, json } from "express";
import { HttpError, InvalidArgumentError } from "../errors/http.js";
import { SIGNING_LANG } from "../signing-limit.js";
import {
  buildHttpHandler, createError, createErrorResponse, setNoStoreCacheHeaders, optionsHandler
} from "./utils.js";

export const PREVIEW_SIGN_LIMIT_BYTES = 256 * 1024;

// `init data {}..`, as @graffiticode/parser emits it (language 0176); the
// same program as L0176's View (languages/l0176/packages/view/src/components/
// form/sign.ts INIT_DATA_CODE).
export const INIT_DATA_CODE = Object.freeze({
  3: { tag: "RECORD", elts: [] },
  6: { tag: "DATA", elts: [3] },
  8: { tag: "INIT", elts: [6] },
  10: { tag: "EXPRS", elts: [8] },
  11: { tag: "PROG", elts: [10] },
  root: 11,
});

export const UNSIGNED_MESSAGE = "This preview couldn't be signed.";
const ACTIVITY_TYPES = ["questions", "items"];

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

class PayloadTooLarge extends HttpError {
  constructor() {
    super({ code: 413, message: `activity must be at most ${PREVIEW_SIGN_LIMIT_BYTES} bytes` });
  }
}

// Mounted before the app's general body parser (app.js), so this route's
// body is held to its own cap rather than the general 50mb.
export const previewSignBodyParser = (() => {
  const parse = json({ limit: PREVIEW_SIGN_LIMIT_BYTES });
  return (req, res, next) => parse(req, res, err => {
    if (!err) return next();
    setNoStoreCacheHeaders(res);
    const status = err.status === 413 ? 413 : 400;
    res.status(status).json(createErrorResponse({ ...createError(status, status === 413 ? new PayloadTooLarge().message : "body must be JSON"), category: "malformed" }));
  });
})();

// Shape only: the activity's content is L0176's to check.
export const parseActivity = body => {
  const activity = isPlainObject(body) ? body.activity : undefined;
  if (!isPlainObject(activity)) throw new InvalidArgumentError("activity must be an object");
  if (!ACTIVITY_TYPES.includes(activity.type)) throw new InvalidArgumentError("activity.type must be questions or items");
  if (!isPlainObject(activity.data)) throw new InvalidArgumentError("activity.data must be an object");
  // Only the activity: never a request or signing note it arrived with.
  const out = { type: activity.type, data: activity.data };
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > PREVIEW_SIGN_LIMIT_BYTES) throw new PayloadTooLarge();
  return out;
};

// L0176's answer, as its View reads it (sign.ts): the signed request, or the
// activity back with why it's unsigned.
export const signResult = obj => {
  const data = obj?.data;
  if (!isPlainObject(data)) return null;
  if (data.signing !== undefined || (typeof data.type === "string" && isPlainObject(data.data))) {
    const unsigned = typeof data.signing?.unsigned === "string" && data.signing.unsigned ? data.signing.unsigned : "unsigned";
    const message = typeof data.signing?.message === "string" && data.signing.message ? data.signing.message : UNSIGNED_MESSAGE;
    return { signing: { unsigned, message } };
  }
  return { request: data };
};

const buildPostSignHandler = ({ compile, signingLimiter = null }) => buildHttpHandler(async (req, res) => {
  setNoStoreCacheHeaders(res);
  res.set("Access-Control-Allow-Origin", "*");
  const activity = parseActivity(req.body);
  if (signingLimiter) await signingLimiter.charge(req, 1);
  // No user, no token, no connection: the system path, with the api's identity.
  const obj = await compile({ lang: SIGNING_LANG, code: INIT_DATA_CODE, data: activity, auth: null, options: {}, uid: null });
  if (obj?.responseLost) {
    res.status(502).json(createErrorResponse({ ...createError(502, "the preview signer didn't answer"), category: "unavailable" }));
    return;
  }
  if (Array.isArray(obj?.errors) && obj.errors.length > 0) {
    const errors = obj.errors.map(e => (isPlainObject(e) ? e : { message: String(e) }));
    res.status(422).json({ ...createErrorResponse({ ...createError(422, String(errors[0]?.message ?? "the activity didn't compile")), category: "malformed" }), errors });
    return;
  }
  const result = signResult(obj);
  if (!result) {
    res.status(502).json(createErrorResponse({ ...createError(502, "the preview signer gave no preview"), category: "unavailable" }));
    return;
  }
  res.status(200).json(result);
});

export default ({ compile, signingLimiter = null }) => {
  const router = Router();
  router.post("/sign", buildPostSignHandler({ compile, signingLimiter }));
  router.options("/sign", optionsHandler);
  return router;
};
