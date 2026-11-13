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

import { randomUUID } from "node:crypto";
import { observeRecord, EVIDENCE_FORMAT } from "./operations.js";

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

export const createReconciler = ({ receipts, secrets, operations, limits, audit, now = Date.now, newId = randomUUID }) =>
  async ({ connectionId, invocationId, decisionId }) => {
    const record = { event: "reconcile", connectionId, invocationId, decisionId };
    const refuse = async (reason, status = 403) => {
      await audit({ ...record, outcome: "denied", reason });
      throw new ReconcileRefused(reason, status);
    };
    const claims = (await receipts.listClaims(invocationId))
      .filter(c => c.binding?.connectionId === connectionId && operations[c.binding?.op]?.kind === "write");
    if (!claims.length) return refuse("receipt-not-found", 404);
    const credential = await secrets.get(connectionId);
    if (!credential) return refuse("no-credential");
    // The credential must still be the one the writes ran with: same owner.
    if (claims.some(c => credential.ownerUid !== c.binding.ownerUid)) return refuse("credential-binding-mismatch");

    const results = [];
    for (const claim of claims) {
      const operationId = claim.operationId;
      const opRecord = { ...record, opid: operationId, op: claim.binding.op };
      const final = await receipts.getResolution(operationId);
      if (final) {
        results.push({ operationId, verdict: final.verdict, final: true, ...resultOf(final) });
        continue;
      }
      const evidence = claim.evidence;
      const attempt = async (verdict, extra = {}) => {
        const attemptId = newId();
        await receipts.putAttempt(operationId, attemptId, { verdict, decisionId, ...extra });
        return attemptId;
      };
      if (!evidence || evidence.format !== EVIDENCE_FORMAT) {
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
      let stored;
      const readAt = new Date(now()).toISOString();
      try {
        stored = await operations[claim.binding.op].readBack(evidence, credential, { timeoutMs: limits.providerCallMs });
      } catch {
        await attempt("unresolved", { reason: "read-failed", readAt });
        await audit({ ...opRecord, outcome: "allowed", reason: "read-failed" });
        results.push({ operationId, verdict: "unresolved", reason: "read-failed" });
        continue;
      }
      const records = evidence.records.map(r => ({ step: r.step, kind: r.kind, reference: r.reference, ...observeRecord(r, stored[r.kind]?.get(r.reference), operationId) }));
      const verdict = records.length > 0 && records.every(r => r.landed) ? "applied" : "unresolved";
      const attemptId = await attempt(verdict, { records, readAt });
      let isFinal = false;
      let established = {};
      if (verdict === "applied") {
        const output = await establishedResult({ operation: operations[claim.binding.op], evidence, outcome: await receipts.getOutcome(operationId) });
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
      results.push({ operationId, verdict, final: isFinal, records, ...established });
    }
    return { invocationId, operations: results };
  };
