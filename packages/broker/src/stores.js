// Broker state, written only by the broker. The in-memory implementations here
// define the contracts the Firestore ones must meet; every write is
// create-if-absent (never update), so receipts are append-only. The Firestore
// implementations must make `claim` atomic with a create precondition (Admin
// SDK `create()`), never read-then-write — the race test relies on it.
//
//   once      jti ledger: claim(jti, expiresAt) -> true the first time only.
//             Expiry is checked on the token itself; this ledger only needs to
//             outlive the token, and storage TTL is just eventual cleanup.
//   receipts  per operation id, documents each created once:
//               claim    { binding, claimedAt }       — before the provider call
//               steps/n  { n, step, at }              — after each provider
//                        step completes, before the next one starts (spec
//                        WRITE-01). putStep(id, n, step) acknowledges an
//                        identical repeat and rejects different content with
//                        StepConflict; getSteps(id) lists them in order.
//               outcome  { status, steps, result, at } — after the last
//             A claim with no outcome is "uncertain": the broker may have
//             crashed mid-call, so it is reported with its persisted steps,
//             never blindly re-run.
//   secrets   One credential per connection, bound to the connection's
//             immutable owner and backend. Never logged, never returned to
//             callers.
//               create(id, { ownerUid, backend, key, secret })  once per id;
//                        an id already used (even if deleted) is refused
//               rotate(id, { ownerUid, backend, key, secret })  replaces the
//                        secret only: owner, backend and key must match, since
//                        the key identifies the provider account (Learnosity's
//                        consumer key). A new account needs a new connection.
//               get(id) -> { ownerUid, backend, key, secret } | null
//               delete(id)  leaves a tombstone, so the id is never reused

import { ConflictError, NotFoundError } from "@graffiticode/common/errors";

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

// A step already recorded with different content: the operation's history
// cannot be rewritten.
export class StepConflict extends Error {}

const checkStepIndex = n => {
  if (!Number.isInteger(n) || n < 0) throw new Error(`step index must be a non-negative integer, not ${n}`);
};

export const createMemoryReceiptStore = () => {
  const claims = new Map();
  const steps = new Map();
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
    async putStep(operationId, n, step) {
      checkStepIndex(n);
      const recorded = steps.get(operationId) ?? new Map();
      if (recorded.has(n)) {
        if (recorded.get(n).step !== step) throw new StepConflict(`step ${n} of ${operationId} already recorded`);
        return;
      }
      recorded.set(n, { n, step, at: new Date().toISOString() });
      steps.set(operationId, recorded);
    },
    async getSteps(operationId) {
      return [...(steps.get(operationId) ?? new Map()).values()].sort((a, b) => a.n - b.n).map(s => s.step);
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

// Shared by the memory and Firestore stores: may `next` rotate `current`?
export const checkRotation = (current, next) => {
  if (!current || current.deleted) throw new NotFoundError("no credential for this connection");
  if (current.ownerUid !== next.ownerUid || current.backend !== next.backend) {
    throw new ConflictError("connection owner and backend are immutable");
  }
  if (current.key !== next.key) {
    throw new ConflictError("rotation cannot change the provider account; create a new connection");
  }
};

export const createMemorySecretStore = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return {
    async get(connectionId) {
      const entry = map.get(connectionId);
      return entry && !entry.deleted ? { ...entry } : null;
    },
    async create(connectionId, { ownerUid, backend, key, secret }) {
      if (map.has(connectionId)) throw new ConflictError("connection id already used");
      map.set(connectionId, { ownerUid, backend, key, secret });
    },
    async rotate(connectionId, { ownerUid, backend, key, secret }) {
      checkRotation(map.get(connectionId), { ownerUid, backend, key });
      map.set(connectionId, { ownerUid, backend, key, secret });
    },
    async delete(connectionId) {
      map.set(connectionId, { deleted: true });
    },
  };
};
