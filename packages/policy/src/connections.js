// Connection records: which owner holds which external-API connection. The
// secret itself never lives here — the broker holds it. Policy reads a
// connection LIVE at every snapshot and every mint, so disabling or deleting a
// connection takes effect at the next call.
//
// A store implements: get(connectionId) -> { connectionId, ownerUid, backend,
// status: "active" | "disabled", label } | null.

export const createMemoryConnectionStore = (records = []) => {
  const byId = new Map(records.map(r => [r.connectionId, { ...r }]));
  return {
    async get(connectionId) {
      const record = byId.get(connectionId);
      return record ? { ...record } : null;
    },
    async put(record) {
      byId.set(record.connectionId, { ...record });
    },
    async delete(connectionId) {
      byId.delete(connectionId);
    },
  };
};

// Owner-only phase: a connection is usable only by its owner, only while
// active. Returns a reason string when unusable.
export const connectionRefusal = (connection, { uid, ownerUid } = {}) => {
  if (!connection) return "connection-not-found";
  if (connection.status !== "active") return "connection-disabled";
  if (ownerUid !== undefined && connection.ownerUid !== ownerUid) return "owner-changed";
  if (connection.ownerUid !== uid) return "not-owner";
  return null;
};
