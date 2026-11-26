// Option (c) of docs/c4-continuation-race-review.md, as an executable
// state machine: bindings and operations in the api's store, items and
// tombstones in the console's, authority published at "ready" (C4), and C4
// reading active bindings from its own store (the owner's choice,
// 2026-11-25).
//
// Every exported step is exactly ONE Firestore transaction in exactly ONE
// store; a step never reads the other store inside its transaction. Evidence
// from the other store (a C0 registration, an api operation snapshot) is
// passed in as an argument, as it would arrive over an authenticated call.
// Steps are named after the review's transition table (§5) and the shared
// machinery (§3).
//
// This is evidence for the protocol, not production code: no route, no
// deploy configuration and no production collection uses it.

import { createHash, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Errors, principals, digests

export class ProtocolError extends Error {
  constructor(code, { temporary = false, detail } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.temporary = temporary;
  }
}
const refuse = (code, opts) => {
  throw new ProtocolError(code, opts);
};

const canonical = value =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .filter(k => value[k] !== undefined)
          .sort()
          .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(",")}}`;

export const digestOf = value => createHash("sha256").update(canonical(value)).digest("hex");

// Full-principal equality (decision 3): every field, the free-plan workspace
// and the installation included. A uid alone never matches.
export const samePrincipal = (a, b) => Boolean(a) && Boolean(b) && canonical(a) === canonical(b);

// ---------------------------------------------------------------------------
// Collections

const API = {
  barrier: s => s.doc("l0182-continuation-barrier", "state"),
  op: (s, opId) => s.doc("respondent-operations", opId),
  ops: s => s.col("respondent-operations"),
  binding: (s, S) => s.doc("respondent-bindings", S),
  bindings: s => s.col("respondent-bindings"),
  history: (s, S, revision) => s.doc("respondent-binding-history", `${S}:${revision}`),
  historyAll: s => s.col("respondent-binding-history"),
  assignment: (s, S) => s.doc("l0182-assignments", S),
};
const CON = {
  item: (s, id) => s.doc("items", id),
  items: s => s.col("items"),
  cop: (s, opId) => s.doc("continuation-ops", opId),
  cops: s => s.col("continuation-ops"),
  claim: (s, claimId) => s.doc("claims", claimId),
};

const TERMINAL = new Set(["completed", "cancelled"]);
const LOCKED_ITEM_STATES = new Set(["continuing", "pending", "finalizing"]);

// ---------------------------------------------------------------------------
// The creation barrier (§3): one api document. A missing barrier is closed,
// so an uninitialised store fails closed.

export async function openBarrier(api) {
  return api.run(async tx => {
    const ref = API.barrier(api);
    const cur = (await tx.get(ref)).data();
    tx.set(ref, { state: "open", epoch: (cur?.epoch ?? 0) + 1 });
  });
}

export async function closeBarrier(api) {
  return api.run(async tx => {
    const ref = API.barrier(api);
    const cur = (await tx.get(ref)).data();
    tx.set(ref, { state: "closed", epoch: (cur?.epoch ?? 0) + 1 });
  });
}

// ---------------------------------------------------------------------------
// Fixtures: console items

// A console item. `owner` is its principal; `respondentSession` the session
// its programs carry (its own id for a fresh item).
export async function createItem(con, { id, owner, respondentSession = id, state = "open" }) {
  await CON.item(con, id).create({ id, owner, respondentSession, state, lockOp: null, version: 1 });
}

// The console's write paths (§3 "Console item states"): answers or
// regenerations, edits, deletion. Deletion after unlock is a separate,
// undecided contract (§3), so the harness never deletes; it only reports
// whether the state table permits the attempt.
const PERMITS = {
  open: { answer: true, edit: true, delete: true },
  active: { answer: true, edit: true, delete: true },
  continuing: { answer: false, edit: false, delete: false },
  "read-only": { answer: false, edit: false, delete: false },
  pending: { answer: false, edit: false, delete: false },
  finalizing: { answer: false, edit: false, delete: false },
  cancelled: { answer: false, edit: false, delete: false },
};

export async function consoleWrite(con, itemId, kind) {
  return con.run(async tx => {
    const ref = CON.item(con, itemId);
    const item = (await tx.get(ref)).data();
    if (!item) refuse("unknown-item");
    if (!PERMITS[item.state]?.[kind]) refuse("item-locked", { detail: `${itemId} is ${item.state}` });
    if (kind !== "delete") tx.update(ref, { version: item.version + 1 });
    return { itemId, kind, version: item.version + 1 };
  });
}

// ---------------------------------------------------------------------------
// C0 register (api): barrier open; no record, or the same digest. Proves the
// api-side half of authority over S: with an active binding, the caller is its
// principal and the source is its destination at the expected revision;
// unbound, the source IS the session's item at revision 0 (the console proves
// its owner at C1). T's id is allocated here and kept for replay.

export async function register(api, request) {
  const { opId, session: S, source: X, sourceVersion, expectedRevision, caller, destPrincipal } = request;
  const digest = digestOf({ opId, S, X, sourceVersion, expectedRevision, caller, destPrincipal });
  return api.run(async tx => {
    const opRef = API.op(api, opId);
    const [barrier, opSnap, bindingSnap] = await Promise.all([
      tx.get(API.barrier(api)),
      tx.get(opRef),
      tx.get(API.binding(api, S)),
    ]);
    if (opSnap.exists) {
      const op = opSnap.data();
      if (op.digest !== digest) refuse("operation-mismatch");
      return op;
    }
    if (barrier.data()?.state !== "open") refuse("barrier-closed");
    const active = bindingSnap.data()?.active ?? null;
    if (active) {
      if (expectedRevision !== active.revision) refuse("revision-changed");
      if (X !== active.destination) refuse("not-current-holder");
      if (!samePrincipal(caller, active.principal)) refuse("not-respondent");
    } else if (expectedRevision !== 0 || X !== S) {
      refuse("not-session-source");
    }
    const op = {
      opId,
      state: "registered",
      digest,
      request: { session: S, source: X, sourceVersion, expectedRevision, caller, destPrincipal },
      T: `dest-${randomUUID().slice(0, 12)}`,
      ack: {},
      result: null,
    };
    tx.create(opRef, op);
    return op;
  });
}

// ---------------------------------------------------------------------------
// C1 allocate (console): C0's result; no cancelled tombstone for opId (read
// HERE, in this transaction); X open at the registered version, owned by the
// caller and carrying S; T absent.

export async function allocate(con, reg) {
  const { opId, T, request } = reg;
  const { session: S, source: X, sourceVersion, caller, destPrincipal, expectedRevision } = request;
  return con.run(async tx => {
    const copRef = CON.cop(con, opId);
    const [copSnap, xSnap, tSnap] = await Promise.all([tx.get(copRef), tx.get(CON.item(con, X)), tx.get(CON.item(con, T))]);
    const cop = copSnap.data();
    if (cop?.state === "cancelled") refuse("cancelled");
    if (cop) return cop; // allocated (or later) by this opId: a no-op
    const x = xSnap.data();
    if (!x) refuse("unknown-item");
    if (x.state !== "open" && !(x.state === "active" && x.lockOp === null)) refuse("item-locked");
    if (x.version !== sourceVersion) refuse("source-changed");
    if (!samePrincipal(x.owner, caller)) refuse("not-respondent");
    if (x.respondentSession !== S) refuse("not-session-source");
    if (tSnap.exists) refuse("destination-exists");
    tx.update(CON.item(con, X), { state: "continuing", lockOp: opId, priorState: x.state });
    tx.create(CON.item(con, T), {
      id: T,
      owner: destPrincipal,
      respondentSession: S,
      state: "pending",
      lockOp: opId,
      version: 1,
    });
    const created = { opId, state: "allocated", S, X, T, revision: expectedRevision + 1 };
    tx.create(copRef, created);
    return created;
  });
}

// ---------------------------------------------------------------------------
// C2 bind-prepare (api).

export async function bindPrepare(api, opId) {
  return api.run(async tx => {
    const opRef = API.op(api, opId);
    const op = (await tx.get(opRef)).data();
    if (!op) refuse("unknown-operation");
    const bRef = API.binding(api, op.request.session);
    const binding = (await tx.get(bRef)).data() ?? { active: null, prepared: null };
    if (op.state === "cancelled") refuse("operation-terminal", { detail: "cancelled" });
    if (op.state === "completed") return op;
    if (op.state === "prepared" && binding.prepared?.opId === opId) return op;
    if (op.state !== "registered") refuse("unexpected-phase", { detail: op.state });
    if ((binding.active?.revision ?? 0) !== op.request.expectedRevision) refuse("revision-changed");
    if (binding.prepared) refuse("respondent-continuing", { temporary: true });
    tx.set(bRef, { active: binding.active ?? null, prepared: { opId, revision: op.request.expectedRevision + 1 } });
    tx.update(opRef, { state: "prepared" });
    return { ...op, state: "prepared" };
  });
}

// ---------------------------------------------------------------------------
// C3 finalize (console): needs the api's evidence that C2 committed (the
// operation snapshot, prepared or completed).

export async function finalize(con, apiOp) {
  if (!apiOp || !["prepared", "completed"].includes(apiOp.state)) refuse("not-prepared");
  const { opId } = apiOp;
  return con.run(async tx => {
    const copRef = CON.cop(con, opId);
    const cop = (await tx.get(copRef)).data();
    if (!cop) refuse("not-allocated");
    if (cop.state === "cancelled") refuse("cancelled");
    if (cop.state === "finalized" || cop.state === "completed") return cop;
    const [x, t] = (await Promise.all([tx.get(CON.item(con, cop.X)), tx.get(CON.item(con, cop.T))])).map(s => s.data());
    if (x?.state !== "continuing" || x.lockOp !== opId) refuse("source-not-locked");
    if (t?.state !== "pending" || t.lockOp !== opId) refuse("destination-not-pending");
    tx.update(CON.item(con, cop.X), { state: "read-only" });
    tx.update(CON.item(con, cop.T), { state: "finalizing" });
    tx.update(copRef, { state: "finalized" });
    return { ...cop, state: "finalized" };
  });
}

// ---------------------------------------------------------------------------
// C3a finalized acknowledgement (api): recorded only if every field matches
// what the operation expects, and the operation isn't terminal.

export async function ackFinalized(api, ack) {
  const { opId, revision, T, X } = ack;
  return api.run(async tx => {
    const opRef = API.op(api, opId);
    const op = (await tx.get(opRef)).data();
    if (!op) refuse("unknown-operation");
    if (op.state === "cancelled") refuse("operation-terminal", { detail: "cancelled" });
    const expected = { revision: op.request.expectedRevision + 1, T: op.T, X: op.request.source };
    if (canonical(expected) !== canonical({ revision, T, X })) refuse("ack-mismatch");
    // A replay of a completed operation: the identical acknowledgement is a
    // no-op that returns the recorded state; it never writes.
    if (op.state === "completed") {
      if (canonical(op.ack?.finalized) !== canonical(expected)) refuse("ack-mismatch");
      return op;
    }
    if (op.state !== "prepared") refuse("not-prepared");
    if (op.ack?.finalized) return op;
    tx.update(opRef, { "ack.finalized": expected });
    return { ...op, ack: { ...op.ack, finalized: expected } };
  });
}

// ---------------------------------------------------------------------------
// C4 activate (api): the point of no return, and authority publication at
// "ready". Authority, its immutable history entry and the operation result
// are written in ONE transaction; a completed operation is returned as
// recorded, with no writes.

export async function activate(api, opId) {
  return api.run(async tx => {
    const opRef = API.op(api, opId);
    const op = (await tx.get(opRef)).data();
    if (!op) refuse("unknown-operation");
    const S = op.request.session;
    const revision = op.request.expectedRevision + 1;
    const bRef = API.binding(api, S);
    const hRef = API.history(api, S, revision);
    const [bSnap, hSnap] = await Promise.all([tx.get(bRef), tx.get(hRef)]);
    if (op.state === "completed") return op.result;
    if (op.state === "cancelled") refuse("operation-terminal", { detail: "cancelled" });
    if (op.state !== "prepared") refuse("not-prepared");
    if (!op.ack?.finalized) refuse("not-ready");
    const binding = bSnap.data() ?? { active: null, prepared: null };
    if (binding.prepared?.opId !== opId) refuse("not-prepared");
    if ((binding.active?.revision ?? 0) !== op.request.expectedRevision) refuse("revision-changed");
    if (hSnap.exists) refuse("history-conflict");
    const active = { principal: op.request.destPrincipal, revision, opId, destination: op.T };
    const result = { revision, destination: op.T };
    tx.set(bRef, { active, prepared: null });
    tx.create(hRef, { session: S, revision, principal: active.principal, opId, destination: op.T });
    tx.update(opRef, { state: "completed", result });
    return result;
  });
}

// ---------------------------------------------------------------------------
// C5 unlock (console): needs the api's evidence that C4 committed.

export async function unlock(con, apiOp) {
  if (apiOp?.state !== "completed") refuse("not-activated");
  const { opId } = apiOp;
  return con.run(async tx => {
    const copRef = CON.cop(con, opId);
    const cop = (await tx.get(copRef)).data();
    if (!cop) refuse("not-allocated");
    if (cop.state === "completed") return cop;
    if (cop.state !== "finalized") refuse("unexpected-phase", { detail: cop.state });
    const t = (await tx.get(CON.item(con, cop.T))).data();
    if (t?.state !== "finalizing" || t.lockOp !== opId) refuse("destination-not-finalizing");
    tx.update(CON.item(con, cop.T), { state: "active", lockOp: null });
    tx.update(copRef, { state: "completed" });
    return { ...cop, state: "completed" };
  });
}

// ---------------------------------------------------------------------------
// C-cancel. The api half races C4 on the same operation record, so exactly
// one wins; after C4 it is refused. The console half then writes the
// tombstone (created even if C1 never ran) and reverts only locks carrying
// THIS opId, in one console transaction.

export async function cancelApi(api, opId) {
  return api.run(async tx => {
    const opRef = API.op(api, opId);
    const op = (await tx.get(opRef)).data();
    if (!op) refuse("unknown-operation");
    const bRef = API.binding(api, op.request.session);
    const binding = (await tx.get(bRef)).data();
    if (op.state === "cancelled") return op;
    if (op.state === "completed") refuse("past-point-of-no-return");
    tx.update(opRef, { state: "cancelled" });
    if (binding?.prepared?.opId === opId) tx.update(bRef, { prepared: null });
    return { ...op, state: "cancelled" };
  });
}

export async function cancelConsole(con, apiOp) {
  if (apiOp?.state !== "cancelled") refuse("not-cancelled");
  const { opId, T } = apiOp;
  const X = apiOp.request.source;
  return con.run(async tx => {
    const copRef = CON.cop(con, opId);
    const [copSnap, xSnap, tSnap] = await Promise.all([tx.get(copRef), tx.get(CON.item(con, X)), tx.get(CON.item(con, T))]);
    const x = xSnap.data();
    const t = tSnap.data();
    tx.set(copRef, { ...(copSnap.data() ?? { opId, X, T }), state: "cancelled" });
    if (x && x.lockOp === opId && (x.state === "continuing" || x.state === "read-only")) {
      tx.update(CON.item(con, X), { state: x.priorState ?? "open", lockOp: null });
    }
    if (t && t.lockOp === opId && (t.state === "pending" || t.state === "finalizing")) {
      tx.update(CON.item(con, T), { state: "cancelled" });
    }
    return { opId, tombstone: true };
  });
}

// ---------------------------------------------------------------------------
// Submission (S2 to S4). S2 for an unbound session reads the console's item
// (outside any api transaction); S4 is one api transaction over every
// session's binding and assignment, all or nothing.

export async function deriveAuthority(con, S) {
  const item = (await CON.item(con, S).get()).data();
  return item && item.respondentSession === S ? { principal: item.owner } : { unknown: true };
}

export async function submit(api, { sessions, caller, submitter, taskId, derived = {} }) {
  return api.run(async tx => {
    const bindings = await Promise.all(sessions.map(S => tx.get(API.binding(api, S))));
    const assignments = await Promise.all(sessions.map(S => tx.get(API.assignment(api, S))));
    const freezes = [];
    sessions.forEach((S, i) => {
      const binding = bindings[i].data() ?? { active: null, prepared: null };
      if (binding.prepared) refuse("respondent-continuing", { temporary: true, detail: S });
      let authority;
      if (binding.active) authority = { principal: binding.active.principal, revision: binding.active.revision };
      else if (derived[S]?.principal) authority = { principal: derived[S].principal, revision: 0 };
      else refuse("respondent-unknown", { detail: S });
      if (!samePrincipal(caller, authority.principal)) refuse("not-respondent", { detail: S });
      const existing = assignments[i].data()?.frozen;
      if (existing) {
        if (existing.revision === authority.revision && samePrincipal(existing.principal, authority.principal)) return;
        refuse("already-frozen", { detail: S });
      }
      freezes.push({ S, frozen: { principal: authority.principal, revision: authority.revision, submitter, taskId } });
    });
    for (const { S, frozen } of freezes) tx.set(API.assignment(api, S), { session: S, frozen });
    return { frozen: freezes.map(f => f.S) };
  });
}

// ---------------------------------------------------------------------------
// Reads used by tests, the driver and the drain.

export const readOp = async (api, opId) => (await API.op(api, opId).get()).data() ?? null;
export const readBinding = async (api, S) => (await API.binding(api, S).get()).data() ?? null;
export const readItem = async (con, id) => (await CON.item(con, id).get()).data() ?? null;
export const readCop = async (con, opId) => (await CON.cop(con, opId).get()).data() ?? null;
export const readAssignment = async (api, S) => (await API.assignment(api, S).get()).data() ?? null;
export async function readHistory(api, S) {
  const all = (await API.historyAll(api).get()).docs.map(d => d.data());
  return all.filter(h => h.session === S).sort((a, b) => a.revision - b.revision);
}

// ---------------------------------------------------------------------------
// The verified drain (§6) and the floors.

export async function drainCounts({ api, console: con }) {
  const [ops, bindings, cops, items] = await Promise.all([
    API.ops(api).get(),
    API.bindings(api).get(),
    CON.cops(con).get(),
    CON.items(con).get(),
  ]);
  const opData = ops.docs.map(d => d.data());
  const copById = new Map(cops.docs.map(d => [d.id, d.data()]));
  return {
    nonTerminalOperations: opData.filter(o => !TERMINAL.has(o.state)).length,
    preparedBindings: bindings.docs.filter(d => d.data().prepared).length,
    nonTerminalConsoleOperations: cops.docs.filter(d => !TERMINAL.has(d.data().state)).length,
    lockedItems: items.docs.filter(d => LOCKED_ITEM_STATES.has(d.data().state)).length,
    missingTombstones: opData.filter(o => o.state === "cancelled" && copById.get(o.opId)?.state !== "cancelled").length,
    outstandingAcks: opData.filter(o => o.state === "prepared" && !o.ack?.finalized && copById.get(o.opId)?.state === "finalized").length,
  };
}

export async function floors({ api, console: con }) {
  const [barrier, counts, bindings, items] = await Promise.all([
    API.barrier(api).get(),
    drainCounts({ api, console: con }),
    API.bindings(api).get(),
    CON.items(con).get(),
  ]);
  const drained = Object.values(counts).every(n => n === 0);
  return {
    counts,
    // W-api / W-console: only after a verified drain with the barrier closed.
    writersMayLower: barrier.data()?.state === "closed" && drained,
    // R-api: never while any active binding exists.
    readerMayLower: !bindings.docs.some(d => d.data().active),
    // K-console: never while any item carries another item's session or a
    // source is read-only; draining doesn't change this.
    consoleCompatMayLower: !items.docs.some(d => {
      const i = d.data();
      return i.respondentSession !== i.id || i.state === "read-only";
    }),
  };
}
