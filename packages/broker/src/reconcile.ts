// Reconciliation (spec WRITE-02, W5 stage 3): for a write whose outcome is
// unclear, look at the provider for evidence about what this operation did,
// and append what was found. It never writes to the provider and never
// re-executes, and it never changes the original receipt.
//
// Only Policy calls it (POST /v1/reconcile), for one invocation on one
// connection, once it has decided the asking user may. Per write receipt of
// that invocation:
//   - a recorded final resolution is returned as it is, with no new read;
//   - a receipt without evidence (claimed before W5) can't be resolved;
//   - before the write's deadline plus a grace period, nothing is read, so a
//     request still in flight isn't mistaken for one that never ran;
//   - otherwise Broker reads back exactly the references the claim recorded,
//     with the connection's credential, and decides per record:
//       landed   the stored record carries this operation's mark
//       unknown  anything else (absence proves nothing: the provider gives
//                no guarantee about requests it may still apply, or never did)
//     `applied` if every record landed, otherwise `unresolved`. Whether the
//     stored content currently matches what was sent is recorded as an
//     observation only.
// Every attempt is appended. A final resolution is created only for a
// definitive verdict (`applied`), only if none exists; a later definitive
// attempt that disagrees is recorded as a conflict and leaves it unchanged.
//
// B6 (docs/b6-command-repair-plan.md decision 2): an `applied` resolution
// also carries the write's result, so a repair can materialize a write whose
// outcome was never recorded. It comes from the recorded outcome when there is
// one (`resultSource: "outcome"`), otherwise from the claim's evidence
// (`"evidence"`, the operation's `resultFromEvidence`). Where both exist they
// must agree; if they don't, the resolution records `"conflict"` and no
// result. An operation that can't rebuild its result records `"unavailable"`.
// Evidence Broker can't read never reaches here: it stays `unresolved`.
//
// C5 (docs/c5-l0013-commands-plan.md decisions 5 and 8): reconciliation is
// asked for one scope, a connection (`connectionId`, as before) or an item
// (`scope: { kind: "item", id }`). A connection's receipts are those bound to
// it, by `connectionId` (v2) or by a connection scope (v3); an item's are
// those bound to its item scope, which are service operations: no credential
// is read, and each operation's own `observe` decides from what is published
// (gcs.put-thumbnail: a published sequence at or above the capture's is
// `applied`, anything else `unresolved`).
//
// C5d (docs/c5d-refusal-and-hold-plan.md decision 5): a receipt whose recorded
// outcome is a definite staging refusal (failed, `staging-unavailable`, no
// step taken; stores.js isStagingRefusal) is final: nothing was sent, and
// none ever will be under that claim. It answers `refused`, final, whatever
// its evidence is (claimRefused's `{ refused }`, or a reopened run's original
// evidence under refuseRun), with no read and no attempt appended.

import { randomUUID } from "node:crypto";
import { observeRecord, EVIDENCE_FORMAT } from "./operations.js";
import { isStagingRefusal, STAGING_REFUSAL } from "./stores.js";

export const RECONCILE_GRACE_MS = 60_000;

const canonical = value => JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));

// The result an `applied` resolution carries (see the header).
const establishedResult = async ({ operation, evidence, outcome }) => {
  const fromEvidence = operation?.resultFromEvidence ? operation.resultFromEvidence(evidence) : null;
  const recorded = outcome && outcome.result !== undefined && outcome.result !== null ? outcome.result : null;
  if (recorded !== null && fromEvidence !== null && canonical(recorded) !== canonical(fromEvidence)) return { result: null, resultSource: "conflict" };
  if (recorded !== null) return { result: recorded, resultSource: "outcome" };
  if (fromEvidence !== null) return { result: fromEvidence, resultSource: "evidence" };
  return { result: null, resultSource: "unavailable" };
};

// What a resolution says about the result, for callers. A resolution created
// before B6 says nothing.
const resultOf = resolution => (resolution && "resultSource" in resolution ? { result: resolution.result ?? null, resultSource: resolution.resultSource } : {});

export class ReconcileRefused extends Error {
  declare reason: string;
  declare status: number;
  constructor(reason: string, status = 403) {
    super(`reconcile refused: ${reason}`);
    this.reason = reason;
    this.status = status;
  }
}

// Is a claim's binding for this scope?
const boundTo = (binding, { connectionId, itemId }) => {
  if (itemId !== undefined) return binding?.scope?.kind === "item" && binding.scope.id === itemId;
  return binding?.connectionId === connectionId || (binding?.scope?.kind === "connection" && binding.scope.id === connectionId);
};

export const createReconciler = ({ receipts, secrets, operations, limits, audit, now = Date.now, newId = randomUUID }) =>
  async ({ connectionId = undefined, itemId = undefined, invocationId, decisionId }) => {
    if ((connectionId === undefined) === (itemId === undefined)) throw new Error("reconcile one scope: a connection or an item");
    const record = { event: "reconcile", ...(itemId !== undefined ? { itemId } : { connectionId }), invocationId, decisionId };
    const refuse = async (reason, status = 403) => {
      await audit({ ...record, outcome: "denied", reason });
      throw new ReconcileRefused(reason, status);
    };
    // A connection's receipts are its connection operations'; an item's, its
    // service operations'.
    const service = itemId !== undefined;
    const bound = (await receipts.listClaims(invocationId))
      .filter(c => boundTo(c.binding, { connectionId, itemId }) && operations[c.binding?.op]?.kind === "write" && (operations[c.binding.op].credential === "service") === service);
    // An aborted latest run (broker.js 7e) wrote nothing: never claimed.
    const claims = [];
    for (const c of bound) {
      if (receipts.getRunState && !(await receipts.getOutcome(c.operationId)) && (await receipts.getRunState(c.operationId)).aborted) continue;
      claims.push(c);
    }
    if (!claims.length) return refuse("receipt-not-found", 404);
    let credential = null;
    if (!service) {
      credential = await secrets.get(connectionId);
      if (!credential) return refuse("no-credential");
      // The credential must still be the one the writes ran with: same owner.
      if (claims.some(c => credential.ownerUid !== c.binding.ownerUid)) return refuse("credential-binding-mismatch");
    }

    const results = [];
    for (const claim of claims) {
      const operationId = claim.operationId;
      const opRecord = { ...record, opid: operationId, op: claim.binding.op };
      const final = await receipts.getResolution(operationId);
      if (final) {
        results.push({ operationId, verdict: final.verdict, final: true, ...resultOf(final) });
        continue;
      }
      // Keyed on the recorded outcome, never the evidence (see the header).
      if (isStagingRefusal(await receipts.getOutcome(operationId))) {
        await audit({ ...opRecord, outcome: "allowed", reason: "refused" });
        results.push({ operationId, verdict: "refused", final: true, reason: STAGING_REFUSAL });
        continue;
      }
      const evidence = claim.evidence;
      const operation = operations[claim.binding.op];
      const attempt = async (verdict, extra = {}) => {
        const attemptId = newId();
        await receipts.putAttempt(operationId, attemptId, { verdict, decisionId, ...extra });
        return attemptId;
      };
      if (!evidence || (operation.observe ? !operation.readsEvidence?.(evidence) : evidence.format !== EVIDENCE_FORMAT)) {
        const reason = evidence ? "evidence-format-unknown" : "no-evidence";
        await attempt("unresolved", { reason });
        await audit({ ...opRecord, outcome: "allowed", reason });
        results.push({ operationId, verdict: "unresolved", reason });
        continue;
      }
      const readyAt = Date.parse(claim.claimedAt) + limits.executionMs + RECONCILE_GRACE_MS;
      if (!(now() >= readyAt)) {
        results.push({ operationId, verdict: "too-early", retryAfter: new Date(readyAt).toISOString() });
        continue;
      }
      const readAt = new Date(now()).toISOString();
      const readFailed = async () => {
        await attempt("unresolved", { reason: "read-failed", readAt });
        await audit({ ...opRecord, outcome: "allowed", reason: "read-failed" });
        results.push({ operationId, verdict: "unresolved", reason: "read-failed" });
      };
      // What was found: a provider's records (each landed or not), or an
      // operation's own observation of its effect.
      let verdict;
      let found;
      if (operation.observe) {
        let seen;
        try {
          seen = await operation.observe(evidence, { timeoutMs: limits.providerCallMs });
        } catch {
          await readFailed();
          continue;
        }
        verdict = seen.applied ? "applied" : "unresolved";
        found = { observation: seen.observation };
      } else {
        let stored;
        try {
          stored = await operation.readBack(evidence, credential, { timeoutMs: limits.providerCallMs });
        } catch {
          await readFailed();
          continue;
        }
        const records = evidence.records.map(r => ({ step: r.step, kind: r.kind, reference: r.reference, ...observeRecord(r, stored[r.kind]?.get(r.reference), operationId) }));
        verdict = records.length > 0 && records.every(r => r.landed) ? "applied" : "unresolved";
        found = { records };
      }
      const attemptId = await attempt(verdict, { ...found, readAt });
      let isFinal = false;
      let established = {};
      if (verdict === "applied") {
        const output = await establishedResult({ operation, evidence, outcome: await receipts.getOutcome(operationId) });
        if (output.resultSource === "conflict") await audit({ ...opRecord, outcome: "allowed", reason: "result-conflict" });
        if (await receipts.createResolution(operationId, { verdict, attemptId, decisionId, ...output })) {
          isFinal = true;
          established = resultOf(output);
        } else {
          const existing = await receipts.getResolution(operationId);
          if (existing?.verdict !== verdict) await audit({ ...opRecord, outcome: "allowed", reason: "resolution-conflict" });
          isFinal = existing?.verdict === verdict;
          if (isFinal) established = resultOf(existing);
        }
      }
      await audit({ ...opRecord, outcome: "allowed", reason: verdict });
      results.push({ operationId, verdict, final: isFinal, ...found, ...established });
    }
    return { invocationId, operations: results };
  };
