// Policy HTTP routes. Each route names the caller roles allowed to use it; a
// caller outside that set is refused (403) and audited before any decision is
// made. The end user comes only from Authorization (verified with the auth
// service); the caller only from X-Caller-Identity (see caller.js).
//
//   POST /v1/invocations gateway  { connectionId, taskId, inputDigest, idempotencyKey?, admission? }
//                                 -> { invocationToken, invocationId, seq, reused, ownerUid, contract, planDigest }
//   POST /v1/invocations/plan gateway { invocationToken }   the invocation's plan, before a retry
//                                 resolves compiler URLs   -> { contract, plan: null | { planDigest, stages } }
//   POST /v1/admissions gateway   { invocationToken, taskIds, stages: [manifest per task] }
//                                 one decision for the chain -> { planDigest, admissionToken, stages }
//   POST   /v1/publications          gateway  { connectionId, taskId, lang, artifactInvocationId } -> { publicationId }
//   DELETE /v1/publications/:id      gateway  the publisher unpublishes
//   POST   /v1/publications/:id/view gateway  NO user: a view of the published item
//                                             -> { invocationToken, publisherUid, connectionId, lang, taskId, artifactInvocationId }
//   POST /v1/snapshot  compiler   { lang, connectionId, fns, invocationToken, stage, admissionToken?, manifest? }
//                                 (no user for a publication's invocation token)
//                                                                 -> { allowed, sessionToken }
//   POST /v1/preview-session  compiler  { lang }  NO user, NO invocation: a session on the
//                                 system connection for the lang's backend, carrying only its
//                                 system-preview functions (sub "system-preview", sys: true)
//                                                                 -> { allowed, sessionToken }
//   POST /v1/mint      compiler   { sessionToken, fn, op, occurrenceId, argsDigest }
//                                                                 -> { executionToken, operationId }
//                                 (429 `rate-limited` with Retry-After when this instance's
//                                 system preview signing bucket is empty)
//   GET    /v1/connections              console  the user's connections (no secrets)
//   POST   /v1/connections              console  { backend, label?, credential: { key, secret } }
//   POST   /v1/connections/:id/rotate   console  { credential: { key, secret } }
//   POST   /v1/connections/:id/disable  console
//   DELETE /v1/connections/:id          console
//   GET    /v1/connections/:id/grants            console  the owner's grants on it
//   GET    /v1/connections/:id/shareable         console  the (lang, fn, kind) a grant on it can include
//   GET    /v1/connections/:id/functions         console  every protected function on its backend
//                                                         { lang, fn, kind, implicit, delegable }
//   PUT    /v1/connections/:id/owner-permissions console  { permissions: [{ lang, fn }] | null } the owner's own use
//   POST   /v1/connections/:id/grants            console  { recipientUid | recipientEmailHash, recipientLabel?, permissions, expiresAt? }
//   PATCH  /v1/connections/:id/grants/:grantId   console  { permissions, expiresAt? } edit
//   DELETE /v1/connections/:id/grants/:grantId   console  revoke
//   GET    /v1/shared                            console  connections shared with the user
//   DELETE /v1/shared/:id                        console  the recipient leaves
//   POST   /v1/grants/claim                      console  { emailHashes } pending grants for the user's emails
//   GET  /v1/jwks      anyone     the public keys that verify policy tokens
//   GET  /v1/protected-execution  anyone  { enabled, source } (maintenance.js)

import { Router } from "express";
import { buildHttpHandler, createHttpApp, sendSuccessResponse, parseTokenFromRequest } from "@graffiticode/common/http";
import { UnauthenticatedError, UnauthorizedError, UnavailableError } from "@graffiticode/common/errors";
import { classify } from "@graffiticode/common/failures";
import { PolicyDenied, PolicyMaintenance } from "./policy.js";
import { requestContextMiddleware } from "./audit.js";

const ROUTE_ROLES = Object.freeze({
  invocations: ["gateway"],
  admissions: ["gateway"],
  publications: ["gateway"],
  snapshot: ["compiler"],
  "preview-session": ["compiler"],
  mint: ["compiler"],
  "authorize-execution": ["broker"],
  connections: ["console"],
});

// The auth service couldn't be asked about a user token: a network error, or
// an answer that isn't auth's (the client accepts only 200, 400 and 401, so a
// 5xx or an edge error page arrives as a status error). Auth's own refusal
// is a 400 or 401 it answered, never this. 2026-10-27: a snapshot's call to
// auth never arrived (auth logged nothing), and Policy answered 401
// "invalid user token" for a valid token.
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
export const authUnreachable = err => {
  const status = err?.statusCode;
  return NETWORK_CODES.has(String(err?.code)) || NETWORK_CODES.has(String(err?.cause?.code)) ||
    (typeof status === "number" && (status >= 500 || status === 429)) ||
    /socket hang up|fetch failed/i.test(String(err?.message));
};

// Asks auth once more when it couldn't be reached: verifying a token only
// reads, so a retry is safe.
export const verifyUserWithRetry = verifyUser => async token => {
  try {
    return await verifyUser(token);
  } catch (err) {
    if (!authUnreachable(err)) throw err;
    return verifyUser(token);
  }
};

export const createPolicyApp = ({ policy, manager, identifyCaller, verifyUser, publicJwks, audit, log = line => console.warn(line) }) => {
  const authorize = route => async req => {
    let caller;
    try {
      caller = await identifyCaller(req);
    } catch (err) {
      await audit({ event: route, outcome: "denied", reason: "caller-rejected" });
      throw err;
    }
    if (!ROUTE_ROLES[route].includes(caller.role)) {
      await audit({ event: route, outcome: "denied", reason: "route-not-allowed-for-caller" });
      throw new UnauthorizedError("route not allowed for this caller");
    }
    return caller;
  };
  const user = async req => {
    const token = parseTokenFromRequest(req);
    if (!token) throw new UnauthenticatedError("missing user token");
    try {
      const { uid } = await verifyUser(token);
      if (!uid) throw new Error("no uid");
      return { uid };
    } catch (err) {
      // Not the user's fault when auth couldn't be asked: 503, so the caller
      // can retry, instead of a 401 for a token that may be valid.
      const unreachable = authUnreachable(err);
      log(JSON.stringify({ event: "user-token", outcome: "refused", reason: unreachable ? "auth-unreachable" : "invalid", detail: String(err?.code ?? err?.statusCode ?? "").slice(0, 40) }));
      if (unreachable) throw new UnavailableError("the user token could not be verified; retry");
      throw new UnauthenticatedError("invalid user token");
    }
  };
  // A snapshot for a published item's view has no user; any other token that
  // is present must still verify.
  const optionalUser = async req => (parseTokenFromRequest(req) ? user(req) : null);
  // A refusal's category (common/failures, spec FAIL-01) beside its reason.
  // A reason the vocabulary doesn't know is reported as unavailable, and
  // audited as such without echoing it.
  const categoryOf = async (reason, route) => {
    const { category, classified } = classify(reason);
    if (!classified) await audit({ event: route ?? "policy", outcome: "denied", reason: "unclassified-reason" });
    return category;
  };
  const decide = async (res, fn) => {
    try {
      sendSuccessResponse(res, await fn());
    } catch (err) {
      if (err instanceof PolicyMaintenance) {
        res.status(503).json({ status: "error", error: { code: 503, message: "protected execution is paused", reason: err.reason, category: await categoryOf(err.reason, null) }, data: null });
        return;
      }
      // Busy, not denied (rate-limit.js): 429 with when to try again, never
      // cached.
      if (err instanceof PolicyDenied && err.retryAfter !== undefined) {
        res.set("Retry-After", String(err.retryAfter));
        res.set("Cache-Control", "no-store");
        res.status(429).json({ status: "error", error: { code: 429, message: "policy busy", reason: err.reason, category: await categoryOf(err.reason, null), retryAfter: err.retryAfter }, data: null });
        return;
      }
      if (err instanceof PolicyDenied) {
        res.status(403).json({ status: "error", error: { code: 403, message: "policy denied", reason: err.reason, category: await categoryOf(err.reason, null) }, data: null });
        return;
      }
      throw err;
    }
  };

  // express's Router is callable; its types reject `new`, which works.
  const router = new (Router as unknown as new () => ReturnType<typeof Router>)();
  router.post("/invocations", buildHttpHandler(async (req, res) => {
    const caller = await authorize("invocations")(req);
    const u = await user(req);
    const { connectionId, taskId, inputDigest, idempotencyKey = null, admission = false } = req.body ?? {};
    await decide(res, () => policy.allocateInvocation({ caller, user: u, connectionId, taskId, inputDigest, idempotencyKey, admission }));
  }));
  // Chain admission (W4): the invocation's plan, if any, before a retry
  // resolves compiler URLs; and one decision for every stage of the chain.
  router.post("/invocations/plan", buildHttpHandler(async (req, res) => {
    const caller = await authorize("admissions")(req);
    const u = await user(req);
    const { invocationToken } = req.body ?? {};
    res.set("Cache-Control", "no-store");
    await decide(res, () => policy.planLookup({ caller, user: u, invocationToken }));
  }));
  router.post("/admissions", buildHttpHandler(async (req, res) => {
    const caller = await authorize("admissions")(req);
    const u = await user(req);
    const { invocationToken, taskIds, stages } = req.body ?? {};
    res.set("Cache-Control", "no-store");
    await decide(res, () => policy.admit({ caller, user: u, invocationToken, taskIds, stages }));
  }));
  router.post("/publications", buildHttpHandler(async (req, res) => {
    const caller = await authorize("publications")(req);
    const u = await user(req);
    const { connectionId, taskId, lang, artifactInvocationId } = req.body ?? {};
    await decide(res, () => policy.createPublication({ caller, user: u, connectionId, taskId, lang, artifactInvocationId }));
  }));
  router.delete("/publications/:id", buildHttpHandler(async (req, res) => {
    const caller = await authorize("publications")(req);
    const u = await user(req);
    await decide(res, () => policy.deletePublication({ caller, user: u, publicationId: req.params.id }));
  }));
  router.post("/publications/:id/view", buildHttpHandler(async (req, res) => {
    const caller = await authorize("publications")(req);
    await decide(res, () => policy.authorizeView({ caller, publicationId: req.params.id }));
  }));
  router.post("/snapshot", buildHttpHandler(async (req, res) => {
    const caller = await authorize("snapshot")(req);
    const u = await optionalUser(req);
    const { lang, connectionId, fns, invocationToken, stage, admissionToken = null, manifest = null } = req.body ?? {};
    await decide(res, () => policy.snapshot({ caller, user: u, lang, connectionId, fns, invocationToken, stage, admissionToken, manifest }));
  }));
  // No user token is read: the session is the system's, not a user's.
  router.post("/preview-session", buildHttpHandler(async (req, res) => {
    const caller = await authorize("preview-session")(req);
    const { lang } = req.body ?? {};
    await decide(res, () => policy.previewSession({ caller, lang }));
  }));
  // Broker only. A decision is for one step, now: never cacheable.
  router.post("/authorize-execution", buildHttpHandler(async (req, res) => {
    const caller = await authorize("authorize-execution")(req);
    const { executionToken, op, argsDigest, step, purpose, after } = req.body ?? {};
    res.set("Cache-Control", "no-store");
    await decide(res, () => policy.authorizeExecution({ caller, executionToken, op, argsDigest, step, purpose, after }));
  }));
  router.post("/mint", buildHttpHandler(async (req, res) => {
    const caller = await authorize("mint")(req);
    const { sessionToken, fn, op, occurrenceId, argsDigest } = req.body ?? {};
    await decide(res, () => policy.mint({ caller, sessionToken, fn, op, occurrenceId, argsDigest }));
  }));
  const manage = handler => buildHttpHandler(async (req, res) => {
    const caller = await authorize("connections")(req);
    const u = await user(req);
    await decide(res, () => handler({ caller, user: u, body: req.body ?? {}, id: req.params.id }));
  });
  router.get("/connections", manage(({ caller, user }) => manager.list({ caller, user })));
  // Reconciliation (WRITE-02, W5): the console, for the signed-in user's save.
  router.post("/receipts/reconcile", manage(({ caller, user, body }) => policy.reconcile({
    caller, user, connectionId: body.connectionId, idempotencyKey: body.idempotencyKey ?? null, invocationId: body.invocationId ?? null,
  })));
  router.post("/connections", manage(({ caller, user, body }) =>
    manager.create({ caller, user, backend: body.backend, label: body.label ?? null, credential: body.credential })));
  router.post("/connections/:id/rotate", manage(({ caller, user, id, body }) =>
    manager.rotate({ caller, user, connectionId: id, credential: body.credential })));
  router.post("/connections/:id/disable", manage(({ caller, user, id }) =>
    manager.disable({ caller, user, connectionId: id })));
  router.delete("/connections/:id", manage(({ caller, user, id }) =>
    manager.remove({ caller, user, connectionId: id })));
  router.get("/connections/:id/shareable", manage(({ caller, user, id }) => manager.shareable({ caller, user, connectionId: id })));
  router.get("/connections/:id/functions", manage(({ caller, user, id }) => manager.functions({ caller, user, connectionId: id })));
  router.put("/connections/:id/owner-permissions", manage(({ caller, user, id, body }) =>
    manager.setOwnerPermissions({ caller, user, connectionId: id, permissions: body.permissions ?? null })));
  router.get("/connections/:id/grants", manage(({ caller, user, id }) => manager.grants({ caller, user, connectionId: id })));
  router.post("/connections/:id/grants", manage(({ caller, user, id, body }) => manager.share({
    caller,
    user,
    connectionId: id,
    recipientUid: body.recipientUid ?? null,
    recipientEmailHash: body.recipientEmailHash ?? null,
    recipientLabel: body.recipientLabel ?? null,
    permissions: body.permissions ?? null,
    expiresAt: body.expiresAt ?? null
  })));
  router.patch("/connections/:id/grants/:grantId", buildHttpHandler(async (req, res) => {
    const caller = await authorize("connections")(req);
    const u = await user(req);
    const body = req.body ?? {};
    await decide(res, () => manager.update({
      caller,
      user: u,
      connectionId: req.params.id,
      grantId: req.params.grantId,
      permissions: body.permissions ?? null,
      expiresAt: body.expiresAt ?? null
    }));
  }));
  router.delete("/connections/:id/grants/:grantId", buildHttpHandler(async (req, res) => {
    const caller = await authorize("connections")(req);
    const u = await user(req);
    await decide(res, () => manager.revoke({ caller, user: u, connectionId: req.params.id, grantId: req.params.grantId }));
  }));
  router.get("/shared", manage(({ caller, user }) => manager.shared({ caller, user })));
  router.delete("/shared/:id", manage(({ caller, user, id }) => manager.leave({ caller, user, connectionId: id })));
  router.post("/grants/claim", manage(({ caller, user, body }) => manager.claim({ caller, user, emailHashes: body.emailHashes })));
  router.get("/jwks", (req, res) => res.status(200).json(publicJwks));
  router.get("/protected-execution", buildHttpHandler(async (req, res) => {
    res.status(200).json(await policy.protectedExecution());
  }));

  // Every record written while handling a request names it (audit.js).
  return createHttpApp(app => app.use("/v1", requestContextMiddleware, router));
};
