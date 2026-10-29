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
//               claim    { binding, pld?, evidence?, claimedAt } — before the provider call; evidence (writes, W5) names each record, its digest and the mark
//               steps/n  { n, step, at }              — after each provider
//                        step completes, before the next one starts (spec
//                        WRITE-01). putStep(id, n, step) acknowledges an
//                        identical repeat and rejects different content with
//                        StepConflict; getSteps(id) lists them in order.
//               outcome  { status, steps, result, at } — after the last
//             A claim with no outcome is "uncertain": the broker may have
//             crashed mid-call, so it is reported with its persisted steps,
//             never blindly re-run.
//   activity  writes in progress, for draining before a release (W0):
//               begin(operationId, expiresAt)   before any provider request
//               end(operationId)                when the execution finishes
//               count(now) -> number            entries not yet expired
//             An entry left by a crash expires at its deadline, so a count
//             never waits past the maximum execution duration.
//   slots     a system preview session's signature allowance (the
//             system-preview rate limits plan, design point 3):
//               claim(sid, max, { expiresAt, jti, opid }) -> k | null
//             creates the first absent slot `${sid}:${k}`, k = 0..max-1,
//             each create-if-absent, and returns its index; null when all
//             `max` are taken. Atomic across instances and concurrent calls,
//             and durable across restarts. `expiresAt` (epoch ms) is a
//             cleanup-only TTL: it outlives every token the session can
//             produce, so a cleaned-up slot can never be claimed again by one.
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

export type SessionSlotStore = { claim(sid: string, max: number, slot: { expiresAt: number, jti?: string, opid?: string }): Promise<number | null> };
// `sweep(at)` stands in for storage TTL cleanup in tests: it removes the slots
// whose expiresAt is at or before `at` (epoch ms) and returns how many.
export const createMemorySessionSlotStore = () => {
  const slots = new Map<string, { expiresAt: number, jti?: string, opid?: string }>();
  return {
    async claim(sid: string, max: number, { expiresAt, jti, opid }: { expiresAt: number, jti?: string, opid?: string }) {
      for (let k = 0; k < max; k++) {
        const id = `${sid}:${k}`;
        if (slots.has(id)) continue;
        slots.set(id, { expiresAt, jti, opid });
        return k;
      }
      return null;
    },
    async sweep(at: number) {
      let removed = 0;
      for (const [id, slot] of slots) {
        if (slot.expiresAt <= at) {
          slots.delete(id);
          removed++;
        }
      }
      return removed;
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
  const attempts = new Map();
  const resolutions = new Map();
  return {
    // -> { created: true } or { created: false, claim }
    async claim(operationId, binding, { pld = undefined, evidence = undefined } = {}) {
      if (claims.has(operationId)) {
        return { created: false, claim: claims.get(operationId) };
      }
      const claim = { binding, ...(pld ? { pld } : {}), ...(evidence ? { evidence } : {}), claimedAt: new Date().toISOString() };
      claims.set(operationId, claim);
      return { created: true };
    },
    // The claim alone, never creating one: a replay-only token (P1b) reads it.
    async getClaim(operationId) {
      return claims.get(operationId) ?? null;
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
    // Reconciliation (WRITE-02, W5): an invocation's claims, appended attempts,
    // and a final resolution created once.
    async listClaims(invocationId) {
      return [...claims.entries()].filter(([id]) => id.startsWith(`${invocationId}/`)).map(([operationId, claim]) => ({ operationId, ...claim }));
    },
    async putAttempt(operationId, attemptId, attempt) {
      const key = `${operationId}#${attemptId}`;
      if (attempts.has(key)) throw new Error(`attempt ${attemptId} already recorded`);
      attempts.set(key, { ...attempt, at: new Date().toISOString() });
    },
    async getAttempts(operationId) {
      return [...attempts.entries()].filter(([k]) => k.startsWith(`${operationId}#`)).map(([, a]) => a);
    },
    async getResolution(operationId) {
      return resolutions.get(operationId) ?? null;
    },
    // -> true if created, false if one was already there (unchanged).
    async createResolution(operationId, resolution) {
      if (resolutions.has(operationId)) return false;
      resolutions.set(operationId, { ...resolution, at: new Date().toISOString() });
      return true;
    },
  };
};

export const createMemoryActivityStore = () => {
  const active = new Map();
  return {
    async begin(operationId, expiresAt) {
      active.set(operationId, expiresAt);
    },
    async end(operationId) {
      active.delete(operationId);
    },
    async count(now = Date.now()) {
      return [...active.values()].filter(expiresAt => expiresAt > now).length;
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

// A stored credential, or the marker a deletion leaves.
type SecretEntry = { ownerUid?: string, backend?: string, key?: string, secret?: string, deleted?: boolean };

export const createMemorySecretStore = (entries: Record<string, SecretEntry> = {}) => {
  const map = new Map<string, SecretEntry>(Object.entries(entries));
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
