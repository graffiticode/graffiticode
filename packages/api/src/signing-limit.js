// The per-client limit on system preview signing (plan: system preview
// signing rate limits, design point 2). Anyone can have Graffiticode's system
// preview session sign an L0176 preview, anonymously, through POST /compile,
// GET /data or POST /preview/sign. This bounds how fast one client can.
//
// The unit is a signing stage, charged before dispatch: every L0176 stage of
// every requested item (each POST /compile item, each GET /data id, each
// /preview/sign call) that runs with no connection and no publication. Batches
// sum and repeated stages each count. L0176 stages always dispatch (a
// protected chain bypasses the compile cache, and L0176 answers `cache:
// false`), so nothing is discounted for a cached result. Broker lets one
// stage's session sign at most SYSTEM_SESSION_MAX_SIGNINGS times, so a quota
// of Q stages a minute allows up to Q x that many signatures a minute.
//
// A token bucket per client, per instance, in memory: approximate by design
// (N instances allow about N times as much). A request is charged all or
// nothing, so a refused batch dispatches none of its stages.
//
// The client is its address, never a header it could forge:
//   - through our Cloudflare zone, CF-Connecting-IP, but only when the request
//     carries X-Graffiticode-Edge with the exact EDGE_AUTH_SECRET (set by our
//     zone's Transform Rule; unset secret = never trusted);
//   - otherwise, the address Google's front end observed: Cloud Run appends its
//     TCP peer as the LAST X-Forwarded-For entry, so that entry is the only one
//     a client can't write (earlier entries are the client's own). Express's
//     `trust proxy` is not used;
//   - with no X-Forwarded-For (local runs), the socket's peer address.
import { timingSafeEqual, createHash } from "node:crypto";
import { HttpError } from "./errors/http.js";
import { normalizeLang } from "./admission.js";
import { noAudit } from "./audit.js";

export const SIGNING_LANG = "0176";
export const BUSY_MESSAGE = "Previews are busy right now; try again in a moment.";
export const EDGE_HEADER = "X-Graffiticode-Edge";

// A stage that L0176 would sign under the system preview session.
export const isSigningLang = lang => normalizeLang(lang) === SIGNING_LANG;
export const countSigningStages = tasks => (Array.isArray(tasks) ? tasks.filter(t => isSigningLang(t?.lang)).length : 0);

export class SigningRateLimited extends HttpError {
  constructor({ retryAfter, message = BUSY_MESSAGE }) {
    super({ code: 429, message, reason: "rate-limited", retryAfter });
  }
}

const positiveNumber = (value, fallback, name) => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, not ${value}`);
  return n;
};

export const parseSigningLimitConfig = (env = process.env) => ({
  ratePerMinute: positiveNumber(env.SYSTEM_SIGNING_STAGES_PER_CLIENT_PER_MINUTE, 10, "SYSTEM_SIGNING_STAGES_PER_CLIENT_PER_MINUTE"),
  burst: positiveNumber(env.SYSTEM_SIGNING_STAGES_BURST, 10, "SYSTEM_SIGNING_STAGES_BURST"),
  edgeSecret: typeof env.EDGE_AUTH_SECRET === "string" && env.EDGE_AUTH_SECRET.trim() ? env.EDGE_AUTH_SECRET.trim() : null,
});

// Constant-time, over digests so differing lengths leak nothing either.
const digest = value => createHash("sha256").update(String(value)).digest();
const sameSecret = (given, secret) => typeof given === "string" && timingSafeEqual(digest(given), digest(secret));

const ADDRESS_RE = /^[0-9A-Fa-f:.]{2,45}$/;
const address = value => {
  const s = typeof value === "string" ? value.trim() : "";
  return ADDRESS_RE.test(s) ? s : null;
};

export const buildClientKey = ({ edgeSecret = null } = {}) => req => {
  const header = name => {
    const v = req.headers?.[name.toLowerCase()];
    return Array.isArray(v) ? v.join(",") : v;
  };
  if (edgeSecret && sameSecret(header(EDGE_HEADER), edgeSecret)) {
    const cf = address(header("CF-Connecting-IP"));
    if (cf) return `cf:${cf}`;
  }
  const xff = header("X-Forwarded-For");
  if (typeof xff === "string" && xff.trim()) {
    const entries = xff.split(",");
    const last = address(entries[entries.length - 1]);
    // A malformed last entry can't have come from Google's front end; it
    // shares one bucket rather than letting a client choose its own.
    return last ? `ip:${last}` : "ip:unknown";
  }
  return `ip:${address(req.socket?.remoteAddress) ?? "unknown"}`;
};

// `charge(req, stages)`: throws SigningRateLimited (429) when the client's
// bucket can't cover all `stages`, charging nothing; otherwise takes them.
export const buildSigningLimiter = ({
  ratePerMinute = 10, burst = 10, edgeSecret = null, audit = noAudit, now = Date.now, maxClients = 10000,
} = {}) => {
  const clientKey = buildClientKey({ edgeSecret });
  const buckets = new Map();
  const perMs = ratePerMinute / 60000;
  const level = (bucket, t) => Math.min(burst, bucket.tokens + (t - bucket.at) * perMs);
  // Bounded memory: forget full buckets first (forgetting one changes
  // nothing), then the oldest.
  const prune = t => {
    for (const [key, bucket] of buckets) {
      if (buckets.size <= maxClients) return;
      if (level(bucket, t) >= burst) buckets.delete(key);
    }
    for (const key of buckets.keys()) {
      if (buckets.size <= maxClients) return;
      buckets.delete(key);
    }
  };
  const charge = async (req, stages) => {
    if (!(stages > 0)) return;
    const t = now();
    const key = clientKey(req);
    const bucket = buckets.get(key) ?? { tokens: burst, at: t };
    const tokens = level(bucket, t);
    if (tokens >= stages) {
      buckets.delete(key);
      buckets.set(key, { tokens: tokens - stages, at: t });
      if (buckets.size > maxClients) prune(t);
      return;
    }
    // A request with more stages than the burst can never be covered.
    const retryAfter = Math.max(1, Math.ceil((Math.min(stages, burst) - tokens) / perMs / 1000));
    await audit({ event: "system-signing-limit", outcome: "denied", reason: "rate-limited", category: "unavailable", service: "api", lang: SIGNING_LANG });
    throw new SigningRateLimited({
      retryAfter,
      message: stages > burst ? `${BUSY_MESSAGE} (this request has ${stages} signing stages; at most ${burst} are allowed at once)` : BUSY_MESSAGE,
    });
  };
  return { charge, clientKey, size: () => buckets.size };
};
