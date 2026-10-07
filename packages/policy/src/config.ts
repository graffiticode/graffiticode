// Service configuration shared by policy and the broker, parsed strictly at
// startup: a missing or malformed setting stops the service rather than
// running it with a weaker default.

import { OPERATIONS, isGatedFunction, gatedOperations } from "@graffiticode/common/protected-registry";

export const requireEnv = (env, name) => {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

const ROLES = new Set(["broker", "compiler", "console", "gateway", "policy"]);

// CALLERS: JSON object mapping a service-account email to its role, e.g.
//   {"l0176-run@graffiticode.iam.gserviceaccount.com": {"role": "compiler", "lang": "0176"},
//    "console-run@graffiticode-app.iam.gserviceaccount.com": {"role": "console"},
//    "broker-run@graffiticode.iam.gserviceaccount.com": {"role": "broker"}}
// A broker may only ask authorize-execution (app.js ROUTE_ROLES).
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
  const callers: Record<string, { role: string, lang?: string }> = {};
  for (const [email, spec] of Object.entries(parsed as Record<string, { role?: string, lang?: string } | null>)) {
    if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(email)) {
      throw new Error(`CALLERS: ${email} is not a service account`);
    }
    if (!spec || !ROLES.has(spec.role)) {
      throw new Error(`CALLERS: ${email} has an unknown role`);
    }
    if (spec.role === "compiler" && !/^\d{4}$/.test(spec.lang as string)) {
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
const SYSTEM_BACKENDS = new Set<string>(Object.values(OPERATIONS).map(op => op.backend));
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
export { auditSink } from "./audit.js";

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

// POLICY_ENABLED_GATED_FUNCTIONS (optional): JSON array of "<lang>:<fn>" naming
// enablement-gated registry functions this deployment allows (spec AUTHOR-01),
// e.g. ["0176:author"]. Absent or empty enables none, the production setting
// until provider evidence is recorded. Anything malformed, unknown or not gated
// stops the service.
export const parseEnabledGatedFunctions = json => {
  const fail = why => { throw new Error(`POLICY_ENABLED_GATED_FUNCTIONS ${why}`); };
  if (json === undefined || json === null || String(json).trim() === "") return Object.freeze(new Set());
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail("must be JSON");
  }
  if (!Array.isArray(parsed)) fail("must be an array");
  const out = new Set();
  for (const entry of parsed) {
    const m = typeof entry === "string" ? /^L?(\d{1,4}):([a-z][a-z0-9-]*)$/i.exec(entry) : null;
    if (!m) fail(`entry ${JSON.stringify(entry)} must be "<lang>:<fn>"`);
    const lang = m[1].padStart(4, "0");
    if (!isGatedFunction(lang, m[2])) fail(`entry ${entry} is not an enablement-gated registry function`);
    out.add(`${lang}:${m[2]}`);
  }
  return Object.freeze(out);
};

// BROKER_ENABLED_GATED_OPERATIONS (optional): JSON array of operation names
// that only enablement-gated functions use, which this broker may execute
// (spec AUTHOR-01), e.g. ["learnosity.sign-author"]. Absent or empty enables
// none, the production setting until provider evidence is recorded. Anything
// malformed or not a gated operation stops the service.
export const parseEnabledGatedOperations = json => {
  const fail = why => { throw new Error(`BROKER_ENABLED_GATED_OPERATIONS ${why}`); };
  if (json === undefined || json === null || String(json).trim() === "") return Object.freeze(new Set());
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail("must be JSON");
  }
  if (!Array.isArray(parsed)) fail("must be an array");
  const gated = gatedOperations();
  for (const op of parsed) {
    if (typeof op !== "string" || !gated.has(op)) fail(`entry ${JSON.stringify(op)} is not an enablement-gated operation`);
  }
  return Object.freeze(new Set(parsed));
};

// The lowest admission/execution contract version accepted (W4): 1 (the
// default) until the cutover sets 2. Anything else refuses to start.
export const parseMinContractVersion = (value?: string) => {
  if (value === undefined || value === "") return 1;
  if (value === "1" || value === "2") return Number(value);
  throw new Error(`POLICY_MIN_CONTRACT_VERSION must be 1 or 2, not ${value}`);
};
