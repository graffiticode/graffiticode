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
// A store implements:
//   allocate({ uid, connectionId, taskId, inputDigest, idempotencyKey? })
//     -> { invocationId, seq, reused }   throws InvocationConflict

import { randomUUID } from "node:crypto";

export class InvocationConflict extends Error {}

export const sameInvocationBinding = (a, b) =>
  a.connectionId === b.connectionId && a.taskId === b.taskId && a.inputDigest === b.inputDigest;

export const newInvocationId = () => `inv-${randomUUID()}`;

export const createMemoryInvocationStore = () => {
  const keys = new Map();
  const seqs = new Map();
  return {
    async allocate({ uid, connectionId, taskId, inputDigest, idempotencyKey = null }) {
      const binding = { connectionId, taskId, inputDigest };
      const keyId = idempotencyKey ? JSON.stringify([uid, idempotencyKey]) : null;
      if (keyId && keys.has(keyId)) {
        const hit = keys.get(keyId);
        if (!sameInvocationBinding(hit.binding, binding)) throw new InvocationConflict("idempotency key reused");
        return { ...hit.invocation, reused: true };
      }
      const seqId = JSON.stringify([uid, taskId, connectionId]);
      const seq = (seqs.get(seqId) ?? 0) + 1;
      seqs.set(seqId, seq);
      const invocation = { invocationId: newInvocationId(), seq };
      if (keyId) keys.set(keyId, { binding, invocation });
      return { ...invocation, reused: false };
    },
  };
};
