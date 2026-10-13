// Logical invocations, allocated by the authenticated entry point (the
// gateway) before it dispatches a compile through a selected connection. An
// invocation id is what write receipts hang off, so it must outlive the HTTP
// request and the job that carries it:
//
//   - An idempotency key, scoped to the user, returns the same invocation for
//     the same task chain, connection and input. HTTP retries and job
//     redispatches send the same key, so they continue the same invocation and
//     reuse its receipts. Reusing a key for different input is refused.
//   - No key, or a new one, is an intentional rerun: a new invocation, whose
//     writes run again.
//   - `seq` increases per (user, task chain, connection), so a later reader can
//     tell a newer invocation from an older one that finished late.
//
// Contract v2 (capability plan W4): an invocation allocated for chain
// admission (`admission: true`) is marked `contract: 2` for good. Only a
// marked invocation can have a plan attached, and a marked invocation never
// runs without its plan. A retry reports the invocation's own marker and plan.
//
// A store implements:
//   allocate({ uid, connectionId, taskId, inputDigest, idempotencyKey?, admission? })
//     -> { invocationId, seq, reused, contract, planDigest }   throws InvocationConflict
//   get(invocationId) -> { invocationId, uid, connectionId, taskId, inputDigest, seq, contract, planDigest } | null
//   getPlan(planDigest) -> plan | null
//   commitPlan({ leaseId, invocationId, planDigest, plan, revisions, readTime, maxAgeMs, now? })
//     -> { created }   throws AdmissionRefused(reason)

import { randomUUID } from "node:crypto";

export class InvocationConflict extends Error {}

// The plan write refused: the lease was invalidated (revision-retiring), the
// invocation isn't eligible (invocation-incompatible) or already has another
// plan (plan-mismatch), or the decision is too old (admission-stale).
export class AdmissionRefused extends Error {
  declare reason: string;
  constructor(reason: string) {
    super(`admission refused: ${reason}`);
    this.reason = reason;
  }
}

export const sameInvocationBinding = (a, b) =>
  a.connectionId === b.connectionId && a.taskId === b.taskId && a.inputDigest === b.inputDigest;

export const newInvocationId = () => `inv-${randomUUID()}`;

// `leases` is shared with createMemoryLeaseFence, as Policy's database is.
export const createMemoryInvocationStore = ({ leases = new Map() } = {}) => {
  const keys = new Map();
  const seqs = new Map();
  const invocations = new Map();
  const plans = new Map();
  return {
    invocations,
    plans,
    async allocate({ uid, connectionId, taskId, inputDigest, idempotencyKey = null, admission = false }) {
      const binding = { connectionId, taskId, inputDigest };
      const keyId = idempotencyKey ? JSON.stringify([uid, idempotencyKey]) : null;
      if (keyId && keys.has(keyId)) {
        const hit = keys.get(keyId);
        if (!sameInvocationBinding(hit.binding, binding)) throw new InvocationConflict("idempotency key reused");
        const stored = invocations.get(hit.invocation.invocationId);
        return { ...hit.invocation, reused: true, contract: stored.contract, planDigest: stored.planDigest };
      }
      const seqId = JSON.stringify([uid, taskId, connectionId]);
      const seq = (seqs.get(seqId) ?? 0) + 1;
      seqs.set(seqId, seq);
      const invocation = { invocationId: newInvocationId(), seq };
      const contract = admission ? 2 : 1;
      invocations.set(invocation.invocationId, { invocationId: invocation.invocationId, uid, ...binding, seq, contract, planDigest: null });
      if (keyId) keys.set(keyId, { binding, invocation });
      return { ...invocation, reused: false, contract, planDigest: null };
    },
    async get(invocationId) {
      const found = invocations.get(invocationId);
      return found ? { ...found } : null;
    },
    async getPlan(planDigest) {
      return plans.has(planDigest) ? structuredClone(plans.get(planDigest).plan) : null;
    },
    async commitPlan({ leaseId, invocationId, planDigest, plan, revisions, readTime, maxAgeMs, now = () => Date.now() }) {
      const startedAt = now();
      const lease = leases.get(leaseId);
      const invocation = invocations.get(invocationId);
      if (!lease || lease.state !== "active") throw new AdmissionRefused("revision-retiring");
      if (!invocation || invocation.contract !== 2) throw new AdmissionRefused("invocation-incompatible");
      if (invocation.planDigest && invocation.planDigest !== planDigest) throw new AdmissionRefused("plan-mismatch");
      if (startedAt - Number(readTime) > maxAgeMs) throw new AdmissionRefused("admission-stale");
      leases.delete(leaseId);
      if (invocation.planDigest) return { created: false };
      plans.set(planDigest, { plan: structuredClone(plan), invocationId, revisions });
      invocation.planDigest = planDigest;
      return { created: true };
    },
  };
};

// The lease side of the fence in memory: `invalidate(revision)` stands for
// retirement's step 2 (@graffiticode/policy/revisions).
export const createMemoryLeaseFence = ({ leases = new Map(), now = () => Date.now() } = {}) => {
  let next = 0;
  return {
    leases,
    async register(revisions) {
      const id = `lease-${++next}`;
      leases.set(id, { revisions: [...revisions], state: "active" });
      return { id, readTime: now() };
    },
    invalidate(revision) {
      for (const lease of leases.values()) if (lease.revisions.includes(revision)) lease.state = "invalidated";
    },
  };
};

// Approved revisions in memory: `records` maps "lang/revision" to a record.
export const createMemoryApprovals = (records = new Map()) => ({
  records,
  async read(wanted) {
    return wanted.map(({ lang, revision }) => ({
      lang,
      revision,
      record: records.get(`${lang}/${revision}`) ?? null,
      languageKnown: [...records.keys()].some(k => k.startsWith(`${lang}/`)),
    }));
  },
  async current(lang, revision) {
    return records.get(`${lang}/${revision}`) ?? null;
  },
});
