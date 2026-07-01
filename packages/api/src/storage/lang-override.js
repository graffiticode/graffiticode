import { admin } from "./firebase.js";

// Per-user language-server binding overrides, used for testing a specific
// language-server revision without affecting other users. Each doc is keyed by
// uid and holds a map of (uppercase, zero-padded) lang id -> full base URL:
//
//   lang-overrides/{uid} = {
//     bindings: { "L0175": "https://test42---l0175-...run.app" }
//   }
//
// Docs are seeded manually (Firestore console / script); there is no write API.

// A single authenticated compile resolves the same override doc several times
// (once for the compile-cache-bypass decision, then once per task inside
// getBaseUrlForLanguage), and the asset routes resolve it twice per request.
// A short-TTL per-uid memo collapses those into one Firestore read. The result
// (including the common "no override" miss) is cached, so normal users don't
// pay a read per request. The TTL bounds staleness: a newly seeded/removed
// override takes effect within TTL_MS. In-flight promises are cached so
// concurrent lookups for the same uid share one read.
const OVERRIDE_CACHE_TTL_MS = 10 * 1000;

const buildLangOverrideGet = ({ db, cache, ttlMs }) => ({ uid }) => {
  if (!uid) {
    return Promise.resolve(undefined);
  }
  const cached = cache.get(uid);
  if (cached && Date.now() < cached.expires) {
    return cached.promise;
  }
  const promise = db.doc(`lang-overrides/${uid}`).get()
    .then((overrideDoc) => (overrideDoc.exists ? overrideDoc.data() : undefined));
  // Don't let a failed read stick in the cache — evict so the next call retries.
  promise.catch(() => {
    if (cache.get(uid)?.promise === promise) {
      cache.delete(uid);
    }
  });
  cache.set(uid, { promise, expires: Date.now() + ttlMs });
  return promise;
};

const buildLangOverrideGetBaseUrl = ({ get }) => async ({ uid, lang }) => {
  if (!uid || !lang) {
    return undefined;
  }
  const override = await get({ uid });
  const bindings = override && override.bindings;
  if (!bindings) {
    return undefined;
  }
  return bindings[lang.toUpperCase()];
};

export const buildLangOverrideStorer = () => {
  const db = admin.firestore();
  const cache = new Map();
  const get = buildLangOverrideGet({ db, cache, ttlMs: OVERRIDE_CACHE_TTL_MS });
  const getBaseUrl = buildLangOverrideGetBaseUrl({ get });
  return { get, getBaseUrl };
};
