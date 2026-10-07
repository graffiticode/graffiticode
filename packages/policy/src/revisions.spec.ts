// The retirement fence (capability plan W4, section A), against the Firestore
// emulator only (FIRESTORE_EMULATOR_HOST set), e.g.
//   firebase emulators:exec --only firestore "npx jest src/revisions.spec.ts"
// The race needs real transactions: an admission's plan write and
// retirement's lease invalidation must conflict, so either the plan commits
// first and the report names it, or it can't commit.
import { randomUUID } from "node:crypto";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import {
  registerLease,
  consumeLease,
  readRevisions,
  invalidateLeases,
  recoveryReport,
  retireRevision,
  revisionRef,
  setStatus,
  ADMISSION_TOKEN_LIFETIME_MS,
  RevisionStateError,
} from "./revisions.js";

const run = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

run("revision retirement fence", () => {
  let revisionsDb;
  let policyDb;
  let brokerDb;
  let apiDb;
  let lang;
  beforeAll(() => {
    const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: "demo-graffiticode" });
    revisionsDb = getFirestore(app, "revisions");
    policyDb = getFirestore(app, "policy");
    brokerDb = getFirestore(app, "broker");
    apiDb = getFirestore(app, "api");
  });
  // Each test its own language, so tests never see each other's records.
  beforeEach(() => {
    lang = String(1000 + Math.floor(Math.random() * 8999));
  });

  const approve = async revision => revisionRef(revisionsDb, lang, revision).set({
    lang, revision, tag: `t-${revision}`, status: "approved", contractVersions: [1], approvedAt: new Date(),
  });
  const statusOf = async revision => (await revisionRef(revisionsDb, lang, revision).get()).data()?.status;
  const report = revision => recoveryReport({ policyDb, brokerDb, apiDb }, revision);
  // An admission that reads its revision and stores a plan pinning it, the way
  // Policy will (W4 PR 2): lease, then a readTime no earlier than the lease,
  // then a plan write that consumes the lease. `beforeCommit` runs after the
  // lease is validated, inside the transaction.
  const admit = async (revision, { afterRead = async () => {}, beforeCommit = async () => {} } = {}) => {
    const lease = await registerLease(policyDb, [revision]);
    const [{ record }] = await readRevisions(revisionsDb, [{ lang, revision }], lease.writeTime);
    if (record?.status !== "approved") throw new RevisionStateError("not approved", "revision-retiring");
    await afterRead();
    const planDigest = randomUUID().replace(/-/g, "");
    const invocationId = `inv-${randomUUID()}`;
    await policyDb.runTransaction(async tx => {
      await consumeLease(tx, policyDb, lease.id);
      await beforeCommit();
      tx.set(policyDb.collection("plans").doc(planDigest), { invocationId, revisions: [revision] });
    });
    return { planDigest, invocationId };
  };
  const planExists = async planDigest => (await policyDb.collection("plans").doc(planDigest).get()).exists;
  const deps = (extra = {}) => ({ revisionsDb, policyDb, report, removeTag: async () => {}, sleep: async () => {}, ...extra });

  it("an admission paused after validating its lease, before commit, either commits first and is reported, or can't commit", async () => {
    const revision = `rev-${randomUUID()}`;
    await approve(revision);
    let validated;
    const leaseValidated = new Promise(resolve => { validated = resolve; });
    let resume;
    const paused = new Promise(resolve => { resume = resolve; });
    let attempts = 0;
    const admission = admit(revision, {
      beforeCommit: async () => {
        attempts += 1;
        validated();
        if (attempts === 1) await paused;
      },
    }).then(plan => ({ plan }), error => ({ error }));
    await leaseValidated;
    // Retirement runs while the admission holds its validated lease.
    const retirement = retireRevision(deps(), { lang, revision, by: "test" });
    setTimeout(resume, 300);
    const [admitted, retired] = await Promise.all([admission, retirement]);
    if ("plan" in admitted) {
      // The plan committed first: the report, read after the fence, names it,
      // so retirement without confirmation cancels itself.
      expect(await planExists(admitted.plan.planDigest)).toBe(true);
      expect(retired.outcome).toBe("cancelled");
      expect(retired.report.map(i => i.planDigest)).toContain(admitted.plan.planDigest);
      expect(await statusOf(revision)).toBe("approved");
    } else {
      // Invalidated first: the plan never committed.
      expect(admitted.error.reason).toBe("revision-retiring");
      expect(retired.outcome).toBe("retired");
      expect(await statusOf(revision)).toBe("retired");
    }
  });

  it("an admission that read approved but hadn't written its plan when retirement fenced it can't commit", async () => {
    const revision = `rev-${randomUUID()}`;
    await approve(revision);
    let retired;
    const admission = admit(revision, {
      // Retirement runs to completion between the approval read and the plan write.
      afterRead: async () => { retired = await retireRevision(deps(), { lang, revision, by: "test" }); },
    });
    await expect(admission).rejects.toMatchObject({ reason: "revision-retiring" });
    expect(retired.outcome).toBe("retired");
    expect(retired.report).toEqual([]);
    expect(await statusOf(revision)).toBe("retired");
    expect((await policyDb.collection("plans").where("revisions", "array-contains", revision).get()).empty).toBe(true);
  });

  it("an admission whose lease commits after the retiring mark reads retiring", async () => {
    const revision = `rev-${randomUUID()}`;
    await approve(revision);
    await setStatus(revisionsDb, lang, revision, ["approved"], "retiring", { retiringSince: new Date().toISOString() });
    await expect(admit(revision)).rejects.toMatchObject({ reason: "revision-retiring" });
  });

  it("an expired lease is still invalidated: expiry is not the fence", async () => {
    const revision = `rev-${randomUUID()}`;
    await approve(revision);
    const lease = await registerLease(policyDb, [revision], { now: () => new Date(Date.now() - 3600_000) });
    expect(await invalidateLeases(policyDb, revision)).toBe(1);
    await expect(policyDb.runTransaction(tx => consumeLease(tx, policyDb, lease.id))).rejects.toMatchObject({ reason: "revision-retiring" });
  });

  it("without confirmation, recoveries it would lose cancel the retirement; with it, it retires", async () => {
    const revision = `rev-${randomUUID()}`;
    await approve(revision);
    const { planDigest, invocationId } = await admit(revision);
    // An uncertain write under that plan, and no stored artifact.
    const receipt = brokerDb.collection("receipts").doc(randomUUID());
    await receipt.set({ pld: planDigest });
    await receipt.collection("outcome").doc("final").set({ status: "uncertain" });
    const declined = await retireRevision(deps(), { lang, revision, by: "test" });
    expect(declined).toMatchObject({ outcome: "cancelled" });
    if (declined.outcome !== "cancelled") throw new Error("expected cancelled");
    expect(declined.report).toEqual([{ planDigest, invocationId, uncertainReceipts: 1, unfinishedReceipts: 0, artifactStored: false }]);
    const after = (await revisionRef(revisionsDb, lang, revision).get()).data();
    expect(after).toMatchObject({ status: "approved", lastReport: [planDigest] });
    const removed = [];
    const confirmed = await retireRevision(deps({ removeTag: async tag => { removed.push(tag); } }), { lang, revision, by: "test", confirmUnrecoverable: true });
    expect(confirmed).toMatchObject({ outcome: "retired", tag: `t-${revision}` });
    expect(removed).toEqual([`t-${revision}`]);
    expect((await revisionRef(revisionsDb, lang, revision).get()).data()).toMatchObject({ status: "retired", unrecoverable: [planDigest] });
  });

  it("a plan whose invocation stored its artifact and finished every write needs nothing", async () => {
    const revision = `rev-${randomUUID()}`;
    await approve(revision);
    const { planDigest, invocationId } = await admit(revision);
    const receipt = brokerDb.collection("receipts").doc(randomUUID());
    await receipt.set({ pld: planDigest });
    await receipt.collection("outcome").doc("final").set({ status: "succeeded" });
    await apiDb.collection("artifacts").doc(invocationId).set({ stored: true });
    expect(await report(revision)).toEqual([]);
  });

  it("an interrupted retirement stays retiring until resumed or cancelled", async () => {
    const revision = `rev-${randomUUID()}`;
    await approve(revision);
    // Interrupted after the mark: the report never came back.
    await expect(retireRevision(deps({ report: async () => { throw new Error("interrupted"); } }), { lang, revision, by: "test" })).rejects.toThrow(/interrupted/);
    expect(await statusOf(revision)).toBe("retiring");
    await expect(retireRevision(deps(), { lang, revision, by: "test" })).rejects.toMatchObject({ reason: "revision-state" });
    await retireRevision(deps(), { lang, revision, by: "test", cancel: true });
    expect(await statusOf(revision)).toBe("approved");
    // Again, then resumed to the end.
    await expect(retireRevision(deps({ report: async () => { throw new Error("interrupted"); } }), { lang, revision, by: "test" })).rejects.toThrow(/interrupted/);
    expect(await retireRevision(deps(), { lang, revision, by: "test", resume: true })).toMatchObject({ outcome: "retired" });
    await expect(retireRevision(deps(), { lang, revision, by: "test", cancel: true })).rejects.toMatchObject({ reason: "revision-state" });
  });

  it("the tag is removed only once proofs issued before retirement have expired, and resumes there", async () => {
    const revision = `rev-${randomUUID()}`;
    await approve(revision);
    const slept = [];
    let fail = true;
    const removeTag = async () => { if (fail) throw new Error("gcloud failed"); };
    await expect(retireRevision(deps({ removeTag, sleep: async ms => { slept.push(ms); } }), { lang, revision, by: "test" })).rejects.toThrow(/gcloud failed/);
    expect(slept[0]).toBeGreaterThan(ADMISSION_TOKEN_LIFETIME_MS - 5000);
    expect(await statusOf(revision)).toBe("retired");
    await expect(retireRevision(deps(), { lang, revision, by: "test" })).rejects.toMatchObject({ reason: "revision-state" });
    fail = false;
    expect(await retireRevision(deps({ removeTag }), { lang, revision, by: "test", resume: true })).toMatchObject({ outcome: "retired" });
    expect((await revisionRef(revisionsDb, lang, revision).get()).data()?.tagRemovedAt).toBeDefined();
  });

  it("refuses unknown revisions and wrong starting states", async () => {
    const revision = `rev-${randomUUID()}`;
    await expect(retireRevision(deps(), { lang, revision, by: "test" })).rejects.toMatchObject({ reason: "revision-not-approved" });
    await approve(revision);
    await expect(retireRevision(deps(), { lang, revision, by: "test", resume: true })).rejects.toMatchObject({ reason: "revision-state" });
    await expect(retireRevision(deps(), { lang, revision, by: "test", cancel: true })).rejects.toMatchObject({ reason: "revision-state" });
  });
});
