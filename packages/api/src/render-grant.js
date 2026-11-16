// Render grants (C5; docs/c5-l0013-commands-plan.md, Policy's tokens.ts
// `render` profile). Under a command, L0013's camera has no user token. It
// renders a private item's form with a short-lived Policy grant for exactly
// one reserved capture, pinned to the task chain its reservation resolved
// (`tsk`), as the command's subject (`sub`).
//
// The grant travels only in its own request header, which the camera adds to
// the page's requests to this API. It never appears in a URL, so request logs
// and caches never see it:
//
//   Graffiticode-Render-Grant: <grant>
//
// It is a render context, never a user's identity:
// - It is accepted only on GET /form and GET /data, for exactly `tsk`
//   (`?id=` equal to it, byte for byte), with only the parameters those reads
//   need. Any other route, a write, a connection or publication view, another
//   or an altered chain, or a user's credential beside it is refused.
// - The chain's tasks are read under `sub`'s ACLs (public, or `sub` in the
//   task's acls), exactly as `sub`'s own read would be. Item ownership never
//   stands in for them.
// - Nothing else runs as `sub`: the compile behind /data runs with no user
//   context or token, and /form forwards no token.
// - Every answer under a grant is no-store, and the grant is never logged:
//   only its id (`jti`).

import { createLocalJWKSet } from "jose";
import { verifyToken } from "@graffiticode/policy/tokens";
import { HttpError } from "./errors/http.js";
import { writesOutsideCommandControl } from "@graffiticode/common/protected-registry";

export const RENDER_GRANT_HEADER = "graffiticode-render-grant";

// The parameters each read may carry under a grant: the pinned chain, and what
// /form's own redirect puts on the data URL.
const ALLOWED_PARAMS = {
  "/form": new Set(["id", "lang"]),
  "/data": new Set(["id", "generation", "generations"]),
};

// An HttpError, so a refusal thrown inside a route is answered (no-store) by
// the API's own error handler; the middleware answers its own.
export class RenderGrantRefused extends HttpError {
  /** @param {number} status @param {string} grantReason */
  constructor(status, grantReason) {
    super({ code: status, message: grantReason });
    this.status = status;
    this.grantReason = grantReason;
  }
}

// Policy's keys could not be had: temporary, never the grant's fault.
export class KeysUnavailable extends Error {}

export const JWKS_TTL_MS = 10 * 60 * 1000;
export const JWKS_REFETCH_MS = 30 * 1000;

// Policy's public keys, from its private JWKS route (`GET /v1/jwks`), fetched
// with this service's own Google ID token for Policy's audience, as every
// Policy call is (the owner's review of #408: the route is behind Cloud Run
// IAM). Held for JWKS_TTL_MS; an unknown key id fetches again, at most every
// JWKS_REFETCH_MS. Any failure to fetch is KeysUnavailable, and keys past
// their time are never used.
/** @param {{ policyUrl: string, idToken: (audience: string) => Promise<string>, fetch?: any, now?: () => number }} options */
export const buildPolicyJwks = ({ policyUrl, idToken, fetch: doFetch = fetch, now = () => Date.now() }) => {
  const url = new URL("/v1/jwks", policyUrl).toString();
  let held = null;
  let fetchedAt = -Infinity;
  // One refresh at a time, shared: every request that arrives while it runs
  // waits for it (the owner's second review of #408), so none is decided on
  // the keys it is replacing. Its failure is every waiter's 503.
  let inflight = null;
  const refresh = () => {
    inflight ??= load().finally(() => {
      inflight = null;
    });
    return inflight;
  };
  const load = async () => {
    fetchedAt = now();
    /** @type {any} */
    let body;
    try {
      const token = await idToken(policyUrl);
      const res = await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`jwks answered ${res.status}`);
      body = await res.json();
    } catch (e) {
      throw new KeysUnavailable(`policy jwks: ${e?.message ?? e}`);
    }
    if (!Array.isArray(body?.keys)) throw new KeysUnavailable("policy jwks: no keys");
    held = { at: now(), kids: new Set(body.keys.map(k => k.kid)), keys: createLocalJWKSet(body) };
  };
  return async (header, token) => {
    if (inflight) await inflight;
    const fresh = held && now() - held.at < JWKS_TTL_MS;
    if (!fresh || (!held.kids.has(header?.kid) && now() - fetchedAt >= JWKS_REFETCH_MS)) await refresh();
    return held.keys(header, token);
  };
};

// Verifies a grant as exactly Policy's `render` profile. `jwks` is a key set
// (tests) or a key function (buildPolicyJwks). Without one, every grant is
// refused as unavailable.
export const buildRenderGrantVerifier = ({ jwks = null } = {}) => async token => {
  if (!jwks) throw new RenderGrantRefused(503, "render-grants-unavailable");
  try {
    return (await verifyToken(jwks, "render", token)).claims;
  } catch (e) {
    if (e instanceof KeysUnavailable) throw new RenderGrantRefused(503, "render-grants-unavailable");
    throw new RenderGrantRefused(401, "bad-render-grant");
  }
};

// A grant's read is read-only (the owner's review of #408): no stage of its
// chain may be in a language whose compile can write outside Policy and Broker
// command control, as the registry marks it (`writesOutsideCommands`: L0013's
// direct uploader). Every other language's writes go through Policy, which
// refuses them without a connection or a command session, and a grant's read
// has neither. Checked for every stage, before anything compiles.
// Refuses a grant's read of a chain with any such stage.
export const requireReadOnlyChain = tasks => {
  if (tasks.flat().some(task => writesOutsideCommandControl(task?.lang))) throw new RenderGrantRefused(403, "render-not-read-only");
};

// Mounted before every route and before user authentication. A request with
// no grant header passes untouched.
export const renderGrantMiddleware = ({ verify, log = line => console.log(line) }) => async (req, res, next) => {
  const header = req.get(RENDER_GRANT_HEADER);
  if (header === undefined) return next();
  res.set("Cache-Control", "no-store");
  const refuse = (/** @type {RenderGrantRefused} */ e) => {
    log(`render grant refused: ${e.grantReason} ${req.method} ${req.path}`);
    res.status(e.status).json({ status: "error", error: { code: e.status, message: e.grantReason }, data: null });
  };
  try {
    const allowed = req.method === "GET" ? ALLOWED_PARAMS[req.path] : undefined;
    if (!allowed) throw new RenderGrantRefused(403, "render-grant-not-allowed");
    // One context per request: never beside a user's credential. (The View
    // sends an empty Authorization when it has no token.)
    const authorization = req.get("Authorization");
    if ((typeof authorization === "string" && authorization.trim() !== "") || req.query.access_token !== undefined) {
      throw new RenderGrantRefused(400, "mixed-credentials");
    }
    for (const [name, value] of Object.entries(req.query)) {
      if (!allowed.has(name) || typeof value !== "string") throw new RenderGrantRefused(400, "bad-request");
    }
    const claims = await verify(header.trim());
    if (req.query.id !== claims.tsk) throw new RenderGrantRefused(403, "grant-scope-mismatch");
    req.renderGrant = Object.freeze({ sub: claims.sub, itm: claims.itm, tsk: claims.tsk, cmd: claims.cmd, jti: claims.jti });
    log(`render grant ${claims.jti}: ${req.method} ${req.path}`);
    next();
  } catch (e) {
    if (e instanceof RenderGrantRefused) return refuse(e);
    next(e);
  }
};

// The ACL context a grant's task reads use: `sub`'s, for reading the pinned
// chain's tasks only. Never a request's auth context.
export const renderReadAuth = grant => ({ uid: grant.sub, render: grant.jti });

// Headers safe to log: never a credential.
export const loggableHeaders = headers => Object.fromEntries(
  Object.entries(headers ?? {}).map(([name, value]) => [name, ["authorization", RENDER_GRANT_HEADER, "cookie"].includes(name.toLowerCase()) ? "[redacted]" : value]),
);
