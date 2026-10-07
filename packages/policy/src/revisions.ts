// Approved compiler revisions and the fence that makes retiring one safe
// (capability plan W4, section A).
//
// The deploy CLI records each release of a pinnable language as `approved` in
// the `revisions` database (packages/deploy/src/revisions.js); Policy reads it
// and never writes it (IAM scoped to that database). An admitted plan may pin
// only an approved revision. Retiring one must not lose an admission already
// in flight: one that read `approved`, missed by the recovery report, then
// stored a plan. Expiry is never the fence. The protocol:
//
//   admission (Policy, W4 PR 2)            retirement (scripts/revisions.js)
//   1. registerLease: commit a lease        1. mark the revision `retiring`
//      naming its revisions                 2. invalidateLeases: each lease
//   2. read approvals at a readTime no         naming it, expired or not, set
//      earlier than the lease's commit         `invalidated` in a transaction
//   3. write the plan in a transaction     3. build the report from fresh
//      that consumes the lease (it must        reads, once those finish
//      still be `active`)                  4. confirm, `retired`, wait, untag
//
// Retirement's invalidation and the plan write both read and write the lease
// document, so they conflict: either the plan commits first (and the report,
// read after, names it) or it can't commit. An admission whose lease commits
// after the `retiring` mark reads at a later time, so it sees `retiring`.

import { randomUUID } from "node:crypto";
import type { Firestore, Transaction, Timestamp } from "firebase-admin/firestore";

export const REVISION_STATUSES = Object.freeze(["approved", "retiring", "retired"] as const);
export type RevisionStatus = typeof REVISION_STATUSES[number];
// Leases expire only so they can be cleaned up; retirement invalidates every
// lease naming the revision, expired or not.
export const LEASE_TTL_MS = 30_000;
// The longest an admission token lives: a proof issued before retirement may
// still be presented until then.
export const ADMISSION_TOKEN_LIFETIME_MS = 15 * 60_000;

export class RevisionStateError extends Error {
  declare reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "RevisionStateError";
    this.reason = reason;
  }
}

export const revisionRef = (revisionsDb: Firestore, lang: string, revision: string) =>
  revisionsDb.collection("languages").doc(lang).collection("revisions").doc(revision);
const leases = (policyDb: Firestore) => policyDb.collection("admission-leases");

// --- The admission side (Policy) ---

// Commits a lease naming the revisions an admission is about to read. Its
// approvals must be read at `writeTime` or later.
export async function registerLease(policyDb: Firestore, revisions: string[], { now = () => new Date() } = {}) {
  const ref = leases(policyDb).doc();
  const at = now();
  const result = await ref.create({ revisions: [...new Set(revisions)].sort(), state: "active", createdAt: at, expiresAt: new Date(at.getTime() + LEASE_TTL_MS) });
  return { id: ref.id, writeTime: result.writeTime as Timestamp };
}

// Inside the plan-write transaction: the lease must still be active, and is
// consumed. Throws `revision-retiring` once retirement has invalidated it.
export async function consumeLease(tx: Transaction, policyDb: Firestore, leaseId: string) {
  const ref = leases(policyDb).doc(leaseId);
  const snap = await tx.get(ref);
  if (!snap.exists || snap.data()?.state !== "active") {
    throw new RevisionStateError("a revision this admission pins is being retired", "revision-retiring");
  }
  tx.delete(ref);
}

// The records of the given revisions as of `readTime` (one consistent view).
export async function readRevisions(revisionsDb: Firestore, wanted: { lang: string, revision: string }[], readTime: Timestamp) {
  return revisionsDb.runTransaction(async tx => {
    const snaps = await Promise.all(wanted.map(({ lang, revision }) => tx.get(revisionRef(revisionsDb, lang, revision))));
    return snaps.map((snap, i) => ({ ...wanted[i], record: snap.exists ? snap.data() : null }));
  }, { readOnly: true, readTime });
}

// --- The retirement side (the operator, scripts/revisions.js) ---

// Moves a revision between statuses in one transaction, refusing any other
// starting status. With `retirementId`, the record must belong to that
// retirement: a retirement that was cancelled, and perhaps restarted by
// someone else, can't make another transition (its report is stale). A
// `null` field value removes the field. Returns the record as written.
export async function setStatus(revisionsDb: Firestore, lang: string, revision: string, from: RevisionStatus[], to: RevisionStatus, fields: Record<string, unknown> = {}, { retirementId }: { retirementId?: string } = {}) {
  const ref = revisionRef(revisionsDb, lang, revision);
  return revisionsDb.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new RevisionStateError(`${revision} is not a recorded revision of ${lang}`, "revision-not-approved");
    const status = snap.data()?.status;
    if (!from.includes(status)) throw new RevisionStateError(`${revision} is ${status}, not ${from.join(" or ")}`, "revision-state");
    if (retirementId !== undefined && snap.data()?.retirementId !== retirementId) {
      throw new RevisionStateError(`the retirement of ${revision} this process started was cancelled or superseded; nothing changed`, "retirement-superseded");
    }
    const record: Record<string, unknown> = { ...snap.data(), status: to };
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) delete record[key];
      else record[key] = value;
    }
    tx.set(ref, record);
    return record;
  });
}

// Invalidates every lease naming the revision, each in its own transaction, so
// a plan write still holding one can't commit after it. Returns how many were
// still active.
export async function invalidateLeases(policyDb: Firestore, revision: string, { now = () => new Date() } = {}) {
  const found = await leases(policyDb).where("revisions", "array-contains", revision).get();
  let invalidated = 0;
  for (const doc of found.docs) {
    await policyDb.runTransaction(async tx => {
      const snap = await tx.get(doc.ref);
      if (snap.exists && snap.data()?.state === "active") {
        tx.update(doc.ref, { state: "invalidated", invalidatedAt: now() });
        invalidated += 1;
      }
    });
  }
  return invalidated;
}

export type RecoveryItem = { planDigest: string, invocationId: string | null, uncertainReceipts: number, unfinishedReceipts: number, artifactStored: boolean };

// The plans that still need the revision to recover (decision 4): an uncertain
// or unfinished write, or an invocation whose artifact was never stored (a
// successful write without one, or a run that never finished). Fresh reads,
// after the leases are invalidated.
export async function recoveryReport({ policyDb, brokerDb, apiDb }: { policyDb: Firestore, brokerDb: Firestore, apiDb: Firestore }, revision: string): Promise<RecoveryItem[]> {
  const plans = await policyDb.collection("plans").where("revisions", "array-contains", revision).get();
  const items: RecoveryItem[] = [];
  for (const plan of plans.docs) {
    const invocationId = plan.data().invocationId ?? null;
    const receipts = await brokerDb.collection("receipts").where("pld", "==", plan.id).get();
    let uncertainReceipts = 0;
    let unfinishedReceipts = 0;
    for (const receipt of receipts.docs) {
      const outcome = await receipt.ref.collection("outcome").doc("final").get();
      if (!outcome.exists) unfinishedReceipts += 1;
      else if (outcome.data()?.status === "uncertain") uncertainReceipts += 1;
    }
    const artifactStored = invocationId ? (await apiDb.collection("artifacts").doc(invocationId).get()).exists : false;
    if (uncertainReceipts || unfinishedReceipts || !artifactStored) {
      items.push({ planDigest: plan.id, invocationId, uncertainReceipts, unfinishedReceipts, artifactStored });
    }
  }
  return items;
}

type RetireDeps = {
  revisionsDb: Firestore,
  policyDb: Firestore,
  report: (revision: string) => Promise<RecoveryItem[]>,
  removeTag: (tag: string) => Promise<void>,
  sleep?: (ms: number) => Promise<unknown>,
  now?: () => Date,
  log?: (message: string) => void,
};
type RetireOptions = { lang: string, revision: string, by: string, confirmUnrecoverable?: boolean, resume?: boolean, cancel?: boolean };
type RetireResult =
  | { outcome: "cancelled", report?: RecoveryItem[] }
  | { outcome: "retired", report: RecoveryItem[], tag: string };

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Retires one revision (plan W4 section A, decision 4), or resumes or cancels
// an interrupted retirement. Without confirmation, and with recoveries it
// would make unavailable, it cancels itself: the revision is approved again.
export async function retireRevision(deps: RetireDeps, options: RetireOptions): Promise<RetireResult> {
  const { revisionsDb, policyDb, report, removeTag, sleep = pause, now = () => new Date(), log = () => {} } = deps;
  const { lang, revision, by } = options;
  const at = () => now().toISOString();

  // Cancelling ends the retirement in progress: its id is cleared, so the
  // process that started it can't finish it later with a stale report.
  if (options.cancel) {
    await setStatus(revisionsDb, lang, revision, ["retiring"], "approved", { cancelledAt: at(), cancelledBy: by, retirementId: null });
    log(`Cancelled the retirement of ${revision}; it is approved again.`);
    return { outcome: "cancelled" };
  }

  let record = (await revisionRef(revisionsDb, lang, revision).get()).data();
  if (!record) throw new RevisionStateError(`${revision} is not a recorded revision of ${lang}`, "revision-not-approved");
  // Every transition after this one names this retirement. Resuming adopts
  // the retirement in progress, explicitly.
  let retirementId: string;
  // Resuming after the revision was retired but before its tag was removed.
  if (record.status === "retired" && !record.tagRemovedAt) {
    if (!options.resume) throw new RevisionStateError(`${revision} is retired but still tagged; use --resume`, "revision-state");
    retirementId = record.retirementId;
    return finish(record, []);
  }
  if (options.resume) {
    if (record.status !== "retiring") throw new RevisionStateError(`${revision} is ${record.status}; there is no retirement to resume`, "revision-state");
    retirementId = record.retirementId;
  } else {
    retirementId = randomUUID();
    record = await setStatus(revisionsDb, lang, revision, ["approved"], "retiring", { retiringSince: at(), retiringBy: by, retirementId });
    log(`Marked ${revision} retiring: no new plan can pin it, and its snapshots are refused.`);
  }

  const invalidated = await invalidateLeases(policyDb, revision, { now });
  log(`Fenced ${invalidated} admission(s) in flight.`);
  const items = await report(revision);
  if (items.length && !options.confirmUnrecoverable) {
    await setStatus(revisionsDb, lang, revision, ["retiring"], "approved", { selfCancelledAt: at(), selfCancelledBy: by, lastReport: items.map(i => i.planDigest), retirementId: null }, { retirementId });
    log(`${items.length} plan(s) still need ${revision} to recover; retiring it makes those recoveries unavailable. Not retired (approved again). Rerun with --confirm-unrecoverable to retire anyway.`);
    return { outcome: "cancelled", report: items };
  }
  record = await setStatus(revisionsDb, lang, revision, ["retiring"], "retired", {
    retiredAt: at(), retiredBy: by, unrecoverable: items.map(i => i.planDigest),
  }, { retirementId });
  return finish(record, items);

  async function finish(retired: Record<string, any>, items: RecoveryItem[]): Promise<RetireResult> {
    // Proofs issued before retirement live at most this long.
    const wait = new Date(retired.retiredAt).getTime() + ADMISSION_TOKEN_LIFETIME_MS - now().getTime();
    if (wait > 0) {
      log(`Retired ${revision}; removing its tag in ${Math.ceil(wait / 60_000)} min, once proofs issued before retirement have expired.`);
      await sleep(wait);
    }
    // The tag stays (deploy CLI retainedTags) until this records its removal.
    await setStatus(revisionsDb, lang, revision, ["retired"], "retired", {}, { retirementId });
    await removeTag(retired.tag);
    await setStatus(revisionsDb, lang, revision, ["retired"], "retired", { tagRemovedAt: at() }, { retirementId });
    log(`Removed the tag ${retired.tag} from ${revision}.`);
    return { outcome: "retired", report: items, tag: retired.tag };
  }
}
