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
import {
  EMAIL_SEARCH_MAX_RESULTS as SEARCH_MAX_RESULTS,
  EMAIL_SEARCH_MIN_LENGTH as SEARCH_MIN_LENGTH,
} from "../services/linked-emails.js";

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

// The email arrives in the body (POST): an email in a URL lands in the request
// logs. The GET form remains until its callers move to POST.
const buildLookupInternal = ({ linkedEmailsService }, emailOf = req => req.body?.email) => buildHttpHandler(async (req, res) => {
  const email = typeof emailOf(req) === "string" ? emailOf(req) : "";
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

// Partial-match search for account typeahead: uids whose linked email contains
// the fragment. The fragment travels in the body (never the URL, which lands in
// request logs), and the response carries uids only — never an email.
const buildSearchInternal = ({ linkedEmailsService }) => buildHttpHandler(async (req, res) => {
  const raw = req.body?.fragment;
  const fragment = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (fragment.length < SEARCH_MIN_LENGTH) {
    throw new InvalidArgumentError(`fragment must be at least ${SEARCH_MIN_LENGTH} characters`);
  }
  const found = await linkedEmailsService.search({ fragment });
  const uids = [...new Set((found || []).filter(uid => typeof uid === "string"))].slice(0, SEARCH_MAX_RESULTS);
  sendSuccessResponse(res, { uids });
});

// Combined lookup + custom-token mint, used by the console's email-signin
// resolver. The console can't mint Firebase custom tokens itself: its admin
// SDK runs in a different project than the one the client signs into, and
// the Cloud Run service account lacks signBlob permissions anyway. Doing it
// here keeps the token in the same project as the client's Firebase Auth.
const buildSignInInternal = ({ authService, linkedEmailsService }) => buildHttpHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!isNonEmptyString(email)) {
    throw new InvalidArgumentError("must provide email");
  }
  const record = await linkedEmailsService.lookup({ email });
  if (!record) {
    sendSuccessResponse(res, { matched: false });
    return;
  }
  const firebaseCustomToken = await authService.createFirebaseCustomToken({ uid: record.uid });
  sendSuccessResponse(res, { matched: true, uid: record.uid, firebaseCustomToken });
});

export const buildLinkedEmailsRouter = (deps) => {
  const router = new Router();

  // User-facing routes (Firebase / refresh-token bearer auth required).
  router.get("/", buildList(deps));
  router.delete("/:id", buildDelete(deps));

  // Server-to-server routes (X-Internal-API-Key required).
  router.post("/internal", requireInternalAuth, buildAddInternal(deps));
  router.post("/internal/lookup", requireInternalAuth, buildLookupInternal(deps));
  // Deprecated: the email travels in the URL. Remove once callers use POST.
  router.get("/internal/lookup", requireInternalAuth, buildLookupInternal(deps, req => req.query.email));
  router.post("/internal/search", requireInternalAuth, buildSearchInternal(deps));
  router.post("/internal/sign-in", requireInternalAuth, buildSignInInternal(deps));

  return router;
};
