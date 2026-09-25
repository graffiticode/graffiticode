// Firestore-backed broker stores, in the broker's own named database (only the
// broker service account can reach it). Every write that must happen once uses
// create() — a create-if-absent precondition enforced by Firestore — never
// read-then-write, so two concurrent claims cannot both succeed.

import { createHash } from "node:crypto";

const ALREADY_EXISTS = 6;
const isAlreadyExists = err => err?.code === ALREADY_EXISTS || /ALREADY_EXISTS/.test(String(err?.message));
// Operation ids contain "/", which Firestore document ids cannot.
const docId = id => createHash("sha256").update(id).digest("hex");

const createOnce = async (ref, data) => {
  try {
    await ref.create(data);
    return true;
  } catch (err) {
    if (isAlreadyExists(err)) return false;
    throw err;
  }
};

export const createFirestoreOnceStore = db => ({
  async claim(jti, expiresAt) {
    // expiresAt feeds a TTL policy on `jtis` (cleanup only; expiry itself is
    // checked on the token).
    return createOnce(db.collection("jtis").doc(docId(jti)), { expiresAt: new Date(expiresAt * 1000) });
  },
});

export const createFirestoreReceiptStore = db => {
  const claimRef = operationId => db.collection("receipts").doc(docId(operationId));
  const outcomeRef = operationId => claimRef(operationId).collection("outcome").doc("final");
  return {
    async claim(operationId, binding) {
      const claim = { operationId, binding, claimedAt: new Date().toISOString() };
      if (await createOnce(claimRef(operationId), claim)) return { created: true };
      const snap = await claimRef(operationId).get();
      return { created: false, claim: snap.data() };
    },
    async getOutcome(operationId) {
      const snap = await outcomeRef(operationId).get();
      return snap.exists ? snap.data() : null;
    },
    async putOutcome(operationId, outcome) {
      const created = await createOnce(outcomeRef(operationId), { ...outcome, at: new Date().toISOString() });
      if (!created) throw new Error("outcome already recorded");
    },
  };
};

export const createFirestoreSecretStore = (db, { box }) => {
  const ref = connectionId => db.collection("connection-secrets").doc(connectionId);
  return {
    async get(connectionId) {
      const snap = await ref(connectionId).get();
      if (!snap.exists) return null;
      const { key, sealedSecret } = snap.data();
      return { key, secret: box.open(sealedSecret, connectionId) };
    },
    // Rotation replaces the stored secret; grants attach to the connection,
    // not to the secret, so they survive it.
    async put(connectionId, { key, secret }) {
      await ref(connectionId).set({ key, sealedSecret: box.seal(secret, connectionId), updatedAt: new Date().toISOString() });
    },
  };
};
