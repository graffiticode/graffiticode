// Service configuration shared by policy and the broker, parsed strictly at
// startup: a missing or malformed setting stops the service rather than
// running it with a weaker default.

import { OPERATIONS } from "@graffiticode/common/protected-registry";

export const requireEnv = (env, name) => {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

const ROLES = new Set(["compiler", "console", "gateway", "policy"]);

// CALLERS: JSON object mapping a service-account email to its role, e.g.
//   {"l0176-run@graffiticode.iam.gserviceaccount.com": {"role": "compiler", "lang": "0176"},
//    "console-run@graffiticode-app.iam.gserviceaccount.com": {"role": "console"}}
export const parseCallers = json => {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("CALLERS must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CALLERS must be an object");
  }
  const callers = {};
  for (const [email, spec] of Object.entries(parsed)) {
    if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(email)) {
      throw new Error(`CALLERS: ${email} is not a service account`);
    }
    if (!spec || !ROLES.has(spec.role)) {
      throw new Error(`CALLERS: ${email} has an unknown role`);
    }
    if (spec.role === "compiler" && !/^\d{4}$/.test(spec.lang)) {
      throw new Error(`CALLERS: compiler ${email} needs a four-digit lang`);
    }
    callers[email] = spec.role === "compiler" ? { role: "compiler", lang: spec.lang } : { role: spec.role };
  }
  return Object.freeze(callers);
};

// POLICY_SYSTEM_CONNECTIONS (optional): JSON object mapping a connection
// backend to the Graffiticode-owned connection that signs previews for
// compiles with no user connection (POST /v1/preview-session), e.g.
//   {"learnosity": "conn-0123"}
// Absent or empty means no system connections. Anything malformed stops the
// service: a non-object, a backend the registry does not know, or an id
// policy would never accept.
const SYSTEM_BACKENDS = new Set(Object.values(OPERATIONS).map(op => op.backend));
const CONNECTION_ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;

export const parseSystemConnections = json => {
  if (json === undefined || json === null || String(json).trim() === "") {
    return Object.freeze({});
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("POLICY_SYSTEM_CONNECTIONS must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("POLICY_SYSTEM_CONNECTIONS must be an object");
  }
  const out = {};
  for (const [backend, connectionId] of Object.entries(parsed)) {
    // @ts-expect-error TS-MIGRATE: registry backends inferred as literal types
    if (!SYSTEM_BACKENDS.has(backend)) {
      throw new Error(`POLICY_SYSTEM_CONNECTIONS: ${backend} is not a known backend`);
    }
    if (typeof connectionId !== "string" || !CONNECTION_ID_RE.test(connectionId)) {
      throw new Error(`POLICY_SYSTEM_CONNECTIONS: ${backend} needs a connection id`);
    }
    out[backend] = connectionId;
  }
  return Object.freeze(out);
};

// Security audit records go to stdout as one JSON line each, tagged so a Cloud
// Logging sink can route them to the separately governed audit store.
export const auditSink = record => {
  console.log(JSON.stringify({ logName: "security_audit", ...record }));
};

// Google ID tokens for this service's own account, for any audience (a
// service URL for Cloud Run IAM, or a URN for caller identity). One client per
// audience; google-auth-library caches and refreshes the tokens.
export const createIdTokenSource = ({ GoogleAuth }) => {
  const auth = new GoogleAuth();
  const clients = new Map();
  return async audience => {
    if (!clients.has(audience)) clients.set(audience, auth.getIdTokenClient(audience));
    const client = await clients.get(audience);
    const headers = await client.getRequestHeaders();
    const value = headers.Authorization ?? headers.authorization;
    if (typeof value !== "string") throw new Error("no ID token");
    return value.replace(/^Bearer\s+/, "");
  };
};
