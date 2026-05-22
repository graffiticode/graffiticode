/* eslint-disable camelcase */
import { NotFoundError } from "@graffiticode/common/errors";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/http";
import { Router } from "express";
import { requireInternalAuth } from "../middleware/internal-auth.js";

/**
 * Generic router for ephemeral OAuth flow records (clients, pending auths,
 * authorization codes), keyed by id and backed by a buildOAuthFlowStorer
 * instance. Used to persist OAuth state that would otherwise live in a single
 * MCP-server process's memory and not survive multiple instances / restarts.
 *
 * All routes require internal API key authentication.
 *
 *   PUT    /:key   store/overwrite the record (body = record)        -> { record }
 *   GET    /:key   fetch the record (404 if missing or expired)      -> { record }
 *   PATCH  /:key   partial update (404 if missing)                   -> { record }
 *   DELETE /:key   delete the record (idempotent)                    -> {}
 */
export const buildOAuthFlowRouter = (storer) => {
  const router = new Router();

  router.use(requireInternalAuth);

  router.put("/:key", buildHttpHandler(async (req, res) => {
    const { key } = req.params;
    const record = await storer.put(key, req.body || {});
    sendSuccessResponse(res, { record });
  }));

  router.get("/:key", buildHttpHandler(async (req, res) => {
    const { key } = req.params;
    const record = await storer.get(key);
    if (!record) {
      throw new NotFoundError("Record not found");
    }
    sendSuccessResponse(res, { record });
  }));

  router.patch("/:key", buildHttpHandler(async (req, res) => {
    const { key } = req.params;
    const record = await storer.patch(key, req.body || {});
    if (!record) {
      throw new NotFoundError("Record not found");
    }
    sendSuccessResponse(res, { record });
  }));

  router.delete("/:key", buildHttpHandler(async (req, res) => {
    const { key } = req.params;
    await storer.remove(key);
    sendSuccessResponse(res, {});
  }));

  return router;
};
