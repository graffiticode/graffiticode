// Who is answering, for C4's submission check (docs/c4-l0182-assignment-plan.md decision 3;
// the continuation protocol's direct API-store authority reads, docs/c4-runtime-lifecycle.md
// §1.3). Two pieces, both used only by the assignment exchange (assignment-exchange.js):
//
// buildCallerContext: at ingress (/compile, /data), the immutable caller context.
//   - `uid` comes only from the verified user token, as today.
//   - The workspace comes only as an attested field (X-Attested-Workspace) on a call whose
//     X-Caller-Identity is a Google ID token, audience CALLER_CONTEXT_AUDIENCE, for a
//     registered frontend's service account (L0182_ATTESTING_FRONTENDS, before I-2). A
//     header without a verified frontend is ignored, never trusted; a supplied identity that
//     doesn't verify is refused, not treated as absent.
//   - The installation is "graffiticode" (I-3, before I-2).
//   - The shared trial uid (FREE_PLAN_UID) is a free-plan principal: without an attested
//     workspace it is unattested, and can never submit (assignments.js), never a user.
//
// buildRespondentAuthority: the console's respondent-authority route, for unbound sessions,
//   called as the api's own identity. Any failure leaves the session without an answer, and
//   the store then refuses the freeze temporarily (fail closed).
import { HttpError } from "./errors/http.js";

export const FRONTEND_IDENTITY_HEADER = "X-Caller-Identity";
export const ATTESTED_WORKSPACE_HEADER = "X-Attested-Workspace";
export const INSTALLATION = "graffiticode";

const list = value => String(value ?? "").split(",").map(s => s.trim()).filter(Boolean);

export const parseRespondentConfig = (env = process.env) => ({
  frontends: list(env.L0182_ATTESTING_FRONTENDS),
  audience: env.CALLER_CONTEXT_AUDIENCE || "urn:graffiticode:api",
  freePlanUid: env.FREE_PLAN_UID || null,
  respondentAuthorityUrl: env.RESPONDENT_AUTHORITY_URL || null,
  respondentAuthorityAudience: env.RESPONDENT_AUTHORITY_AUDIENCE || null,
  canarySessions: list(env.L0182_CANARY_SESSIONS),
});

// Reaching Google's certificates failed: the caller's token may be fine.
const unavailable = err =>
  /fetch failed|socket hang up|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(String(err?.message ?? err) + String(err?.code ?? ""));

const refusal = ({ statusCode, reason, message }) => new HttpError({ code: statusCode, statusCode, reason, message });

export const buildCallerContext = ({ verifyIdToken = null, audience = "urn:graffiticode:api", frontends = [], freePlanUid = null, log = console.warn } = {}) => {
  const registered = new Set(frontends);
  // The frontend a request came through, verified, or null when it named none.
  const frontendOf = async req => {
    const token = req.get?.(FRONTEND_IDENTITY_HEADER);
    if (!token) return null;
    if (!verifyIdToken) throw refusal({ statusCode: 401, reason: "frontend-identity-invalid", message: "this api can't verify a caller identity" });
    let claims;
    try {
      claims = await verifyIdToken(token, audience);
    } catch (err) {
      if (unavailable(err)) throw refusal({ statusCode: 503, reason: "frontend-identity-unavailable", message: "caller identity could not be verified; retry" });
      log(JSON.stringify({ event: "caller-context", outcome: "refused", why: "invalid" }));
      throw refusal({ statusCode: 401, reason: "frontend-identity-invalid", message: "invalid caller identity" });
    }
    if (!claims?.email || claims.email_verified !== true) throw refusal({ statusCode: 401, reason: "frontend-identity-invalid", message: "caller identity has no verified email" });
    if (!registered.has(claims.email)) throw refusal({ statusCode: 403, reason: "frontend-not-registered", message: "caller identity is not a registered frontend" });
    return claims.email;
  };
  return async (req, auth) => {
    const frontend = await frontendOf(req);
    const uid = typeof auth?.uid === "string" && auth.uid ? auth.uid : null;
    if (!uid) return Object.freeze({ principal: null, frontend });
    if (freePlanUid && uid === freePlanUid) {
      const workspace = frontend ? req.get?.(ATTESTED_WORKSPACE_HEADER) || null : null;
      const principal = workspace
        ? { kind: "freePlan", uid, workspace, installation: INSTALLATION }
        : { kind: "freePlan", uid, installation: INSTALLATION };
      return Object.freeze({ principal: Object.freeze(principal), frontend });
    }
    return Object.freeze({ principal: Object.freeze({ kind: "user", uid, installation: INSTALLATION }), frontend });
  };
};

// `idToken(audience)` mints the api's own Google ID token. Resolves each session to the
// route's answer, `{ principal } | { unknown } | { ambiguous }`, as an own property; a session
// with no answer (unconfigured, unreachable, refused, malformed) is left out.
export const buildRespondentAuthority = ({ url = null, audience = null, idToken = null, fetch: doFetch = globalThis.fetch, timeoutMs = 2000, log = console.log } = {}) =>
  async sessions => {
    const answers = Object.create(null);
    if (!url || !audience || !idToken) return answers;
    await Promise.all(sessions.map(async session => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const token = await idToken(audience);
        const res = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", [FRONTEND_IDENTITY_HEADER]: token },
          body: JSON.stringify({ session }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`respondent authority answered ${res.status}`);
        const body = /** @type {any} */ (await res.json());
        if (body?.unknown === true) answers[session] = { unknown: true };
        else if (body?.ambiguous === true) answers[session] = { ambiguous: true };
        else if (body?.principal && typeof body.principal === "object") answers[session] = { principal: body.principal };
        else throw new Error("respondent authority answered nothing usable");
      } catch (e) {
        log(`ERROR respondent authority unavailable: ${e?.message}`);
      } finally {
        clearTimeout(timer);
      }
    }));
    return answers;
  };
