// Firestore-backed broker stores, in the broker's own named database (only the
// broker service account can reach it). Every write that must happen once uses
// create() — a create-if-absent precondition enforced by Firestore — never
// read-then-write, so two concurrent claims cannot both succeed.

import { createHash } from "node:crypto";
import { ConflictError } from "@graffiticode/common/errors";
import { checkRotation, StepConflict } from "./stores.js";

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
  const stepsRef = operationId => claimRef(operationId).collection("steps");
  return {
    async claim(operationId, binding, { pld = undefined } = {}) {
      const claim = { operationId, binding, ...(pld ? { pld } : {}), claimedAt: new Date().toISOString() };
      if (await createOnce(claimRef(operationId), claim)) return { created: true };
      const snap = await claimRef(operationId).get();
      return { created: false, claim: snap.data() };
    },
    async putStep(operationId, n, step) {
      if (!Number.isInteger(n) || n < 0) throw new Error(`step index must be a non-negative integer, not ${n}`);
      const ref = stepsRef(operationId).doc(String(n));
      if (await createOnce(ref, { n, step, at: new Date().toISOString() })) return;
      const snap = await ref.get();
      if (snap.data()?.step !== step) throw new StepConflict(`step ${n} already recorded`);
    },
    async getSteps(operationId) {
      const snap = await stepsRef(operationId).orderBy("n").get();
      return snap.docs.map(d => d.data().step);
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

// See stores.js for the contract. Entries carry expiresAt (a Date), which a
// TTL policy on `active-executions` may also use for cleanup.
export const createFirestoreActivityStore = db => {
  const ref = operationId => db.collection("active-executions").doc(docId(operationId));
  return {
    async begin(operationId, expiresAt) {
      await ref(operationId).set({ operationId, startedAt: new Date().toISOString(), expiresAt: new Date(expiresAt) });
    },
    async end(operationId) {
      await ref(operationId).delete();
    },
    async count(now = Date.now()) {
      const snap = await db.collection("active-executions").where("expiresAt", ">", new Date(now)).count().get();
      return snap.data().count;
    },
  };
};

// See stores.js for the contract. The owner and backend are sealed into the
// ciphertext's associated data with the connection id, so editing them on the
// stored document makes the secret undecryptable rather than rebinding it.
export const createFirestoreSecretStore = (db, { box }) => {
  const ref = connectionId => db.collection("connection-secrets").doc(connectionId);
  const aad = (connectionId, { ownerUid, backend }) => JSON.stringify([connectionId, ownerUid, backend]);
  const seal = (connectionId, { ownerUid, backend, key, secret }) => ({
    ownerUid,
    backend,
    key,
    sealedSecret: box.seal(secret, aad(connectionId, { ownerUid, backend })),
    updatedAt: new Date().toISOString(),
  });
  return {
    async get(connectionId) {
      const snap = await ref(connectionId).get();
      if (!snap.exists || snap.data().deleted) return null;
      const { ownerUid, backend, key, sealedSecret } = snap.data();
      return { ownerUid, backend, key, secret: box.open(sealedSecret, aad(connectionId, { ownerUid, backend })) };
    },
    async create(connectionId, credential) {
      if (!(await createOnce(ref(connectionId), seal(connectionId, credential)))) {
        throw new ConflictError("connection id already used");
      }
    },
    // Grants attach to the connection, not to the secret, so they survive.
    async rotate(connectionId, credential) {
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref(connectionId));
        checkRotation(snap.exists ? snap.data() : null, credential);
        tx.set(ref(connectionId), seal(connectionId, credential));
      });
    },
    async delete(connectionId) {
      await ref(connectionId).set({ deleted: true, deletedAt: new Date().toISOString() });
    },
  };
};
