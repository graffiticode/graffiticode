/* eslint-disable camelcase */
import { getFirestore } from "../firebase.js";

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
  const put = async (key, record) => {
    const db = getFirestore();
    const data = { ...record, updated_at: Date.now() };
    await db.collection(collection).doc(key).set(data);
    return data;
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
    return data;
  };

  const patch = async (key, updates) => {
    const db = getFirestore();
    const ref = db.collection(collection).doc(key);
    const doc = await ref.get();
    if (!doc.exists) {
      return null;
    }
    await ref.update(updates);
    const updated = await ref.get();
    return updated.data();
  };

  const remove = async (key) => {
    const db = getFirestore();
    await db.collection(collection).doc(key).delete().catch(() => {});
  };

  return { put, get, patch, remove };
};
