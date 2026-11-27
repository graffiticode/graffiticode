// The runtime and lifecycle choices the owner selected on 2026-11-27
// (docs/c4-runtime-lifecycle.md §10), over the option (c) state machine in
// protocol.mjs:
// - §9 canary routing: a create-only SESSION PIN and OPERATION INDEX in
//   un-namespaced api collections; C0 (and its retries) reads the index, then
//   the pin, and only for a session never seen consults the current list, so a
//   lost response or a configuration change can never move an operation or a
//   session to another namespace. Separate barriers per namespace, and
//   canary-owned fixtures only.
// - §7 settlement: a separate `respondent-operation-settlement/<opId>` record,
//   created with the operation and set only by the console's settled
//   acknowledgement, so a terminal operation record is never written again
//   (I6 unchanged).
// - §7 recovery: the console-side runner's ordered, api-phase-guarded rows,
//   with the selected 15-minute threshold and 5-minute interval as
//   healthy-service targets.
// - §6 the retained per-revision descriptor: archive and expiry are console
//   visibility only; they never withdraw authority. W0–W3 withdrawal was not
//   selected and is not modelled.
//
// Emulator-only evidence; no route, deployment configuration or production
// collection uses it.

import {
  ProtocolError,
  ackFinalized,
  activate,
  cancelApi,
  cancelConsole,
  readCop,
  readOp,
  registerInTx,
  requestDigest,
  samePrincipal,
  submitInTx,
  unlock,
} from "./protocol.mjs";
import { Crash, runChild } from "./driver.mjs";

const refuse = (code, opts) => {
  throw new ProtocolError(code, opts);
};

export const THRESHOLD_MS = 15 * 60 * 1000;
export const INTERVAL_MS = 5 * 60 * 1000;
export const NAMESPACES = ["production", "canary"];

// ---------------------------------------------------------------------------
// Namespaces. A namespaced view of a store prefixes every collection with
// `canary-` for the canary namespace (production keeps the plain names). The
// pin and the index are read and written on the BASE store, un-namespaced.

export function scoped(store, namespace) {
  if (!NAMESPACES.includes(namespace)) refuse("unknown-namespace", { detail: namespace });
  const prefix = namespace === "canary" ? "canary-" : "";
  return {
    namespace,
    ns: store.ns,
    col: name => store.col(`${prefix}${name}`),
    doc: (name, id) => store.col(`${prefix}${name}`).doc(id),
    run: fn => store.run(fn),
  };
}
export const scopedStores = (stores, namespace) => ({
  api: scoped(stores.api, namespace),
  console: scoped(stores.console, namespace),
  namespace,
});

const PIN = (base, S) => base.doc("l0182-session-namespace", S);
const INDEX = (base, opId) => base.doc("respondent-operation-index", opId);
const SETTLEMENT = (api, opId) => api.doc("respondent-operation-settlement", opId);
const OP = (api, opId) => api.doc("respondent-operations", opId);

// `config` stands for the api's deploy-time configuration:
// { canarySessions: [S…], canaryPrincipals: [principal…], now: () => ms }.
const listed = (config, S) => (config.canarySessions ?? []).includes(S);
const canaryOwned = (config, principal) => (config.canaryPrincipals ?? []).some(p => samePrincipal(p, principal));
const clock = config => (config.now ? config.now() : Date.now());

export const readPin = async (stores, S) => (await PIN(stores.api, S).get()).data() ?? null;
export const readIndex = async (stores, opId) => (await INDEX(stores.api, opId).get()).data() ?? null;
export const readSettlement = async (api, opId) => (await SETTLEMENT(api, opId).get()).data() ?? null;

// ---------------------------------------------------------------------------
// C0, routed. One api transaction: the index and pin reads, then C0's own
// reads (registerInTx), then the writes. The namespace is decided in this
// order: the operation index (a replay: its recorded namespace, whatever the
// list now says; a different digest is operation-mismatch), the session pin,
// and only then the current list. A new operation creates the index and its
// settlement record; a new session creates its pin.

export async function registerRouted(stores, config, request) {
  const base = stores.api;
  const S = request.session;
  const digest = requestDigest(request);
  return base.run(async tx => {
    const [idxSnap, pinSnap] = await Promise.all([tx.get(INDEX(base, request.opId)), tx.get(PIN(base, S))]);
    let namespace;
    let via;
    if (idxSnap.exists) {
      const idx = idxSnap.data();
      if (idx.digest !== digest) refuse("operation-mismatch");
      ({ namespace } = idx);
      via = "index";
    } else if (pinSnap.exists) {
      ({ namespace } = pinSnap.data());
      via = "pin";
    } else {
      namespace = listed(config, S) ? "canary" : "production";
      via = "list";
    }
    if (namespace === "canary" && !(canaryOwned(config, request.caller) && canaryOwned(config, request.destPrincipal))) {
      refuse("canary-fixture-only");
    }
    const api = scoped(base, namespace);
    const { op, created } = await registerInTx(api, tx, request);
    const now = clock(config);
    if (!pinSnap.exists) tx.create(PIN(base, S), { namespace, at: now });
    if (created) {
      tx.create(INDEX(base, request.opId), { namespace, digest, session: S });
      tx.create(SETTLEMENT(api, request.opId), { opId: request.opId, settled: false, createdAt: now });
    }
    return { ...op, namespace, via };
  });
}

// The namespace of an existing operation, from its index: how the console's
// cancel path and the runner find it without deciding anything themselves.
export async function namespaceOf(stores, opId) {
  const idx = await readIndex(stores, opId);
  if (!idx) refuse("unknown-operation");
  return idx.namespace;
}

// S4, routed: every session resolves through its pin (or, never seen, the
// list); all must share one namespace; missing pins are created with the
// freeze.
export async function submitRouted(stores, config, args) {
  const base = stores.api;
  return base.run(async tx => {
    const pins = await Promise.all(args.sessions.map(S => tx.get(PIN(base, S))));
    const spaces = args.sessions.map((S, i) => pins[i].data()?.namespace ?? (listed(config, S) ? "canary" : "production"));
    if (new Set(spaces).size !== 1) refuse("namespace-mixed");
    // The selected fixture restriction (§9) holds on the submission path too:
    // a canary session is frozen, and pinned by a first write, only for
    // canary-owned principals. Refused before any write, so nothing is left.
    if (spaces[0] === "canary" && !(canaryOwned(config, args.caller) && canaryOwned(config, args.submitter))) {
      refuse("canary-fixture-only");
    }
    const api = scoped(base, spaces[0]);
    const out = await submitInTx(api, tx, args);
    const now = clock(config);
    args.sessions.forEach((S, i) => {
      if (!pins[i].exists) tx.create(PIN(base, S), { namespace: spaces[0], at: now });
    });
    return { ...out, namespace: spaces[0] };
  });
}

// The release-time configuration check (§9): a listed session pinned
// production, or an unlisted one pinned canary, is a configuration error. The
// pin still wins; this only reports.
export async function configCheck(stores, config) {
  const pins = (await stores.api.col("l0182-session-namespace").get()).docs.map(d => ({ S: d.id, ...d.data() }));
  return {
    listedButProduction: pins.filter(p => p.namespace === "production" && listed(config, p.S)).map(p => p.S),
    unlistedButCanary: pins.filter(p => p.namespace === "canary" && !listed(config, p.S)).map(p => p.S),
  };
}

// ---------------------------------------------------------------------------
// Settlement (§7). The console's settled acknowledgement, sent after its last
// transaction for the operation (C5 unlock, or the cancellation cleanup),
// with the console operation as evidence. It is refused unless the api
// operation is terminal and the console evidence shows the same terminal
// state, and it writes ONLY the settlement record.

export async function ackSettled(api, opId, consoleOp, { now = Date.now() } = {}) {
  return api.run(async tx => {
    const [opSnap, sSnap] = await Promise.all([tx.get(OP(api, opId)), tx.get(SETTLEMENT(api, opId))]);
    const op = opSnap.data();
    if (!op) refuse("unknown-operation");
    if (op.state !== "completed" && op.state !== "cancelled") refuse("not-terminal", { detail: op.state });
    if (consoleOp?.opId !== opId || consoleOp.state !== op.state) refuse("console-not-settled");
    const settlement = sSnap.data();
    if (!settlement) refuse("unknown-settlement");
    if (settlement.settled) return settlement;
    const next = { ...settlement, settled: true, outcome: op.state, at: now };
    tx.set(SETTLEMENT(api, opId), next);
    return next;
  });
}

// One continuation, routed: C0 through the pin and index, then every later
// step in the recorded namespace, then the settled acknowledgement. Crash
// points are the driver's STEPS plus "settle-pending" (after C5, before the
// acknowledgement).
export async function runRoutedChild(stores, config, request, { crashAfter } = {}) {
  const reg = await registerRouted(stores, config, request);
  if (crashAfter === "C0") throw new Crash("C0");
  const s = scopedStores(stores, reg.namespace);
  const out = await runChild(s, request, { crashAfter });
  if (crashAfter === "settle-pending") throw new Crash("settle-pending");
  await ackSettled(s.api, request.opId, await readCop(s.console, request.opId), { now: clock(config) });
  return { ...out, namespace: reg.namespace };
}

// ---------------------------------------------------------------------------
// The recovery runner (§7), one pass. It selects unsettled settlement records
// older than the threshold, and cross-checks console items in a transient
// lock and console operations not terminal. For each operation it applies
// the ordered rows, first match wins, reading the api phase first.

const TRANSIENT = new Set(["continuing", "pending", "finalizing"]);
const OP_LOCKS = new Set(["continuing", "read-only", "pending", "finalizing"]);

async function lockRemains(con, op) {
  const ids = [op.request.source, op.T];
  const items = await Promise.all(ids.map(id => con.doc("items", id).get()));
  return items.some(snap => {
    const i = snap.data();
    return i && i.lockOp === op.opId && OP_LOCKS.has(i.state);
  });
}

// `hooks.before(name)` runs before each action; tests use it to commit a
// concurrent step between the runner's snapshot and its transaction.
export async function recoverOne(s, opId, { now, hooks = {} }) {
  const actions = [];
  const attempt = async (name, fn) => {
    try {
      if (hooks.before) await hooks.before(name, opId);
      await fn();
      actions.push(name);
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
      actions.push(`${name}:refused:${err.code}`); // the phase moved: re-read from row 1
    }
  };
  for (let i = 0; i < 12; i++) {
    const op = await readOp(s.api, opId);
    if (!op) return actions;
    const cop = await readCop(s.console, opId);
    const settlement = await readSettlement(s.api, opId);
    // Rows 1–2: cancelled. Terminal cleanup takes precedence over any ack.
    if (op.state === "cancelled") {
      if (cop?.state !== "cancelled" || (await lockRemains(s.console, op))) {
        await attempt("cleanup", () => cancelConsole(s.console, op));
        continue;
      }
      if (!settlement?.settled) await attempt("settle", () => ackSettled(s.api, opId, cop, { now }));
      return actions;
    }
    // Rows 3–4: completed.
    if (op.state === "completed") {
      if (cop?.state !== "completed") {
        await attempt("C5", () => unlock(s.console, op));
        continue;
      }
      if (!settlement?.settled) await attempt("settle", () => ackSettled(s.api, opId, cop, { now }));
      return actions;
    }
    // Row 5: prepared with the finalized acknowledgement: roll forward.
    if (op.state === "prepared" && op.ack?.finalized) {
      await attempt("C4", () => activate(s.api, opId));
      continue;
    }
    // Row 7: prepared, console finalized, C3a missing: resend C3a (only while prepared).
    if (op.state === "prepared" && cop?.state === "finalized") {
      const ack = { opId, revision: op.request.expectedRevision + 1, T: op.T, X: op.request.source };
      await attempt("C3a", () => ackFinalized(s.api, ack));
      continue;
    }
    // Row 9: registered, or prepared without the console finalized: abandoned.
    // The cancellation carries the observed phase as a precondition, so if
    // C2 or C3a advanced it since this snapshot, it is refused and the loop
    // restarts from row 1.
    if (op.state === "registered" || op.state === "prepared") {
      const ifPhase = { state: op.state, ackFinalized: Boolean(op.ack?.finalized) };
      await attempt("cancel", () => cancelApi(s.api, opId, { reason: "abandoned", ifPhase }));
      continue;
    }
    refuse("unexpected-phase", { detail: op.state });
  }
  refuse("recovery-stalled", { detail: opId });
}

export async function recoveryPass(stores, { now, threshold = THRESHOLD_MS, namespaces = NAMESPACES, hooks } = {}) {
  const report = [];
  for (const namespace of namespaces) {
    const s = scopedStores(stores, namespace);
    const settlements = (await s.api.col("respondent-operation-settlement").get()).docs.map(d => d.data());
    const old = new Map(settlements.filter(r => r.createdAt <= now - threshold).map(r => [r.opId, r]));
    const due = new Set([...old.values()].filter(r => !r.settled).map(r => r.opId));
    // Cross-check: transient console state for an operation old enough.
    const items = (await s.console.col("items").get()).docs.map(d => d.data());
    const cops = (await s.console.col("continuation-ops").get()).docs.map(d => d.data());
    for (const opId of [
      ...items.filter(i => i.lockOp && TRANSIENT.has(i.state)).map(i => i.lockOp),
      ...cops.filter(c => c.state !== "completed" && c.state !== "cancelled").map(c => c.opId),
    ]) {
      if (old.has(opId)) due.add(opId);
    }
    for (const opId of [...due].sort()) {
      report.push({ namespace, opId, actions: await recoverOne(s, opId, { now, hooks }) });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// The console's listing reader: it hides archived items and expired
// free-plan items. Respondent authority (deriveAuthority) never applies this
// filter: archive and expiry are visibility, not authority (§6).

export async function visibleItems(con, owner, { now }) {
  const items = (await con.col("items").get()).docs.map(d => d.data());
  return items
    .filter(i => samePrincipal(i.owner, owner))
    .filter(i => i.mark !== 5)
    .filter(i => !(typeof i.expiresAt === "number" && i.expiresAt <= now))
    .map(i => i.id)
    .sort();
}
