// Configuration for POST /internal/act-as (routes/internal.js), from the
// environment. Returns null — and the route answers 503 — unless all of it is
// present, so the endpoint can ship before its secrets exist.
//
//   ACT_AS_CALLERS          JSON map of allowed caller service accounts:
//                           {"console-run@graffiticode-app.iam.gserviceaccount.com": {"role": "console"}}
//   ACT_AS_GRANT_SECRET     HMAC secret shared with the app-tier producers (>= 32 chars)
//   AUDIT_PSEUDONYM_SECRET  HMAC secret for audit pseudonyms (same as policy's)
//   ACT_AS_AUDIENCE         caller-identity audience (default urn:graffiticode:auth)

import { createHmac } from "node:crypto";
import { createCallerIdentity, buildGoogleIdTokenVerifier } from "@graffiticode/common/caller";

const SERVICE_ACCOUNT = /^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/;

export const parseActAsCallers = raw => {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ACT_AS_CALLERS must be a JSON object");
  }
  const callers = {};
  for (const [email, value] of Object.entries(parsed)) {
    if (!SERVICE_ACCOUNT.test(email)) throw new Error(`ACT_AS_CALLERS: ${email} is not a service account`);
    callers[email] = Object.freeze({ role: String(value?.role ?? "") });
  }
  return Object.freeze(callers);
};

// Same algorithm as policy's audit pseudonyms, so the two join.
export const createPseudonymizer = ({ secret }) => {
  if (typeof secret !== "string" || secret.length < 16) throw new Error("audit pseudonym secret too short");
  return value => (value == null ? null : createHmac("sha256", secret).update(String(value)).digest("hex").slice(0, 24));
};

// One JSON line per decision, picked up by Cloud Logging as security_audit.
export const auditSink = record => {
  console.log(JSON.stringify({ logName: "security_audit", service: "auth", at: new Date().toISOString(), ...record }));
};

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ OAuth2Client: any, audit?: (record: object) => void, now?: () => number }} deps
 */
export const buildActAsConfig = (env, { OAuth2Client, audit = auditSink, now = () => Date.now() }) => {
  const { ACT_AS_CALLERS, ACT_AS_GRANT_SECRET, AUDIT_PSEUDONYM_SECRET } = env;
  if (!ACT_AS_CALLERS || !ACT_AS_GRANT_SECRET || !AUDIT_PSEUDONYM_SECRET) {
    console.warn("act-as: not configured (ACT_AS_CALLERS, ACT_AS_GRANT_SECRET, AUDIT_PSEUDONYM_SECRET); /internal/act-as answers 503");
    return null;
  }
  if (ACT_AS_GRANT_SECRET.length < 32) throw new Error("ACT_AS_GRANT_SECRET must be at least 32 characters");
  return {
    identifyCaller: createCallerIdentity({
      verifyIdToken: buildGoogleIdTokenVerifier({ OAuth2Client }),
      audience: env.ACT_AS_AUDIENCE || "urn:graffiticode:auth",
      callers: parseActAsCallers(ACT_AS_CALLERS),
      // auth is public: no Cloud Run IAM, no forwarded X-Serverless-Authorization.
      requireServerlessMatch: false,
    }),
    grantSecret: ACT_AS_GRANT_SECRET,
    pseudonymize: createPseudonymizer({ secret: AUDIT_PSEUDONYM_SECRET }),
    audit,
    now,
  };
};
