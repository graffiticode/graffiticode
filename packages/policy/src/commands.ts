// Command records (B5, docs/b5-commands-plan.md §3): an immediate command's
// identity, protocol and ownership, in Policy's own database beside the
// invocations it runs under.
//
//   - A command is allocated atomically with its idempotency key and its
//     invocation, and the key records the execution protocol (D2a): the
//     first allocation wins, and the protocol never changes. A key already
//     allocated by the legacy compile path stays `legacy`; a key allocated
//     here is `command`, and the legacy path refuses it.
//   - The command id is `c:` and the hex SHA-256 of `[uid, idempotencyKey]`,
//     so a key names exactly one command.
//   - The caller's request is kept at allocation as its exact JSON text (key
//     order preserved), so recovery can finish initialization without the
//     caller (§6 step 2).
//   - Ownership is a lease with a fencing generation. The first lease is
//     generation 1; a takeover is allowed only once the lease has expired and
//     increments the generation. An owner request needs a live lease and
//     exactly the current generation (`ownerRefusal`), and a refused request
//     changes nothing.
//
// A store implements:
//   allocate({ uid, connectionId, taskId, inputDigest, idempotencyKey, lang, request, worker, now, leaseMs, create? })
//     -> { protocol: "legacy", invocationId, seq }
//      | { protocol: "command", reused, command }          throws InvocationConflict
//      | { protocol: "none" }   only with create: false, for a key nothing holds
//   get(commandId) -> command | null
//   getRequest(commandId) -> string | null
//   renewLease({ commandId, worker, generation, now, leaseMs }) -> command   throws CommandRefused
//   takeOver({ commandId, worker, expectedGeneration, now, leaseMs }) -> command   throws CommandRefused
//   listDue({ now, limit }) -> [command]   the commands recovery takes over (§7):
//     pending with an expired lease, or with a publication due and an expired lease

import { createHash } from "node:crypto";
import { InvocationConflict, sameInvocationBinding } from "./invocations.js";

export const COMMAND_SCHEMA = 1;
export const COMMAND_LEASE_MS = 60_000;
// A payload is capped at 512 KiB of serialized UTF-8 (decision 2).
export const MAX_PAYLOAD_BYTES = 512 * 1024;

export class CommandRefused extends Error {
  declare reason: string;
  constructor(reason: string) {
    super(`command refused: ${reason}`);
    this.reason = reason;
  }
}

export const keyDigest = (uid, idempotencyKey) => createHash("sha256").update(JSON.stringify([uid, idempotencyKey])).digest("hex");
export const commandIdFor = (uid, idempotencyKey) => `c:${keyDigest(uid, idempotencyKey)}`;
export const COMMAND_ID_RE = /^c:[a-f0-9]{64}$/;
export const WORKER_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

// The request's exact text, if it is a JSON object within the cap; else null.
export const requestProblem = text => {
  if (typeof text !== "string") return "bad-request";
  if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) return "input-too-large";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "bad-request";
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? null : "bad-request";
};

// Why an owner request is refused, or null: it needs exactly the current
// generation and a live lease.
export const ownerRefusal = (command, { generation, now }) => {
  if (!command) return "command-not-found";
  if (command.owner.generation !== generation) return "stale-generation";
  if (command.owner.leaseExpiresAt <= now) return "lease-expired";
  return null;
};

export const newCommandRecord = ({ commandId, uid, idempotencyKey, invocationId, seq, lang, connectionId, taskId, inputDigest, worker, now, leaseMs }) => ({
  schema: COMMAND_SCHEMA,
  commandId,
  uid,
  idempotencyKey,
  invocationId,
  seq,
  protocol: "command",
  lang,
  taskId,
  connectionId,
  binding: { connectionId, taskId, inputDigest },
  phase: "allocated",
  admission: null,
  owner: { worker, generation: 1, leaseExpiresAt: now + leaseMs },
  status: "pending",
  result: { state: "none", digest: null },
  publication: { state: "none", resultDigest: null },
  stages: {},
  counts: { bound: 0, completed: 0, failed: 0, partial: 0, uncertain: 0 },
  revisions: null,
  // Extension point (Track E1): B5 never sets it.
  runRef: null,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
});

// The lease renewed by its owner: same generation, a new expiry.
export const renewedLease = (command, { worker, generation, now, leaseMs }) => {
  const refusal = ownerRefusal(command, { generation, now });
  if (refusal) throw new CommandRefused(refusal);
  if (command.owner.worker !== worker) throw new CommandRefused("stale-generation");
  if (command.status !== "pending") throw new CommandRefused("command-finished");
  return { ...command, owner: { worker, generation, leaseExpiresAt: now + leaseMs }, updatedAt: new Date(now).toISOString() };
};

// Ownership taken over once the lease has expired: the next generation.
export const takenOverLease = (command, { worker, expectedGeneration, now, leaseMs }) => {
  if (!command) throw new CommandRefused("command-not-found");
  if (command.owner.generation !== expectedGeneration) throw new CommandRefused("stale-generation");
  if (command.owner.leaseExpiresAt > now) throw new CommandRefused("lease-live");
  // A due publication is recovered too (§7); a finished command with nothing
  // due has nothing to own.
  if (command.status !== "pending" && command.publication?.state !== "due") throw new CommandRefused("command-finished");
  return { ...command, owner: { worker, generation: expectedGeneration + 1, leaseExpiresAt: now + leaseMs }, updatedAt: new Date(now).toISOString() };
};

// What a caller sees: never the request payload.
export const commandSummary = command => command && ({
  commandId: command.commandId,
  invocationId: command.invocationId,
  seq: command.seq,
  protocol: command.protocol,
  lang: command.lang,
  taskId: command.taskId,
  connectionId: command.connectionId,
  phase: command.phase,
  status: command.status,
  result: command.result,
  publication: command.publication,
  generation: command.owner.generation,
  leaseExpiresAt: command.owner.leaseExpiresAt,
  runRef: command.runRef,
});

// `invocationStore` is the memory invocation store the command shares keys,
// sequences and invocations with, as Policy's database does.
export const createMemoryCommandStore = ({ invocationStore }) => {
  const commands = new Map();
  const requests = new Map();
  const update = (commandId, fn) => {
    const next = fn(commands.get(commandId) ?? null);
    commands.set(commandId, next);
    return structuredClone(next);
  };
  return {
    commands,
    async allocate({ uid, connectionId, taskId, inputDigest, idempotencyKey, lang, request, worker, now, leaseMs = COMMAND_LEASE_MS, create = true }) {
      const binding = { connectionId, taskId, inputDigest };
      const hit = invocationStore.keyRecord(uid, idempotencyKey);
      if (!hit && !create) return { protocol: "none" };
      if (hit) {
        if (!sameInvocationBinding(hit.binding, binding)) throw new InvocationConflict("idempotency key reused");
        if ((hit.protocol ?? "legacy") === "legacy") return { protocol: "legacy", invocationId: hit.invocation.invocationId, seq: hit.invocation.seq };
        return { protocol: "command", reused: true, command: structuredClone(commands.get(hit.commandId)) };
      }
      const commandId = commandIdFor(uid, idempotencyKey);
      const { invocationId, seq } = invocationStore.createInvocation({ uid, binding, protocol: "command", commandId, idempotencyKey });
      const command = newCommandRecord({ commandId, uid, idempotencyKey, invocationId, seq, lang, connectionId, taskId, inputDigest, worker, now, leaseMs });
      commands.set(commandId, command);
      requests.set(commandId, request);
      return { protocol: "command", reused: false, command: structuredClone(command) };
    },
    async get(commandId) {
      return commands.has(commandId) ? structuredClone(commands.get(commandId)) : null;
    },
    async getRequest(commandId) {
      return requests.get(commandId) ?? null;
    },
    async renewLease({ commandId, worker, generation, now, leaseMs = COMMAND_LEASE_MS }) {
      return update(commandId, c => renewedLease(c, { worker, generation, now, leaseMs }));
    },
    async takeOver({ commandId, worker, expectedGeneration, now, leaseMs = COMMAND_LEASE_MS }) {
      return update(commandId, c => takenOverLease(c, { worker, expectedGeneration, now, leaseMs }));
    },
    async listDue({ now, limit }) {
      return [...commands.values()]
        .filter(c => (c.status === "pending" || c.publication?.state === "due") && c.owner.leaseExpiresAt < now)
        .sort((a, b) => a.owner.leaseExpiresAt - b.owner.leaseExpiresAt)
        .slice(0, limit)
        .map(c => structuredClone(c));
    },
  };
};
