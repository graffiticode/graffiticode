// Policy HTTP routes. Each route names the caller roles allowed to use it; a
// caller outside that set is refused (403) and audited before any decision is
// made. The end user comes only from Authorization (verified with the auth
// service); the caller only from X-Caller-Identity (see caller.js).
//
//   POST /v1/invocations gateway  { connectionId, taskId, inputDigest, idempotencyKey? }
//                                                                 -> { invocationToken, invocationId, seq, reused, ownerUid }
//   POST   /v1/publications          gateway  { connectionId, taskId, lang, artifactInvocationId } -> { publicationId }
//   DELETE /v1/publications/:id      gateway  the publisher unpublishes
//   POST   /v1/publications/:id/view gateway  NO user: a view of the published item
//                                             -> { invocationToken, publisherUid, connectionId, lang, taskId, artifactInvocationId }
//   POST /v1/snapshot  compiler   { lang, connectionId, fns, invocationToken, stage }
//                                 (no user for a publication's invocation token)
//                                                                 -> { allowed, sessionToken }
//   POST /v1/preview-session  compiler  { lang }  NO user, NO invocation: a session on the
//                                 system connection for the lang's backend, carrying only its
//                                 system-preview functions (sub "system-preview", sys: true)
//                                                                 -> { allowed, sessionToken }
//   POST /v1/mint      compiler   { sessionToken, fn, op, occurrenceId, argsDigest }
//                                                                 -> { executionToken, operationId }
//   GET    /v1/connections              console  the user's connections (no secrets)
//   POST   /v1/connections              console  { backend, label?, credential: { key, secret } }
//   POST   /v1/connections/:id/rotate   console  { credential: { key, secret } }
//   POST   /v1/connections/:id/disable  console
//   DELETE /v1/connections/:id          console
//   GET    /v1/connections/:id/grants            console  the owner's grants on it
//   GET    /v1/connections/:id/shareable         console  the (lang, fn, kind) a grant on it can include
//   POST   /v1/connections/:id/grants            console  { recipientUid | recipientEmailHash, recipientLabel?, permissions, expiresAt? }
//   PATCH  /v1/connections/:id/grants/:grantId   console  { permissions, expiresAt? } edit
//   DELETE /v1/connections/:id/grants/:grantId   console  revoke
//   GET    /v1/shared                            console  connections shared with the user
//   DELETE /v1/shared/:id                        console  the recipient leaves
//   POST   /v1/grants/claim                      console  { emailHashes } pending grants for the user's emails
//   GET  /v1/jwks      anyone     the public keys that verify policy tokens

import { Router } from "express";
import { buildHttpHandler, createHttpApp, sendSuccessResponse, parseTokenFromRequest } from "@graffiticode/common/http";
import { UnauthenticatedError, UnauthorizedError } from "@graffiticode/common/errors";
import { PolicyDenied } from "./policy.js";

const ROUTE_ROLES = Object.freeze({
  invocations: ["gateway"],
  publications: ["gateway"],
  snapshot: ["compiler"],
  "preview-session": ["compiler"],
  mint: ["compiler"],
  connections: ["console"],
});

export const createPolicyApp = ({ policy, manager, identifyCaller, verifyUser, publicJwks, audit }) => {
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
    } catch {
      throw new UnauthenticatedError("invalid user token");
    }
  };
  // A snapshot for a published item's view has no user; any other token that
  // is present must still verify.
  const optionalUser = async req => (parseTokenFromRequest(req) ? user(req) : null);
  const decide = async (res, fn) => {
    try {
      sendSuccessResponse(res, await fn());
    } catch (err) {
      if (err instanceof PolicyDenied) {
        res.status(403).json({ status: "error", error: { code: 403, message: "policy denied", reason: err.reason }, data: null });
        return;
      }
      throw err;
    }
  };

  const router = new Router();
  router.post("/invocations", buildHttpHandler(async (req, res) => {
    const caller = await authorize("invocations")(req);
    const u = await user(req);
    const { connectionId, taskId, inputDigest, idempotencyKey = null } = req.body ?? {};
    await decide(res, () => policy.allocateInvocation({ caller, user: u, connectionId, taskId, inputDigest, idempotencyKey }));
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
    const { lang, connectionId, fns, invocationToken, stage } = req.body ?? {};
    await decide(res, () => policy.snapshot({ caller, user: u, lang, connectionId, fns, invocationToken, stage }));
  }));
  // No user token is read: the session is the system's, not a user's.
  router.post("/preview-session", buildHttpHandler(async (req, res) => {
    const caller = await authorize("preview-session")(req);
    const { lang } = req.body ?? {};
    await decide(res, () => policy.previewSession({ caller, lang }));
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
  router.post("/connections", manage(({ caller, user, body }) =>
    manager.create({ caller, user, backend: body.backend, label: body.label ?? null, credential: body.credential })));
  router.post("/connections/:id/rotate", manage(({ caller, user, id, body }) =>
    manager.rotate({ caller, user, connectionId: id, credential: body.credential })));
  router.post("/connections/:id/disable", manage(({ caller, user, id }) =>
    manager.disable({ caller, user, connectionId: id })));
  router.delete("/connections/:id", manage(({ caller, user, id }) =>
    manager.remove({ caller, user, connectionId: id })));
  router.get("/connections/:id/shareable", manage(({ caller, user, id }) => manager.shareable({ caller, user, connectionId: id })));
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

  return createHttpApp(app => app.use("/v1", router));
};
