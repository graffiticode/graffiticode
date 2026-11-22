// The durable command hold (C5d, docs/c5d-refusal-and-hold-plan.md decisions
// 6–11): an operator's act that keeps a pending command from every worker,
// recorded on the command and in its own history.
//
//   - The field, `hold` on `commands/{id}`, present only while held:
//       { n, actId, reason, note, decision, decidedBy, appliedBy, at, generation, leaseExpiresAt, readTime }
//   - The history, `commands/{id}/holds/{actId}`, one document per act:
//       { n, actId, act, reason, note, decision, decidedBy, appliedBy, at, generation, leaseExpiresAt, readTime, fencing, lifts }
//     `n` is one more than the largest in the history, so apply → lift →
//     apply gives 1, 2, 3.
//   - One transaction per act reads the command, `holds/{actId}` and the
//     whole history, then writes the field (set, or deleted by a lift) and
//     creates `holds/{actId}`. Nothing else on the command changes: no
//     `updatedAt`, owner, status, counts or subcollection.
//   - A retry (the same `actId`, after it committed) writes nothing and
//     answers `replayed: true` with the recorded act, whatever the command's
//     state is now. An act id used for a different act is refused
//     `act-id-reused`.
//   - Apply needs a `pending` command (`not-pending`) with no hold
//     (`already-held`), whose lease ended at least HOLD_MARGIN_MS before the
//     transaction's server read time (`lease-live`), so no Broker execution
//     its last owner was authorized for can still be running (decision 8).
//   - Lift needs a hold (`not-held`) whose act id is the one it names
//     (`hold-mismatch`).
//
// Who acts is not decided here: `appliedBy` is the identity the operator
// script verified (scripts/command-hold.js, decision 9). No Policy route or
// worker write reaches these functions.
//
// A store implements:
//   applyHold({ commandId, actId, reason, note, decision, decidedBy, appliedBy }) -> { replayed, record, hold }   throws CommandRefused
//   liftHold({ commandId, actId, lifts, reason, note, decision, decidedBy, appliedBy }) -> { replayed, record, hold: null }   throws CommandRefused
//   status(commandId) -> { command, hold, history } | null

import { CommandRefused, COMMAND_ID_RE } from "./commands.js";

// Broker's whole supported limit envelope, in server time (decision 8): the
// longest a Broker execution authorized at the lease's last instant can still
// run and record (maxExecutionMs at the largest configuration parseLimits
// accepts, 40 s + 40 s + 10 s), plus SKEW_MS for Policy's clock running ahead
// (packages/broker/src/limits.ts). Broker's limits spec fails if the envelope
// widens past it.
export const HOLD_MARGIN_MS = 100_000;
export const HOLD_REASON_RE = /^[a-z0-9-]{1,64}$/;
export const HOLD_NOTE_MAX = 500;
export const ACT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECISION_MAX = 500;
const ACTS = ["apply", "lift"];

const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

// Why an act's request is malformed, or null.
export const actProblem = ({ act, commandId, actId, reason, note, decision, decidedBy, appliedBy, lifts = null }) => {
  if (!ACTS.includes(act)) return "bad-request";
  if (typeof commandId !== "string" || !COMMAND_ID_RE.test(commandId)) return "bad-request";
  if (typeof actId !== "string" || !ACT_ID_RE.test(actId)) return "bad-request";
  if (typeof reason !== "string" || !HOLD_REASON_RE.test(reason)) return "bad-request";
  if (typeof note !== "string" || note.length > HOLD_NOTE_MAX) return "bad-request";
  if (!text(decision, DECISION_MAX) || !text(decidedBy, 200)) return "bad-request";
  if (!appliedBy || typeof appliedBy !== "object" || !text(appliedBy.email, 320) || appliedBy.verifiedVia !== "tokeninfo" || !text(appliedBy.azp, 320)) return "bad-request";
  if (act === "lift" ? typeof lifts !== "string" || !ACT_ID_RE.test(lifts) || lifts === actId : lifts !== null) return "bad-request";
  return null;
};

// What makes two requests the same act: everything the intent file fixes.
const SAME_ACT_FIELDS = ["act", "actId", "reason", "note", "decision", "decidedBy", "lifts"];
const sameAct = (record, request) => SAME_ACT_FIELDS.every(f => (record[f] ?? null) === (request[f] ?? null));

// The act decided on what one transaction read: the command, the act's own
// history document, every history document, and the server read time.
// -> { replayed: true, record } | { replayed: false, record, hold }   throws CommandRefused
export const decideAct = ({ request, command, existing, history, readTime }) => {
  const problem = actProblem(request);
  if (problem) throw new CommandRefused(problem);
  if (existing) {
    if (!sameAct(existing, request)) throw new CommandRefused("act-id-reused");
    return { replayed: true, record: existing };
  }
  if (!command) throw new CommandRefused("command-not-found");
  const { act, actId, reason, note, decision, decidedBy, appliedBy } = request;
  if (act === "apply") {
    if (command.status !== "pending") throw new CommandRefused("not-pending");
    if (command.hold) throw new CommandRefused("already-held");
    if (command.owner.leaseExpiresAt + HOLD_MARGIN_MS > readTime) throw new CommandRefused("lease-live");
  } else {
    if (!command.hold) throw new CommandRefused("not-held");
    if (command.hold.actId !== request.lifts) throw new CommandRefused("hold-mismatch");
  }
  const n = history.reduce((max, h) => Math.max(max, Number.isInteger(h?.n) ? h.n : 0), 0) + 1;
  const at = new Date(readTime).toISOString();
  const { generation, leaseExpiresAt } = command.owner;
  const base = { n, actId, reason, note, decision, decidedBy, appliedBy: { email: appliedBy.email, verifiedVia: appliedBy.verifiedVia, azp: appliedBy.azp }, at, generation, leaseExpiresAt, readTime };
  // Apply is refused while the lease could still be live, so its only
  // fencing outcome is an expired lease (decision 10).
  const record = { ...base, act, fencing: act === "apply" ? "lease-expired" : null, lifts: act === "lift" ? request.lifts : null };
  return { replayed: false, record, hold: act === "apply" ? base : null };
};

// A transaction the database ended for contention, rather than refused:
// ABORTED, or one killed while it waited on a lock (the emulator answers
// INVALID_ARGUMENT, "Transaction is invalid or closed", for two acts that
// both read the history). The client's own retries cover only ABORTED at
// commit.
const CONTENTION_ATTEMPTS = 5;
const contended = e => !(e instanceof CommandRefused) &&
  (e?.code === 10 || (e?.code === 3 && /transaction is invalid or closed/i.test(String(e?.details ?? e?.message ?? ""))));

const answer = (decided, commandId) => ({ commandId, replayed: decided.replayed, record: decided.record, hold: decided.replayed ? undefined : decided.hold });

// Firestore, in Policy's database. The field is written with `update`, never
// `set`, so nothing else on the command moves; the history document with
// `create`, so one act id is one entry even when it races itself. The read
// time is the transaction snapshot's, Firestore's clock, never the caller's.
export const createFirestoreHolds = db => {
  const commandRef = commandId => db.collection("commands").doc(commandId);
  // Loaded here, so the package index stays free of the Firestore client.
  const fieldValue = import("firebase-admin/firestore").then(m => m.FieldValue);
  const act = async request => {
    const problem = actProblem(request);
    if (problem) throw new CommandRefused(problem);
    const FieldValue = await fieldValue;
    // An act is idempotent by its id, so a transaction the database killed
    // for contention is simply run again: it then commits, replays, or is
    // refused on what it reads.
    for (let attempt = 1; ; attempt++) {
      try {
        return await once(request, FieldValue);
      } catch (e) {
        if (attempt >= CONTENTION_ATTEMPTS || !contended(e)) throw e;
      }
    }
  };
  const once = (request, FieldValue) => db.runTransaction(async tx => {
    const ref = commandRef(request.commandId);
    const actRef = ref.collection("holds").doc(request.actId);
    const snap = await tx.get(ref);
    const existing = await tx.get(actRef);
    const history = await tx.get(ref.collection("holds"));
    const decided = decideAct({
      request,
      command: snap.exists ? snap.data() : null,
      existing: existing.exists ? existing.data() : null,
      history: history.docs.map(d => d.data()),
      readTime: snap.readTime.toMillis(),
    });
    if (!decided.replayed) {
      tx.update(ref, { hold: decided.hold ?? FieldValue.delete() });
      tx.create(actRef, decided.record);
    }
    return answer(decided, request.commandId);
  });
  return {
    applyHold: request => act({ ...request, act: "apply", lifts: null }),
    liftHold: request => act({ ...request, act: "lift" }),
    async status(commandId) {
      const snap = await commandRef(commandId).get();
      if (!snap.exists) return null;
      const history = (await commandRef(commandId).collection("holds").get()).docs.map(d => d.data()).sort((a, b) => a.n - b.n);
      const command = snap.data();
      return { command, hold: command.hold ?? null, history };
    },
  };
};

// Memory, over the memory command store's documents (commands.js), and the
// memory command backend's (command-records.js) when given, so the history is
// a subcollection as the records see it. Each act reads and writes with no
// `await` between, as the command store's own updates do, so it is one
// transaction against every other write; a records transaction that read the
// command meanwhile runs again (createMemoryCommandBackend). `now` is the
// server read time.
export const createMemoryHolds = ({ commandStore, backend = null, now = () => Date.now() }) => {
  const docs = backend?.docs ?? new Map();
  const prefix = commandId => `commands/${commandId}/holds/`;
  const historyOf = commandId => [...docs.entries()].filter(([k]) => k.startsWith(prefix(commandId)) && !k.slice(prefix(commandId).length).includes("/")).map(([, d]) => d);
  const act = async request => {
    const { commandId, actId } = request;
    const command = commandStore.commands.get(commandId) ?? null;
    const decided = decideAct({
      request,
      command: command && structuredClone(command),
      existing: structuredClone(docs.get(`${prefix(commandId)}${actId}`) ?? null),
      history: historyOf(commandId),
      readTime: now(),
    });
    if (!decided.replayed) {
      const next = { ...command };
      if (decided.hold) next.hold = structuredClone(decided.hold);
      else delete next.hold;
      commandStore.commands.set(commandId, next);
      docs.set(`${prefix(commandId)}${actId}`, structuredClone(decided.record));
    }
    return structuredClone(answer(decided, commandId));
  };
  return {
    docs,
    applyHold: request => act({ ...request, act: "apply", lifts: null }),
    liftHold: request => act({ ...request, act: "lift" }),
    async status(commandId) {
      const command = commandStore.commands.get(commandId);
      if (!command) return null;
      return structuredClone({ command, hold: command.hold ?? null, history: historyOf(commandId).sort((a, b) => a.n - b.n) });
    },
  };
};
