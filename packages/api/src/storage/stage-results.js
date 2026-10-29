// The stage cache (interpreter plan B3): one interpreted stage's result for
// one model, input and context, shared across requests and instances. It is
// apart from the whole-chain compile store (compiles/) and holds only results
// whose own class is `immutable` or `shared`; nothing `private` or `no-store`
// is ever written here (interpret.js decides, data.js asks).
//
// The key is interpret.js's stageCacheKey: a digest over the language, model
// digest, interpreter revision, configuration, generation, mode, authority and
// input, so the document id carries none of them. A record keeps the stage's
// own class and expiry, never its input's; a hit is combined with the input it
// is read for.
//
//   get({ key }) -> { data, cacheClass, expiresAt } | undefined
//     an entry past its expiresAt is a miss
//   put({ key, data, cacheClass, expiresAt, lang, mode, revision })
//
// Firestore deletes entries by `ttl` once a TTL policy on stage-results.ttl is
// set up (by hand: releases don't deploy Firestore configuration). `ttl` is the
// entry's expiry, or RETENTION_MS after it was written when it has none.

import { admin } from "./firebase.js";

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const live = (record, now) => record && (record.expiresAt === null || record.expiresAt > now);

export const buildStageResultStorer = ({ now = Date.now } = {}) => {
  const db = admin.firestore();
  return {
    async get({ key }) {
      const doc = await db.doc(`stage-results/${key}`).get();
      if (!doc.exists) return undefined;
      const stored = doc.data();
      const record = {
        data: JSON.parse(stored.data),
        cacheClass: stored.cacheClass,
        expiresAt: stored.expiresAt ?? null,
      };
      return live(record, now()) ? record : undefined;
    },
    async put({ key, data, cacheClass, expiresAt = null, lang, mode, revision }) {
      const written = now();
      await db.doc(`stage-results/${key}`).set({
        // As compiles/ does: not every JSON value is a Firestore value.
        data: JSON.stringify(data),
        cacheClass,
        expiresAt,
        lang,
        mode,
        revision,
        written,
        ttl: admin.firestore.Timestamp.fromMillis(expiresAt ?? written + RETENTION_MS),
      });
    },
  };
};

// For tests and local servers: the same contract in memory.
export const buildMemoryStageResultStorer = ({ now = Date.now } = {}) => {
  const entries = new Map();
  return {
    entries,
    async get({ key }) {
      const record = entries.get(key);
      return live(record, now()) ? JSON.parse(JSON.stringify(record)) : undefined;
    },
    async put({ key, data, cacheClass, expiresAt = null, lang, mode, revision }) {
      entries.set(key, JSON.parse(JSON.stringify({ data, cacheClass, expiresAt, lang, mode, revision })));
    },
  };
};
