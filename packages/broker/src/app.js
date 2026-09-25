// Broker HTTP route. The caller comes only from X-Caller-Identity (see
// @graffiticode/policy caller.js); the execution token rides in Authorization.
//
//   POST /v1/execute  compiler  { op, payload }  -> { status, result?, steps?, replayed?, error? }
//
// A refusal carries only its reason — never the token, payload or credential.

import { Router } from "express";
import { buildHttpHandler, createHttpApp, sendSuccessResponse, parseTokenFromRequest } from "@graffiticode/common/http";
import { UnauthenticatedError } from "@graffiticode/common/errors";
import { BrokerRefused } from "./broker.js";

export const createBrokerApp = ({ broker, identifyCaller, audit }) => {
  const router = new Router();
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
