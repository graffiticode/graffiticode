import {
  ConflictError,
  InvalidArgumentError,
  NotFoundError,
  UnauthorizedError,
} from "@graffiticode/common/errors";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/http";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { Router } from "express";

import { requireInternalAuth } from "../middleware/internal-auth.js";

const requireUser = (req) => {
  if (!req.auth) {
    throw new UnauthorizedError();
  }
  if (req.auth.token?.apiKey) {
    throw new UnauthorizedError("Cannot manage linked emails with API key");
  }
  return req.auth.uid;
};

const formatRecord = (record) => ({
  id: record.id,
  email: record.email,
  createdAt: record.createdAt,
  verifiedAt: record.verifiedAt,
});

const buildList = ({ linkedEmailsService }) => buildHttpHandler(async (req, res) => {
  const uid = requireUser(req);
  const records = await linkedEmailsService.list({ uid });
  sendSuccessResponse(res, { emails: records.map(formatRecord) });
});

const buildDelete = ({ linkedEmailsService }) => buildHttpHandler(async (req, res) => {
  const uid = requireUser(req);
  const { id } = req.params;
  if (!isNonEmptyString(id)) {
    throw new InvalidArgumentError("must provide id");
  }
  try {
    await linkedEmailsService.remove({ uid, id });
  } catch (err) {
    // Translate "row exists but belongs to another uid" → 404 to avoid
    // revealing the owning uid through this endpoint.
    if (err instanceof NotFoundError) {
      throw err;
    }
    throw err;
  }
  sendSuccessResponse(res, {});
});

const buildAddInternal = ({ linkedEmailsService }) => buildHttpHandler(async (req, res) => {
  const { uid, email, verifiedAt } = req.body || {};
  if (!isNonEmptyString(uid)) {
    throw new InvalidArgumentError("must provide uid");
  }
  if (!isNonEmptyString(email)) {
    throw new InvalidArgumentError("must provide email");
  }
  try {
    const record = await linkedEmailsService.addVerified({
      uid,
      email,
      verifiedAt: verifiedAt ? new Date(verifiedAt) : undefined,
    });
    sendSuccessResponse(res, formatRecord(record));
  } catch (err) {
    if (err instanceof ConflictError) {
      throw err;
    }
    throw err;
  }
});

const buildLookupInternal = ({ linkedEmailsService }) => buildHttpHandler(async (req, res) => {
  const email = typeof req.query.email === "string" ? req.query.email : "";
  if (!isNonEmptyString(email)) {
    throw new InvalidArgumentError("must provide email");
  }
  const record = await linkedEmailsService.lookup({ email });
  if (!record) {
    sendSuccessResponse(res, { matched: false });
    return;
  }
  sendSuccessResponse(res, { matched: true, uid: record.uid, id: record.id });
});

export const buildLinkedEmailsRouter = (deps) => {
  const router = new Router();

  // User-facing routes (Firebase / refresh-token bearer auth required).
  router.get("/", buildList(deps));
  router.delete("/:id", buildDelete(deps));

  // Server-to-server routes (X-Internal-API-Key required).
  router.post("/internal", requireInternalAuth, buildAddInternal(deps));
  router.get("/internal/lookup", requireInternalAuth, buildLookupInternal(deps));

  return router;
};
