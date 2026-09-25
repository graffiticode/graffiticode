// Broker state, written only by the broker. The in-memory implementations here
// define the contracts the Firestore ones must meet; every write is
// create-if-absent (never update), so receipts are append-only. The Firestore
// implementations must make `claim` atomic with a create precondition (Admin
// SDK `create()`), never read-then-write — the race test relies on it.
//
//   once      jti ledger: claim(jti, expiresAt) -> true the first time only.
//             Expiry is checked on the token itself; this ledger only needs to
//             outlive the token, and storage TTL is just eventual cleanup.
//   receipts  per operation id, two documents, each created once:
//               claim    { binding, claimedAt }       — before the provider call
//               outcome  { status, steps, result, at } — after it
//             A claim with no outcome is "uncertain": the broker may have
//             crashed mid-call, so it is reported, never blindly re-run.
//   secrets   get(connectionId) -> { key, secret } | null, decrypted with the
//             broker-only key. Never logged, never returned to callers.

export const createMemoryOnceStore = () => {
  const seen = new Map();
  return {
    async claim(id, expiresAt) {
      if (seen.has(id)) return false;
      seen.set(id, expiresAt);
      return true;
    },
  };
};

export const createMemoryReceiptStore = () => {
  const claims = new Map();
  const outcomes = new Map();
  return {
    // -> { created: true } or { created: false, claim }
    async claim(operationId, binding) {
      if (claims.has(operationId)) {
        return { created: false, claim: claims.get(operationId) };
      }
      const claim = { binding, claimedAt: new Date().toISOString() };
      claims.set(operationId, claim);
      return { created: true };
    },
    async getOutcome(operationId) {
      return outcomes.get(operationId) ?? null;
    },
    async putOutcome(operationId, outcome) {
      if (outcomes.has(operationId)) {
        throw new Error(`outcome already recorded for ${operationId}`);
      }
      outcomes.set(operationId, { ...outcome, at: new Date().toISOString() });
    },
  };
};

export const createMemorySecretStore = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return {
    async get(connectionId) {
      return map.get(connectionId) ?? null;
    },
    async put(connectionId, credential) {
      map.set(connectionId, { ...credential });
    },
    async delete(connectionId) {
      map.delete(connectionId);
    },
  };
};
