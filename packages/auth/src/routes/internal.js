// Internal routes called by Graffiticode services, not by users.
//
// POST /internal/act-as {purpose, uid, subject, grant}
//
// Issues a short-lived token for `uid` to a worker that runs that user's work
// without them present: the console's generation worker, and the effects that
// follow a generation (capability plan, app tier Phase 3.5). Two independent
// checks, both required:
//   1. Caller identity: X-Caller-Identity is a Google-signed ID token for the
//      caller's Cloud Run service account, audience ACT_AS_AUDIENCE, and that
//      account is in ACT_AS_CALLERS. The shared X-Internal-API-Key is NOT
//      accepted here: other services hold it, so it can't name one caller.
//      auth is a public service, so this verified token is the only identity
//      gate (there is no Cloud Run IAM in front of it).
//   2. A job-bound grant (@graffiticode/common/act-as), signed with
//      ACT_AS_GRANT_SECRET when the work was reserved, for exactly this
//      purpose, uid and subject, and not expired.
// The token is the auth service's own 5-minute access token (what
// /oauth/verify accepts), carrying an `act` claim that marks it as delegated.
// Every request is audited, accepted or refused.

import { Router } from "express";
import { buildHttpHandler, sendSuccessResponse } from "@graffiticode/common/http";
import { InvalidArgumentError, UnauthorizedError, UnavailableError } from "@graffiticode/common/errors";
import { ACT_AS_PURPOSES, ActAsGrantError, verifyActAsGrant } from "@graffiticode/common/act-as";

const MAX_FIELD = 512;
const isField = v => typeof v === "string" && v.length > 0 && v.length <= MAX_FIELD;

const buildActAs = ({ actAs, authService }) => async (req, res) => {
  if (!actAs) throw new UnavailableError("act-as is not configured");
  const { identifyCaller, grantSecret, audit, pseudonymize, now } = actAs;
  const body = req.body ?? {};
  const record = {
    event: "act-as",
    purpose: ACT_AS_PURPOSES.includes(body.purpose) ? body.purpose : null,
    uid: isField(body.uid) ? pseudonymize(body.uid) : null,
  };

  let caller;
  try {
    caller = await identifyCaller(req);
  } catch (err) {
    audit({ ...record, outcome: "denied", reason: "caller-rejected" });
    throw err;
  }
  record.caller = caller.email;

  const { purpose, uid, subject, grant } = body;
  if (!ACT_AS_PURPOSES.includes(purpose) || !isField(uid) || !isField(subject) || !isField(grant)) {
    audit({ ...record, outcome: "denied", reason: "bad-request" });
    throw new InvalidArgumentError("act-as needs purpose, uid, subject and grant");
  }

  try {
    verifyActAsGrant(grantSecret, grant, { purpose, uid, subject }, now());
  } catch (err) {
    if (!(err instanceof ActAsGrantError)) throw err;
    audit({ ...record, outcome: "denied", reason: `grant-${err.reason}` });
    throw new UnauthorizedError(`act-as grant refused: ${err.reason}`);
  }

  const accessToken = await authService.createAccessToken({
    uid,
    additionalClaims: { act: { sub: caller.email, purpose, subject } },
  });
  audit({ ...record, outcome: "allowed" });
  sendSuccessResponse(res, { accessToken, expiresIn: 300 });
};

export const buildInternalRouter = ({ actAs = null, authService }) => {
  const router = Router();
  router.post("/act-as", buildHttpHandler(buildActAs({ actAs, authService })));
  return router;
};
