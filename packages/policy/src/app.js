// Policy HTTP routes. Each route names the caller roles allowed to use it; a
// caller outside that set is refused (403) and audited before any decision is
// made. The end user comes only from Authorization (verified with the auth
// service); the caller only from X-Caller-Identity (see caller.js).
//
//   POST /v1/intents   console    { mode, connectionId }         -> { intentToken, saveActionId }
//   POST /v1/snapshot  compiler   { lang, connectionId, fns, mode?, intentToken?, invocationId }
//                                                                 -> { allowed, sessionToken }
//   POST /v1/mint      compiler   { sessionToken, fn, op, occurrenceId, argsDigest }
//                                                                 -> { executionToken, operationId }
//   GET  /v1/jwks      anyone     the public keys that verify policy tokens

import { Router } from "express";
import { buildHttpHandler, createHttpApp, sendSuccessResponse, parseTokenFromRequest } from "@graffiticode/common/http";
import { UnauthenticatedError, UnauthorizedError } from "@graffiticode/common/errors";
import { PolicyDenied } from "./policy.js";

const ROUTE_ROLES = Object.freeze({
  intents: ["console"],
  snapshot: ["compiler"],
  mint: ["compiler"],
});

export const createPolicyApp = ({ policy, identifyCaller, verifyUser, publicJwks, audit }) => {
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
  router.post("/intents", buildHttpHandler(async (req, res) => {
    const caller = await authorize("intents")(req);
    const u = await user(req);
    const { mode, connectionId } = req.body ?? {};
    await decide(res, () => policy.issueIntent({ caller, user: u, mode, connectionId }));
  }));
  router.post("/snapshot", buildHttpHandler(async (req, res) => {
    const caller = await authorize("snapshot")(req);
    const u = await user(req);
    const { lang, connectionId, fns, mode, intentToken, invocationId } = req.body ?? {};
    await decide(res, () => policy.snapshot({ caller, user: u, lang, connectionId, fns, mode, intentToken, invocationId }));
  }));
  router.post("/mint", buildHttpHandler(async (req, res) => {
    const caller = await authorize("mint")(req);
    const { sessionToken, fn, op, occurrenceId, argsDigest } = req.body ?? {};
    await decide(res, () => policy.mint({ caller, sessionToken, fn, op, occurrenceId, argsDigest }));
  }));
  router.get("/jwks", (req, res) => res.status(200).json(publicJwks));

  return createHttpApp(app => app.use("/v1", router));
};
