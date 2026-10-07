// Firestore-backed policy stores, in the policy service's own named database
// (only the policy service account can reach it). Connection records carry no
// secret — the broker holds that.

import { createHash } from "node:crypto";
import { InvocationConflict, newInvocationId, sameInvocationBinding, AdmissionRefused } from "./invocations.js";
import { leaseRef, leaseIsActive } from "./revisions.js";

const hashId = parts => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

// A document as of `readTime` (one consistent view for an admission), or now.
const readAt = async (db, ref, readTime) => (readTime
  ? db.runTransaction(tx => tx.get(ref), { readOnly: true, readTime })
  : ref.get());
const millis = t => (typeof t?.toMillis === "function" ? t.toMillis() : t instanceof Date ? t.getTime() : Number(t));

export const createFirestoreConnectionStore = db => {
  const ref = connectionId => db.collection("connections").doc(connectionId);
  return {
    async get(connectionId, { readTime = undefined } = {}) {
      const snap = await readAt(db, ref(connectionId), readTime);
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
  async allocate({ uid, connectionId, taskId, inputDigest, idempotencyKey = null, admission = false }) {
    const binding = { connectionId, taskId, inputDigest };
    const keyRef = idempotencyKey ? db.collection("idempotency-keys").doc(hashId([uid, idempotencyKey])) : null;
    const seqRef = db.collection("invocation-sequences").doc(hashId([uid, taskId, connectionId]));
    return db.runTransaction(async tx => {
      const keySnap = keyRef ? await tx.get(keyRef) : null;
      if (keySnap?.exists) {
        const hit = keySnap.data();
        if (!sameInvocationBinding(hit.binding, binding)) throw new InvocationConflict("idempotency key reused");
        // The marker and plan are the invocation's own, never the retry's.
        const invocation = (await tx.get(db.collection("invocations").doc(hit.invocationId))).data() ?? {};
        return { invocationId: hit.invocationId, seq: hit.seq, reused: true, contract: invocation.contract ?? 1, planDigest: invocation.planDigest ?? null };
      }
      const seqSnap = await tx.get(seqRef);
      const seq = (seqSnap.exists ? seqSnap.data().seq : 0) + 1;
      const invocationId = newInvocationId();
      const now = new Date().toISOString();
      const contract = admission ? 2 : 1;
      tx.set(seqRef, { seq, updatedAt: now });
      tx.set(db.collection("invocations").doc(invocationId), { uid, ...binding, seq, contract, createdAt: now });
      if (keyRef) tx.set(keyRef, { binding, invocationId, seq, createdAt: now });
      return { invocationId, seq, reused: false, contract, planDigest: null };
    });
  },
  async get(invocationId) {
    const snap = await db.collection("invocations").doc(invocationId).get();
    if (!snap.exists) return null;
    const data = snap.data();
    return { invocationId, ...data, contract: data.contract ?? 1, planDigest: data.planDigest ?? null };
  },
  async getPlan(planDigest) {
    const snap = await db.collection("plans").doc(planDigest).get();
    return snap.exists ? snap.data().plan : null;
  },
  // The plan write (W4, section A): one transaction that reads the admission's
  // lease and the invocation, then consumes the lease and, for a first
  // admission, stores the plan. Retirement invalidates leases in transactions
  // of its own, so either this commits first or it can't commit.
  async commitPlan({ leaseId, invocationId, planDigest, plan, revisions, readTime, maxAgeMs, now = () => Date.now() }) {
    const invocationRef = db.collection("invocations").doc(invocationId);
    const planRef = db.collection("plans").doc(planDigest);
    return db.runTransaction(async tx => {
      const startedAt = now();
      const lease = await tx.get(leaseRef(db, leaseId));
      const invocation = await tx.get(invocationRef);
      if (!leaseIsActive(lease)) throw new AdmissionRefused("revision-retiring");
      if (!invocation.exists || invocation.data().contract !== 2) throw new AdmissionRefused("invocation-incompatible");
      const existing = invocation.data().planDigest ?? null;
      if (existing && existing !== planDigest) throw new AdmissionRefused("plan-mismatch");
      if (startedAt - millis(readTime) > maxAgeMs) throw new AdmissionRefused("admission-stale");
      tx.delete(lease.ref);
      if (!existing) {
        tx.set(planRef, { plan, invocationId, revisions, createdAt: new Date(startedAt).toISOString() });
        tx.update(invocationRef, { planDigest });
      }
      return { created: !existing };
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
    async get(grantId, { readTime = undefined } = {}) {
      const snap = await readAt(db, col.doc(grantId), readTime);
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
