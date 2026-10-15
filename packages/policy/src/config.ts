// Service configuration shared by policy and the broker, parsed strictly at
// startup: a missing or malformed setting stops the service rather than
// running it with a weaker default.

import { OPERATIONS } from "@graffiticode/common/protected-registry";
import { DEFAULT_SYSTEM_SIGNING } from "./rate-limit.js";

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

// Settings that registry v7 removed with Author signing (AUTHOR-01, closed by
// removal): POLICY_ENABLED_GATED_FUNCTIONS and BROKER_ENABLED_GATED_OPERATIONS
// once enabled `0176:author` / `learnosity.sign-author`. Nothing is gated now,
// so a deployment still setting one is misconfigured: it stops the service
// rather than appear to enable something.
export const REMOVED_SETTINGS = Object.freeze(["POLICY_ENABLED_GATED_FUNCTIONS", "BROKER_ENABLED_GATED_OPERATIONS"]);
export const refuseRemovedSettings = env => {
  const set = REMOVED_SETTINGS.filter(name => env[name] !== undefined && String(env[name]).trim() !== "");
  if (set.length) throw new Error(`${set.join(", ")} no longer exist (registry v7 removed Author signing); unset them`);
};

// A positive integer setting, at most `max`, or `fallback` when unset.
// Anything else (a fraction, zero, a negative, text, an absurd value) stops
// the service. Shared with Broker (SYSTEM_SESSION_MAX_SIGNINGS).
export const parsePositiveInt = (env, name: string, fallback: number, max: number) => {
  const value = env[name];
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const text = String(value).trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n <= 0 || n > max) {
    throw new Error(`${name} must be a whole number from 1 to ${max}, not ${JSON.stringify(value)}`);
  }
  return n;
};

// The per-instance bucket on system preview signing (rate-limit.js):
// SYSTEM_SIGNINGS_PER_MINUTE (default 120) and SYSTEM_SIGNINGS_BURST
// (default 60).
export const parseSystemSigningLimits = env => Object.freeze({
  perMinute: parsePositiveInt(env, "SYSTEM_SIGNINGS_PER_MINUTE", DEFAULT_SYSTEM_SIGNING.perMinute, 100_000),
  burst: parsePositiveInt(env, "SYSTEM_SIGNINGS_BURST", DEFAULT_SYSTEM_SIGNING.burst, 100_000),
});

// The lowest admission/execution contract version accepted (W4): 1 (the
// default) until the cutover sets 2. Anything else refuses to start.
export const parseMinContractVersion = (value?: string, name = "POLICY_MIN_CONTRACT_VERSION") => {
  if (value === undefined || value === "") return 1;
  if (value === "1" || value === "2") return Number(value);
  throw new Error(`${name} must be 1 or 2, not ${value}`);
};
