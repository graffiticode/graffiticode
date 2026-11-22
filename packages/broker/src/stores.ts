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
//               steps/n  { n, step, observed?, at }   — after each provider
//                        step completes, before the next one starts (spec
//                        WRITE-01). putStep(id, n, step, detail?) acknowledges an
//                        identical repeat and rejects different content with
//                        StepConflict; getSteps(id) lists the step names in
//                        order, getStepRecords(id) the records. `detail` is
//                        what the step observed ({ observed }, a conditional
//                        step's; C5 plan decision 5).
//               attempts/k  { step, attempt, decisionId, observed, at } — each
//                        attempt of a conditional step, before the next is
//                        authorized. putStepAttempt(id, k, attempt) creates it
//                        once; getStepAttempts(id) lists them by k.
//               outcome  { status, steps, result, at } — after the last
//               run/state  { run, state, reason? }  (C5, operations that
//                        reopen before dispatch): one record of the current
//                        run, `open` or `aborted` (absent: run 0, open). Run 0
//                        is the claim's own. Every transition reads it and the
//                        outcome in one transaction, so they exclude each
//                        other:
//                          abortRun(id, k)       only run k, open, with no
//                                                outcome -> aborted
//                          startRun(id, k)       only after run k-1 was
//                                                aborted, with no outcome ->
//                                                run k, open; false otherwise
//                          putOutcome(id, o, { run: k })  only while run k is
//                                                open
//                        Anything else throws RunFenced, and changes nothing.
//                        getRunState(id) -> { run, aborted }. An aborted
//                        latest run wrote nothing. putOutcome without `run`
//                        (every other operation) is unchanged.
//               A definite staging refusal (C5d, docs/c5d-refusal-and-hold-plan.md
//               decision 1) is recorded as the operation's outcome in ONE
//               transaction, never as two writes (a claim committed without
//               its outcome would read uncertain for good):
//                 claimRefused(id, binding, { pld?, evidence? }, outcome)
//                          -> { created: true } | { created: false, claim }
//                          with no claim, creates the claim and the outcome
//                          together; with one, returns it and writes nothing
//                 refuseRun(id, k, outcome) -> boolean
//                          exactly when startRun(id, k) would succeed (run
//                          k-1 aborted, no outcome): run k, open, and the
//                          outcome, together. A run with an outcome has
//                          ended. False, writing nothing, otherwise
//               Either both records exist afterwards, or neither does.
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
import { classify } from "@graffiticode/common/failures";

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

// What a step record keeps of its detail: only `observed`.
export const stepDetail = detail => (detail && typeof detail.observed === "string" ? { observed: detail.observed } : {});
// A conditional step's attempt record (C5 plan decision 5).
export const attemptRecord = ({ step, attempt, decisionId, observed }) => ({ step, attempt, decisionId, observed });
// A run transition refused by the run's record: the run was aborted,
// superseded, or already has its outcome. Nothing changed.
export class RunFenced extends Error {}
// The current run, as its record says (absent: run 0, open).
export const currentRun = state => state ?? { run: 0, state: "open" };

export const checkRun = run => {
  if (!Number.isInteger(run) || run < 0) throw new Error(`run must be a non-negative integer, not ${run}`);
};
export const checkAttempt = (k, attempt) => {
  if (!Number.isInteger(k) || k < 1 || attempt?.attempt !== k) throw new Error(`attempt index must be the attempt's own positive integer, not ${k}`);
};

// The outcome a definite staging refusal records (C5d refusal plan decision
// 2): failed, no step taken, nothing returned. `category` is classify's of the
// reason (common/failures: conflict).
export const STAGING_REFUSAL = "staging-unavailable";
export const stagingRefusalOutcome = () => ({ status: "failed", steps: [], result: null, reason: STAGING_REFUSAL, category: classify(STAGING_REFUSAL).category });
// Whether a recorded outcome is a final staging refusal, from either store
// operation: failed, for that reason, with no step taken (decision 5). Before
// C5d nothing recorded that reason, so nothing older matches.
export const isStagingRefusal = outcome =>
  Boolean(outcome) && outcome.status === "failed" && outcome.reason === STAGING_REFUSAL && Array.isArray(outcome.steps) && outcome.steps.length === 0;

// `beforeCommit` (tests only): called with the operation's name once a
// claimRefused or refuseRun has built its records and before it stores
// either, so a test can fail the transaction there. A throw stores nothing.
export const createMemoryReceiptStore = ({ beforeCommit = undefined }: { beforeCommit?: (operation: string, operationId: string) => void } = {}) => {
  const claims = new Map();
  const stepAttempts = new Map();
  const runStates = new Map();
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
    // The claim and the outcome together, checked and set with no await in
    // between: atomic here.
    async claimRefused(operationId, binding, { pld = undefined, evidence = undefined } = {}, outcome) {
      if (claims.has(operationId)) {
        return { created: false, claim: claims.get(operationId) };
      }
      if (outcomes.has(operationId)) throw new Error(`outcome already recorded for ${operationId}`);
      const at = new Date().toISOString();
      const claim = { binding, ...(pld ? { pld } : {}), ...(evidence ? { evidence } : {}), claimedAt: at };
      const recorded = { ...outcome, at };
      beforeCommit?.("claimRefused", operationId);
      claims.set(operationId, claim);
      outcomes.set(operationId, recorded);
      return { created: true };
    },
    // The claim alone, never creating one: a replay-only token (P1b) reads it.
    async getClaim(operationId) {
      return claims.get(operationId) ?? null;
    },
    async putStep(operationId, n, step, detail = undefined) {
      checkStepIndex(n);
      const recorded = steps.get(operationId) ?? new Map();
      if (recorded.has(n)) {
        if (recorded.get(n).step !== step) throw new StepConflict(`step ${n} of ${operationId} already recorded`);
        return;
      }
      recorded.set(n, { n, step, ...stepDetail(detail), at: new Date().toISOString() });
      steps.set(operationId, recorded);
    },
    async getSteps(operationId) {
      return [...(steps.get(operationId) ?? new Map()).values()].sort((a, b) => a.n - b.n).map(s => s.step);
    },
    async getStepRecords(operationId) {
      return [...(steps.get(operationId) ?? new Map()).values()].sort((a, b) => a.n - b.n).map(s => ({ ...s }));
    },
    async putStepAttempt(operationId, k, attempt) {
      checkAttempt(k, attempt);
      const key = `${operationId}#${k}`;
      if (stepAttempts.has(key)) throw new Error(`attempt ${k} of ${operationId} already recorded`);
      stepAttempts.set(key, { k, ...attemptRecord(attempt), at: new Date().toISOString() });
    },
    // Each transition reads and writes with no await in between: atomic here.
    async startRun(operationId, run) {
      checkRun(run);
      const current = currentRun(runStates.get(operationId));
      if (outcomes.has(operationId) || current.state !== "aborted" || current.run !== run - 1) return false;
      runStates.set(operationId, { run, state: "open", at: new Date().toISOString() });
      return true;
    },
    async refuseRun(operationId, run, outcome) {
      checkRun(run);
      const current = currentRun(runStates.get(operationId));
      if (outcomes.has(operationId) || current.state !== "aborted" || current.run !== run - 1) return false;
      const at = new Date().toISOString();
      const state = { run, state: "open", at };
      const recorded = { ...outcome, at };
      beforeCommit?.("refuseRun", operationId);
      runStates.set(operationId, state);
      outcomes.set(operationId, recorded);
      return true;
    },
    async abortRun(operationId, run, { reason }) {
      checkRun(run);
      const current = currentRun(runStates.get(operationId));
      if (outcomes.has(operationId) || current.state !== "open" || current.run !== run) throw new RunFenced(`run ${run} of ${operationId} can't be aborted`);
      runStates.set(operationId, { run, state: "aborted", reason, at: new Date().toISOString() });
    },
    async getRunState(operationId) {
      const current = currentRun(runStates.get(operationId));
      return { run: current.run, aborted: current.state === "aborted" };
    },
    async getStepAttempts(operationId) {
      return [...stepAttempts.entries()].filter(([key]) => key.startsWith(`${operationId}#`)).map(([, a]) => ({ ...a })).sort((a, b) => a.k - b.k);
    },
    async getOutcome(operationId) {
      return outcomes.get(operationId) ?? null;
    },
    async putOutcome(operationId, outcome, { run = undefined }: { run?: number } = {}) {
      // The fence first: a run that was aborted or superseded is told so,
      // even when its successor has already recorded the outcome.
      if (run !== undefined) {
        const current = currentRun(runStates.get(operationId));
        if (current.state !== "open" || current.run !== run) throw new RunFenced(`run ${run} of ${operationId} may not record the outcome`);
      }
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
