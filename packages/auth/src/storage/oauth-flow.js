/* eslint-disable camelcase */
import { getFirestore } from "../firebase.js";
import { assertUnfenced } from "./oauth-migration.js";

/**
 * Generic Firestore-backed key/value storer for ephemeral OAuth flow records:
 * dynamic-client registrations, pending authorizations, and authorization codes.
 *
 * Unlike oauth-tokens (which are scoped to a user's oauth-link), these records
 * are identity-less and short-lived. Each is a single document keyed by its
 * natural id (client_id / state / code) in a dedicated top-level collection.
 *
 * A record may carry a numeric `expires_at` (epoch ms). Reads past that time
 * delete the document and return null (lazy expiry); a Firestore TTL policy on
 * `expires_at` can be added later to reclaim abandoned records.
 *
 * Keys are UUIDs or base64url tokens, so they are safe Firestore document ids.
 */
export const buildOAuthFlowStorer = (collection) => {
  // The fence (oauth-migration.js): once Graffiticode's records are fenced for
  // the OAuth-store migration, every write here is refused, in the same
  // transaction that would have made it.
  const put = async (key, record) => {
    const db = getFirestore();
    const ref = db.collection(collection).doc(key);
    const data = { ...record, updated_at: Date.now() };
    await db.runTransaction(async tx => {
      await assertUnfenced(tx, db);
      tx.set(ref, data);
    });
    return data;
  };

  // A record consumed through the migration (consumed_by) reads as used, for
  // a code, and as gone, for a pending authorization: either way it can't be
  // used again here.
  const view = data => {
    if (!data.consumed_by) return data;
    return collection === "oauth-codes" ? { ...data, used: true } : null;
  };

  const get = async (key) => {
    const db = getFirestore();
    const ref = db.collection(collection).doc(key);
    const doc = await ref.get();
    if (!doc.exists) {
      return null;
    }
    const data = doc.data();
    if (typeof data.expires_at === "number" && Date.now() > data.expires_at) {
      await ref.delete().catch(() => {});
      return null;
    }
    return view(data);
  };

  const patch = async (key, updates) => {
    const db = getFirestore();
    const ref = db.collection(collection).doc(key);
    return db.runTransaction(async tx => {
      await assertUnfenced(tx, db);
      const doc = await tx.get(ref);
      if (!doc.exists) {
        return null;
      }
      const updated = { ...doc.data(), ...updates };
      tx.update(ref, updates);
      return view(updated);
    });
  };

  const remove = async (key) => {
    const db = getFirestore();
    const ref = db.collection(collection).doc(key);
    await db.runTransaction(async tx => {
      await assertUnfenced(tx, db);
      tx.delete(ref);
    });
  };

  return { put, get, patch, remove };
};
