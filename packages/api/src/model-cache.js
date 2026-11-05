// A small in-memory cache of interpreted stages' models (interpreter plan B3; the B5 gate's
// latency). A model is a pure function of its language's program, options, route and the
// producer's generation, so recompiling it on every request (a stage-cache hit included) only
// adds a round trip to the language's service. Entries are kept per api instance, for `ttlMs`,
// at most `max` of them (oldest dropped first).
//
// What is cached is the model call's reply, `{ model, revision }`. The revision names the
// service that compiled it and keys the stage cache. After a deploy it can be stale for up to
// `ttlMs`: an interpreted reply that names another revision drops the entry (data.js), and a
// stage-cache hit keyed by the previous revision is still the current generation's result,
// since a change in meaning always moves the generation.
import { canonicalDigest } from "@graffiticode/common/canonical";

export const MODEL_CACHE_DEFAULTS = Object.freeze({ ttlMs: 10 * 60 * 1000, max: 5000 });

export const modelCacheKey = ({ lang, code, options, baseUrl, generation }) =>
  canonicalDigest({ lang, code, options: options ?? {}, baseUrl: baseUrl ?? null, generation: generation ?? null });

export const buildModelCache = ({ ttlMs = MODEL_CACHE_DEFAULTS.ttlMs, max = MODEL_CACHE_DEFAULTS.max, now = Date.now } = {}) => {
  const entries = new Map();
  return {
    get: key => {
      const entry = entries.get(key);
      if (!entry) return null;
      if (now() - entry.at > ttlMs) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    put: (key, value) => {
      entries.delete(key);
      entries.set(key, { value, at: now() });
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
    drop: key => entries.delete(key),
    get size() {
      return entries.size;
    },
  };
};

// The cache's settings from the environment: MODEL_CACHE_TTL_MS (0 turns it off) and
// MODEL_CACHE_MAX.
export const parseModelCacheConfig = (env = process.env) => {
  const ttl = env.MODEL_CACHE_TTL_MS === undefined ? MODEL_CACHE_DEFAULTS.ttlMs : Number(env.MODEL_CACHE_TTL_MS);
  const max = env.MODEL_CACHE_MAX === undefined ? MODEL_CACHE_DEFAULTS.max : Number(env.MODEL_CACHE_MAX);
  if (!Number.isFinite(ttl) || ttl < 0) throw new Error("MODEL_CACHE_TTL_MS must be a non-negative number");
  if (!Number.isInteger(max) || max < 1) throw new Error("MODEL_CACHE_MAX must be a positive integer");
  return { enabled: ttl > 0, ttlMs: ttl, max };
};
