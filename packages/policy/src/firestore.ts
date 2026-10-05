// Firestore-backed policy stores, in the policy service's own named database
// (only the policy service account can reach it). Connection records carry no
// secret — the broker holds that.

import { createHash } from "node:crypto";
import { InvocationConflict, newInvocationId, sameInvocationBinding } from "./invocations.js";

const hashId = parts => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export const createFirestoreConnectionStore = db => {
  const ref = connectionId => db.collection("connections").doc(connectionId);
  return {
    async get(connectionId) {
      const snap = await ref(connectionId).get();
      return snap.exists ? { connectionId, ...snap.data() } : null;
    },
    async put({ connectionId, ownerUid, backend, status, label = null, ownerPermissions = null }) {
      await ref(connectionId).set({ ownerUid, backend, status, label, ownerPermissions, updatedAt: new Date().toISOString() });
    },
    async delete(connectionId) {
      await ref(connectionId).delete();
    },
    async listByOwner(ownerUid) {
      const snap = await db.collection("connections").where("ownerUid", "==", ownerUid).get();
      return snap.docs.map(doc => ({ connectionId: doc.id, ...doc.data() }));
    },
  };
};

// See invocations.js for the contract. One transaction reads the idempotency
// record and the sequence counter and writes both with the new invocation, so
// two concurrent requests with the same key get one invocation.
export const createFirestoreInvocationStore = db => ({
  async allocate({ uid, connectionId, taskId, inputDigest, idempotencyKey = null }) {
    const binding = { connectionId, taskId, inputDigest };
    const keyRef = idempotencyKey ? db.collection("idempotency-keys").doc(hashId([uid, idempotencyKey])) : null;
    const seqRef = db.collection("invocation-sequences").doc(hashId([uid, taskId, connectionId]));
    return db.runTransaction(async tx => {
      const keySnap = keyRef ? await tx.get(keyRef) : null;
      if (keySnap?.exists) {
        const hit = keySnap.data();
        if (!sameInvocationBinding(hit.binding, binding)) throw new InvocationConflict("idempotency key reused");
        return { invocationId: hit.invocationId, seq: hit.seq, reused: true };
      }
      const seqSnap = await tx.get(seqRef);
      const seq = (seqSnap.exists ? seqSnap.data().seq : 0) + 1;
      const invocationId = newInvocationId();
      const now = new Date().toISOString();
      tx.set(seqRef, { seq, updatedAt: now });
      tx.set(db.collection("invocations").doc(invocationId), { uid, ...binding, seq, createdAt: now });
      if (keyRef) tx.set(keyRef, { binding, invocationId, seq, createdAt: now });
      return { invocationId, seq, reused: false };
    });
  },
});

// See publications.js for the contract.
export const createFirestorePublicationStore = db => {
  const ref = publicationId => db.collection("publications").doc(publicationId);
  return {
    async create(record) {
      await ref(record.publicationId).create(record);
      return { ...record };
    },
    async get(publicationId) {
      const snap = await ref(publicationId).get();
      return snap.exists ? { publicationId, ...snap.data() } : null;
    },
    async delete(publicationId) {
      await ref(publicationId).delete();
    },
  };
};

// See grants.js for the contract. Pending grants are found by email hash; a
// Firestore `in` query takes at most 30 values, and claim sends at most 20.
export const createFirestoreGrantStore = db => {
  const col = db.collection("grants");
  const rows = snap => snap.docs.map(doc => ({ grantId: doc.id, ...doc.data() }));
  return {
    async put(grant) {
      const { grantId, ...rest } = grant;
      await col.doc(grantId).set(rest);
    },
    async get(grantId) {
      const snap = await col.doc(grantId).get();
      return snap.exists ? { grantId, ...snap.data() } : null;
    },
    async listByConnection(connectionId) {
      return rows(await col.where("connectionId", "==", connectionId).get());
    },
    async listByRecipient(uid) {
      return rows(await col.where("recipientUid", "==", uid).get());
    },
    async listPendingByEmailHash(hashes) {
      if (!hashes.length) return [];
      return rows(await col.where("recipientEmailHash", "in", hashes).get()).filter(g => !g.recipientUid);
    },
    async delete(grantId) {
      await col.doc(grantId).delete();
    },
  };
};
