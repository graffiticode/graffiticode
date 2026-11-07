// Broker HTTP route. The caller comes only from X-Caller-Identity (see
// @graffiticode/policy caller.js); the execution token rides in Authorization.
//
//   POST   /v1/execute          compiler  { op, payload }  -> { status, result?, steps?, replayed?, error? }
//   POST   /v1/secrets/:conn    policy    { ownerUid, backend, key, secret }  store a new connection's credential
//   PUT    /v1/secrets/:conn    policy    { ownerUid, backend, key, secret }  rotate it (same owner, backend, key)
//   DELETE /v1/secrets/:conn    policy    delete it; the id is never reused
//   GET    /v1/protected-execution  anyone  { enabled, source } (@graffiticode/policy maintenance.js)
//   POST   /v1/receipts         policy    { invocationId, operationIds? }  read recorded receipts (B5 settlement)
//
// A refusal carries only its reason — never the token, payload or credential.

import { ReconcileRefused } from "./reconcile.js";
import { ReceiptReadRefused } from "./receipts-read.js";
import { Router } from "express";
import { buildHttpHandler, createHttpApp, sendSuccessResponse, parseTokenFromRequest } from "@graffiticode/common/http";
import { InvalidArgumentError, UnauthenticatedError, UnauthorizedError } from "@graffiticode/common/errors";
import { classify } from "@graffiticode/common/failures";
import { requestContextMiddleware } from "@graffiticode/policy";
import { BrokerRefused } from "./broker.js";

const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const createBrokerApp = ({ broker, secrets, identifyCaller, audit, reconcile = null, readReceipts = null }) => {
  // express's Router is callable; its types reject `new`, which works.
  const router = new (Router as unknown as new () => ReturnType<typeof Router>)();
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
  const credentialFrom = body => {
    const { ownerUid, backend, key, secret } = body ?? {};
    if (![ownerUid, backend, key, secret].every(v => typeof v === "string" && v)) {
      throw new InvalidArgumentError("ownerUid, backend, key and secret are required");
    }
    return { ownerUid, backend, key, secret };
  };
  router.post("/secrets/:conn", provision(async req => {
    await secrets.create(req.params.conn, credentialFrom(req.body));
  }));
  router.put("/secrets/:conn", provision(async req => {
    await secrets.rotate(req.params.conn, credentialFrom(req.body));
  }));
  router.delete("/secrets/:conn", provision(async req => {
    await secrets.delete(req.params.conn);
  }));
  router.get("/protected-execution", buildHttpHandler(async (req, res) => {
    res.status(200).json(await broker.protectedExecution());
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
        // The category is the underlying reason's (a wrapped Policy reason
        // keeps its own); an unknown one is unavailable, audited without it.
        // (Broker itself audits the refusal, an unknown reason as
        // `unclassified-reason`; see broker.js recordedReason.)
        const { category } = classify(err.reason);
        res.status(err.status).json({
          status: "error",
          error: { code: err.status, message: "broker refused", reason: err.reason, category, detail: err.detail },
          data: null,
        });
        return;
      }
      throw err;
    }
  }));
  // Reconciliation (WRITE-02, W5): Policy only, once it has decided the asking
  // user may. Reads the provider for evidence and appends what it found;
  // never writes to the provider or re-executes.
  router.post("/reconcile", buildHttpHandler(async (req, res) => {
    let caller;
    try {
      caller = await identifyCaller(req);
    } catch (err) {
      await audit({ event: "reconcile", outcome: "denied", reason: "caller-rejected" });
      throw err;
    }
    if (caller.role !== "policy") {
      await audit({ event: "reconcile", outcome: "denied", reason: "route-not-allowed-for-caller" });
      throw new UnauthorizedError("route not allowed for this caller");
    }
    const { connectionId, invocationId, decisionId } = req.body ?? {};
    if (!CONNECTION_ID_RE.test(connectionId ?? "") || !/^inv-[A-Za-z0-9-]{1,64}$/.test(invocationId ?? "") || !/^[A-Za-z0-9-]{8,64}$/.test(decisionId ?? "")) {
      throw new InvalidArgumentError("connectionId, invocationId and decisionId are required");
    }
    if (!reconcile) throw new Error("reconciliation is not configured");
    try {
      sendSuccessResponse(res, await reconcile({ connectionId, invocationId, decisionId }));
    } catch (err) {
      if (err instanceof ReconcileRefused) {
        res.status(err.status).json({ status: "error", error: { code: err.status, message: "reconcile refused", reason: err.reason, category: classify(err.reason).category }, data: null });
        return;
      }
      throw err;
    }
  }));
  // Receipt reads (B5 settlement, docs/b5-commands-plan.md §7): Policy only.
  // Reads what was recorded; takes no token, reads no credential, calls no
  // provider, so it can never dispatch an effect.
  router.post("/receipts", buildHttpHandler(async (req, res) => {
    let caller;
    try {
      caller = await identifyCaller(req);
    } catch (err) {
      await audit({ event: "receipts", outcome: "denied", reason: "caller-rejected" });
      throw err;
    }
    if (caller.role !== "policy") {
      await audit({ event: "receipts", outcome: "denied", reason: "route-not-allowed-for-caller" });
      throw new UnauthorizedError("route not allowed for this caller");
    }
    // Any token is refused: this route acts on no one's authority but Policy's.
    if (parseTokenFromRequest(req)) {
      await audit({ event: "receipts", outcome: "denied", reason: "token-not-accepted" });
      throw new InvalidArgumentError("receipt reads take no token");
    }
    if (!readReceipts) throw new Error("receipt reads are not configured");
    const { invocationId, operationIds } = req.body ?? {};
    try {
      const read = await readReceipts({ invocationId, operationIds });
      await audit({ event: "receipts", invocationId, outcome: "allowed", count: read.operations.length });
      sendSuccessResponse(res, read);
    } catch (err) {
      if (err instanceof ReceiptReadRefused) {
        await audit({ event: "receipts", outcome: "denied", reason: err.reason });
        res.status(err.status).json({ status: "error", error: { code: err.status, message: "receipt read refused", reason: err.reason, category: "malformed" }, data: null });
        return;
      }
      throw err;
    }
  }));
  // Every record written while handling a request names it (policy audit.js).
  return createHttpApp(app => app.use("/v1", requestContextMiddleware, router));
};
