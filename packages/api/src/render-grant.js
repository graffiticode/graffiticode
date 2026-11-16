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

import { createRemoteJWKSet } from "jose";
import { verifyToken } from "@graffiticode/policy/tokens";

export const RENDER_GRANT_HEADER = "graffiticode-render-grant";

// The parameters each read may carry under a grant: the pinned chain, and what
// /form's own redirect puts on the data URL.
const ALLOWED_PARAMS = {
  "/form": new Set(["id", "lang"]),
  "/data": new Set(["id", "generation", "generations"]),
};

export class RenderGrantRefused extends Error {
  /** @param {number} status @param {string} reason */
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

// Policy's keys, from its JWKS route, cached by jose. Without Policy, every
// grant is refused as unavailable.
export const buildRenderGrantVerifier = ({ policyUrl = null, jwks = null } = {}) => {
  const keys = jwks ?? (policyUrl ? createRemoteJWKSet(new URL("/v1/jwks", policyUrl)) : null);
  return async token => {
    if (!keys) throw new RenderGrantRefused(503, "render-grants-unavailable");
    try {
      return (await verifyToken(keys, "render", token)).claims;
    } catch (e) {
      // The key set couldn't be fetched: temporary, not the grant's fault.
      const code = String(e?.code ?? "");
      if (code.startsWith("ERR_JWKS") && code !== "ERR_JWKS_NO_MATCHING_KEY" && code !== "ERR_JWKS_MULTIPLE_MATCHING_KEYS") {
        throw new RenderGrantRefused(503, "render-grants-unavailable");
      }
      throw new RenderGrantRefused(401, "bad-render-grant");
    }
  };
};

// Mounted before every route and before user authentication. A request with
// no grant header passes untouched.
export const renderGrantMiddleware = ({ verify, log = line => console.log(line) }) => async (req, res, next) => {
  const header = req.get(RENDER_GRANT_HEADER);
  if (header === undefined) return next();
  res.set("Cache-Control", "no-store");
  const refuse = (/** @type {RenderGrantRefused} */ e) => {
    log(`render grant refused: ${e.reason} ${req.method} ${req.path}`);
    res.status(e.status).json({ status: "error", error: { code: e.status, message: e.reason }, data: null });
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
