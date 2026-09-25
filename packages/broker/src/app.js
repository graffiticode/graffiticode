// Broker HTTP route. The caller comes only from X-Caller-Identity (see
// @graffiticode/policy caller.js); the execution token rides in Authorization.
//
//   POST   /v1/execute          compiler  { op, payload }  -> { status, result?, steps?, replayed?, error? }
//   PUT    /v1/secrets/:conn    policy    { key, secret }  store (sealed) or replace a connection's credential
//   DELETE /v1/secrets/:conn    policy
//
// A refusal carries only its reason — never the token, payload or credential.

import { Router } from "express";
import { buildHttpHandler, createHttpApp, sendSuccessResponse, parseTokenFromRequest } from "@graffiticode/common/http";
import { InvalidArgumentError, UnauthenticatedError, UnauthorizedError } from "@graffiticode/common/errors";
import { BrokerRefused } from "./broker.js";

const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const createBrokerApp = ({ broker, secrets, identifyCaller, audit }) => {
  const router = new Router();
  // Only policy provisions credentials. The response never echoes them.
  const provision = handler => buildHttpHandler(async (req, res) => {
    let caller;
    try {
      caller = await identifyCaller(req);
    } catch (err) {
      await audit({ event: "secret", outcome: "denied", reason: "caller-rejected" });
      throw err;
    }
    if (caller.role !== "policy") {
      await audit({ event: "secret", outcome: "denied", reason: "route-not-allowed-for-caller" });
      throw new UnauthorizedError("route not allowed for this caller");
    }
    if (!CONNECTION_ID_RE.test(req.params.conn)) throw new InvalidArgumentError("bad connection id");
    await handler(req);
    await audit({ event: "secret", connectionId: req.params.conn, outcome: "allowed" });
    sendSuccessResponse(res, { connectionId: req.params.conn });
  });
  router.put("/secrets/:conn", provision(async req => {
    const { key, secret } = req.body ?? {};
    if (typeof key !== "string" || !key || typeof secret !== "string" || !secret) {
      throw new InvalidArgumentError("key and secret are required");
    }
    await secrets.put(req.params.conn, { key, secret });
  }));
  router.delete("/secrets/:conn", provision(async req => {
    await secrets.delete(req.params.conn);
  }));
  router.post("/execute", buildHttpHandler(async (req, res) => {
    let caller;
    try {
      caller = await identifyCaller(req);
    } catch (err) {
      await audit({ event: "execute", outcome: "denied", reason: "caller-rejected" });
      throw err;
    }
    const token = parseTokenFromRequest(req);
    if (!token) throw new UnauthenticatedError("missing execution token");
    const { op, payload } = req.body ?? {};
    try {
      sendSuccessResponse(res, await broker.execute({ caller, token, op, payload }));
    } catch (err) {
      if (err instanceof BrokerRefused) {
        res.status(err.status).json({
          status: "error",
          error: { code: err.status, message: "broker refused", reason: err.reason, detail: err.detail },
          data: null,
        });
        return;
      }
      throw err;
    }
  }));
  return createHttpApp(app => app.use("/v1", router));
};
