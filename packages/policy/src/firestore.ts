// Firestore-backed policy stores, in the policy service's own named database
// (only the policy service account can reach it). Connection records carry no
// secret — the broker holds that.

import { createHash } from "node:crypto";
import { InvocationConflict, ProtocolMismatch, newInvocationId, sameInvocationBinding, AdmissionRefused } from "./invocations.js";
import { COMMAND_LEASE_MS, CommandRefused, commandIdFor, newCommandRecord, renewedLease, takenOverLease } from "./commands.js";
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
        // D2a: a key a command holds is never served by the legacy path.
        if ((hit.protocol ?? "legacy") !== "legacy") throw new ProtocolMismatch(hit.protocol, hit.commandId);
        // The marker and plan are the invocation's own, never the retry's.
        const invocation = (await tx.get(db.collection("invocations").doc(hit.invocationId))).data() ?? {};
        return { invocationId: hit.invocationId, seq: hit.seq, reused: true, contract: invocation.contract ?? 1, planDigest: invocation.planDigest ?? null, protocol: "legacy" };
      }
      const seqSnap = await tx.get(seqRef);
      const seq = (seqSnap.exists ? seqSnap.data().seq : 0) + 1;
      const invocationId = newInvocationId();
      const now = new Date().toISOString();
      const contract = admission ? 2 : 1;
      tx.set(seqRef, { seq, updatedAt: now });
      tx.set(db.collection("invocations").doc(invocationId), { uid, ...binding, seq, contract, protocol: "legacy", createdAt: now });
      if (keyRef) tx.set(keyRef, { binding, invocationId, seq, protocol: "legacy", createdAt: now });
      return { invocationId, seq, reused: false, contract, planDigest: null, protocol: "legacy" };
    });
  },
  async get(invocationId) {
    const snap = await db.collection("invocations").doc(invocationId).get();
    if (!snap.exists) return null;
    const data = snap.data();
    return { invocationId, ...data, contract: data.contract ?? 1, planDigest: data.planDigest ?? null };
  },
  // The invocation a user's idempotency key named, if any (reconciliation).
  async findByKey(uid, idempotencyKey) {
    const key = await db.collection("idempotency-keys").doc(hashId([uid, idempotencyKey])).get();
    return key.exists ? this.get(key.data().invocationId) : null;
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

// See commands.js for the contract. Allocation is one transaction over the
// idempotency key, the sequence counter, the invocation, the command and its
// request, so concurrent first requests with one key get one command, and a
// key the legacy path allocated first stays legacy (D2a). Every lease change
// is a transaction that re-reads the command, so a stale owner changes nothing.
export const createFirestoreCommandStore = db => {
  const commandRef = commandId => db.collection("commands").doc(commandId);
  const requestRef = commandId => commandRef(commandId).collection("request").doc("original");
  const change = (commandId, fn) => db.runTransaction(async tx => {
    const snap = await tx.get(commandRef(commandId));
    if (!snap.exists) throw new CommandRefused("command-not-found");
    const next = fn(snap.data());
    tx.set(commandRef(commandId), next);
    return next;
  });
  return {
    async allocate({ uid, connectionId, taskId, inputDigest, idempotencyKey, lang, request, worker, now, leaseMs = COMMAND_LEASE_MS, create = true }) {
      const binding = { connectionId, taskId, inputDigest };
      const keyRef = db.collection("idempotency-keys").doc(hashId([uid, idempotencyKey]));
      const seqRef = db.collection("invocation-sequences").doc(hashId([uid, taskId, connectionId]));
      return db.runTransaction(async tx => {
        const keySnap = await tx.get(keyRef);
        if (keySnap.exists) {
          const hit = keySnap.data();
          if (!sameInvocationBinding(hit.binding, binding)) throw new InvocationConflict("idempotency key reused");
          if ((hit.protocol ?? "legacy") === "legacy") return { protocol: "legacy", invocationId: hit.invocationId, seq: hit.seq };
          const command = await tx.get(commandRef(hit.commandId));
          return { protocol: "command", reused: true, command: command.data() };
        }
        if (!create) return { protocol: "none" };
        const seqSnap = await tx.get(seqRef);
        const seq = (seqSnap.exists ? seqSnap.data().seq : 0) + 1;
        const invocationId = newInvocationId();
        const commandId = commandIdFor(uid, idempotencyKey);
        const at = new Date(now).toISOString();
        const command = newCommandRecord({ commandId, uid, idempotencyKey, invocationId, seq, lang, connectionId, taskId, inputDigest, worker, now, leaseMs });
        tx.set(seqRef, { seq, updatedAt: at });
        tx.set(db.collection("invocations").doc(invocationId), { uid, ...binding, seq, contract: 2, protocol: "command", commandId, createdAt: at });
        tx.set(keyRef, { binding, invocationId, seq, protocol: "command", commandId, createdAt: at });
        tx.set(commandRef(commandId), command);
        // The request's exact text, never re-serialized (decision 2).
        tx.set(requestRef(commandId), { text: request });
        return { protocol: "command", reused: false, command };
      });
    },
    async get(commandId) {
      const snap = await commandRef(commandId).get();
      return snap.exists ? snap.data() : null;
    },
    async getRequest(commandId) {
      const snap = await requestRef(commandId).get();
      return snap.exists ? snap.data().text : null;
    },
    async renewLease({ commandId, worker, generation, now, leaseMs = COMMAND_LEASE_MS }) {
      return change(commandId, c => renewedLease(c, { worker, generation, now, leaseMs }));
    },
    async takeOver({ commandId, worker, expectedGeneration, now, leaseMs = COMMAND_LEASE_MS }) {
      return change(commandId, c => takenOverLease(c, { worker, expectedGeneration, now, leaseMs }));
    },
    // Two queries, each on its composite index in the policy database
    // (configs/firestore-policy-indexes.json): pending, and publication due,
    // each with an expired lease.
    async listDue({ now, limit }) {
      const query = (field, value) => db.collection("commands").where(field, "==", value).where("owner.leaseExpiresAt", "<", now).orderBy("owner.leaseExpiresAt").limit(limit).get();
      const [pending, due] = await Promise.all([query("status", "pending"), query("publication.state", "due")]);
      const byId = new Map([...pending.docs, ...due.docs].map(d => [d.id, d.data()]));
      return [...byId.values()].sort((a, b) => a.owner.leaseExpiresAt - b.owner.leaseExpiresAt).slice(0, limit);
    },
  };
};

// The transaction interface command-records.js is written against, over
// `commands/{id}` and its subcollections.
export const createFirestoreCommandBackend = db => {
  const ref = path => (path.length === 2
    ? db.collection("commands").doc(path[1])
    : db.collection("commands").doc(path[1]).collection(path[2]).doc(path[3]));
  return {
    transaction: fn => db.runTransaction(async t => fn({
      get: async path => {
        const snap = await t.get(ref(path));
        return snap.exists ? snap.data() : null;
      },
      set: (path, doc) => t.set(ref(path), doc),
      list: async path => (await t.get(db.collection("commands").doc(path[1]).collection(path[2]))).docs.map(d => d.data()),
    })),
  };
};

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
