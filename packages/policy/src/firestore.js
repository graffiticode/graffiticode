// Firestore-backed connection store, in the policy service's own named
// database (only the policy service account can reach it). Connection records
// carry no secret — the broker holds that.

export const createFirestoreConnectionStore = db => {
  const ref = connectionId => db.collection("connections").doc(connectionId);
  return {
    async get(connectionId) {
      const snap = await ref(connectionId).get();
      return snap.exists ? { connectionId, ...snap.data() } : null;
    },
    async put({ connectionId, ownerUid, backend, status, label = null }) {
      await ref(connectionId).set({ ownerUid, backend, status, label, updatedAt: new Date().toISOString() });
    },
    async delete(connectionId) {
      await ref(connectionId).delete();
    },
  };
};
