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
  createFirestoreInvocationStore,
  createFirestoreConnectionStore,
  createFirestoreGrantStore,
  AdmissionRefused,
} from "./index.js";
import {
  createFirestoreApprovals,
  createFirestoreLeaseFence,
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

  it("a cancelled retirement can't finish a later one with its stale report", async () => {
    const revision = `rev-${randomUUID()}`;
    await approve(revision);
    // Retirement A reports (nothing yet), then stalls before its next step.
    let resumeA;
    const stalledA = new Promise(resolve => { resumeA = resolve; });
    let reportedA;
    const aReported = new Promise(resolve => { reportedA = resolve; });
    const a = retireRevision(deps({ report: async r => { const items = await report(r); reportedA(); await stalledA; return items; } }), { lang, revision, by: "a" })
      .then(result => ({ result }), error => ({ error }));
    await aReported;
    // The operator cancels A; a plan is then admitted; retirement B starts and
    // stalls after its own report, which names that plan.
    await retireRevision(deps(), { lang, revision, by: "op", cancel: true });
    const { planDigest } = await admit(revision);
    let resumeB;
    const stalledB = new Promise(resolve => { resumeB = resolve; });
    let reportedB;
    const bReported = new Promise(resolve => { reportedB = resolve; });
    const b = retireRevision(deps({ report: async r => { const items = await report(r); reportedB(); await stalledB; return items; } }), { lang, revision, by: "b" });
    await bReported;
    // A wakes with its empty report: it must not retire the revision.
    resumeA();
    const resumedA = await a;
    expect("error" in resumedA && resumedA.error.reason).toBe("retirement-superseded");
    expect(await statusOf(revision)).toBe("retiring");
    // B, unconfirmed, names the new plan and cancels itself.
    resumeB();
    const resultB = await b;
    expect(resultB.outcome).toBe("cancelled");
    expect(resultB.outcome === "cancelled" && resultB.report.map(i => i.planDigest)).toEqual([planDigest]);
    expect(await statusOf(revision)).toBe("approved");
  });

  it("each retirement carries its own id, which cancelling clears and resuming adopts", async () => {
    const revision = `rev-${randomUUID()}`;
    await approve(revision);
    await expect(retireRevision(deps({ report: async () => { throw new Error("interrupted"); } }), { lang, revision, by: "a" })).rejects.toThrow(/interrupted/);
    const first = (await revisionRef(revisionsDb, lang, revision).get()).data();
    expect(first.retirementId).toMatch(/^[0-9a-f-]{36}$/);
    await retireRevision(deps(), { lang, revision, by: "op", cancel: true });
    expect((await revisionRef(revisionsDb, lang, revision).get()).data()?.retirementId).toBeUndefined();
    await expect(retireRevision(deps({ report: async () => { throw new Error("interrupted"); } }), { lang, revision, by: "b" })).rejects.toThrow(/interrupted/);
    const second = (await revisionRef(revisionsDb, lang, revision).get()).data();
    expect(second.retirementId).not.toBe(first.retirementId);
    expect(await retireRevision(deps(), { lang, revision, by: "op", resume: true })).toMatchObject({ outcome: "retired" });
    expect((await revisionRef(revisionsDb, lang, revision).get()).data()).toMatchObject({ status: "retired", retirementId: second.retirementId });
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

// The admission side as Policy runs it (W4 PR 2): the invocation marker, the
// plan-write transaction that consumes the lease, and reads at a readTime.
run("chain admission in Firestore", () => {
  let policyDb;
  let revisionsDb;
  let invocations;
  beforeAll(() => {
    const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: "demo-graffiticode" });
    policyDb = getFirestore(app, "policy");
    revisionsDb = getFirestore(app, "revisions");
    invocations = createFirestoreInvocationStore(policyDb);
  });
  const allocate = (over = {}) => invocations.allocate({
    uid: `u-${randomUUID()}`, connectionId: "conn-1", taskId: "chain", inputDigest: "d".repeat(64), idempotencyKey: `k-${randomUUID()}`, admission: true, ...over,
  });
  const plan = invocationId => ({ contractVersion: 2, invocationId, stages: [] });
  const commit = async (invocationId, leaseId, readTime, over = {}) => invocations.commitPlan({
    leaseId, invocationId, planDigest: "p".repeat(64), plan: plan(invocationId), revisions: ["rev-a"], readTime, maxAgeMs: 5000, ...over,
  });
  const fence = () => createFirestoreLeaseFence(policyDb);

  it("marks an invocation durably, and a retry reports its marker and plan", async () => {
    const uid = `u-${randomUUID()}`;
    const key = `k-${randomUUID()}`;
    const first = await allocate({ uid, idempotencyKey: key });
    expect(first).toMatchObject({ contract: 2, planDigest: null, reused: false });
    expect(await invocations.get(first.invocationId)).toMatchObject({ uid, contract: 2, planDigest: null, taskId: "chain" });
    const lease = await fence().register(["rev-a"]);
    await commit(first.invocationId, lease.id, lease.readTime);
    expect(await allocate({ uid, idempotencyKey: key, admission: false })).toMatchObject({ invocationId: first.invocationId, contract: 2, planDigest: "p".repeat(64), reused: true });
    const plain = await allocate({ admission: false });
    expect((await invocations.get(plain.invocationId)).contract).toBe(1);
  });

  it("consumes the lease and stores the first plan only; a retry keeps it; another plan, an unmarked invocation or a fenced lease can't", async () => {
    const inv = await allocate();
    const lease = await fence().register(["rev-a"]);
    expect(await commit(inv.invocationId, lease.id, lease.readTime)).toEqual({ created: true });
    expect((await policyDb.collection("admission-leases").doc(lease.id).get()).exists).toBe(false);
    expect(await invocations.getPlan("p".repeat(64))).toEqual(plan(inv.invocationId));
    const again = await fence().register(["rev-a"]);
    expect(await commit(inv.invocationId, again.id, again.readTime)).toEqual({ created: false });
    const third = await fence().register(["rev-a"]);
    await expect(commit(inv.invocationId, third.id, third.readTime, { planDigest: "q".repeat(64) })).rejects.toMatchObject({ reason: "plan-mismatch" });
    const plain = await allocate({ admission: false });
    const fourth = await fence().register(["rev-a"]);
    await expect(commit(plain.invocationId, fourth.id, fourth.readTime)).rejects.toMatchObject({ reason: "invocation-incompatible" });
    const fenced = await fence().register([`rev-${randomUUID()}`]);
    await invalidateLeases(policyDb, (await policyDb.collection("admission-leases").doc(fenced.id).get()).data().revisions[0]);
    const other = await allocate();
    await expect(commit(other.invocationId, fenced.id, fenced.readTime)).rejects.toBeInstanceOf(AdmissionRefused);
    await expect(commit(other.invocationId, fenced.id, fenced.readTime)).rejects.toMatchObject({ reason: "revision-retiring" });
  });

  it("refuses a decision older than the bound when its transaction starts", async () => {
    const inv = await allocate();
    const lease = await fence().register(["rev-a"]);
    const late = lease.readTime.toMillis() + 6000;
    await expect(commit(inv.invocationId, lease.id, lease.readTime, { now: () => late })).rejects.toMatchObject({ reason: "admission-stale" });
    expect((await invocations.get(inv.invocationId)).planDigest).toBeNull();
  });

  it("racing retirement's invalidation, either the plan commits and the lease is gone, or it can't commit", async () => {
    for (let i = 0; i < 8; i++) {
      const revision = `rev-${randomUUID()}`;
      const inv = await allocate();
      const lease = await fence().register([revision]);
      const digest = randomUUID().replace(/-/g, "").padEnd(64, "0");
      const [committed, invalidated] = await Promise.all([
        commit(inv.invocationId, lease.id, lease.readTime, { planDigest: digest, revisions: [revision] }).then(r => r, e => e),
        invalidateLeases(policyDb, revision),
      ]);
      const stored = await invocations.getPlan(digest);
      if (committed instanceof Error) {
        expect(committed).toMatchObject({ reason: "revision-retiring" });
        expect(stored).toBeNull();
        expect(invalidated).toBe(1);
      } else {
        expect(committed).toEqual({ created: true });
        expect(stored).not.toBeNull();
        expect(invalidated).toBe(0);
      }
    }
  }, 60000);

  it("reads connections, grants and approvals as of the admission's readTime", async () => {
    const connections = createFirestoreConnectionStore(policyDb);
    const grants = createFirestoreGrantStore(policyDb);
    const connectionId = `conn-${randomUUID()}`;
    await connections.put({ connectionId, ownerUid: "0xowner", backend: "learnosity", status: "active" });
    await grants.put({ grantId: `g-${connectionId}`, connectionId, ownerUid: "0xowner", recipientUid: "0xr", permissions: [] });
    const lang = String(1000 + Math.floor(Math.random() * 8999));
    await revisionRef(revisionsDb, lang, "rev-a").set({ lang, revision: "rev-a", status: "approved" });
    const { readTime } = await fence().register(["rev-a"]);
    // Changed after the read time: the admission still sees the earlier state.
    await connections.put({ connectionId, ownerUid: "0xowner", backend: "learnosity", status: "disabled" });
    await grants.delete(`g-${connectionId}`);
    await revisionRef(revisionsDb, lang, "rev-a").set({ lang, revision: "rev-a", status: "retiring" });
    expect((await connections.get(connectionId, { readTime })).status).toBe("active");
    expect(await grants.get(`g-${connectionId}`, { readTime })).toMatchObject({ recipientUid: "0xr" });
    const approvals = createFirestoreApprovals(revisionsDb);
    expect((await approvals.read([{ lang, revision: "rev-a" }], readTime))[0]).toMatchObject({ languageKnown: true, record: { status: "approved" } });
    expect((await approvals.read([{ lang: "9999", revision: "rev-a" }], readTime))[0]).toMatchObject({ languageKnown: false, record: null });
    // And now, live.
    expect((await connections.get(connectionId)).status).toBe("disabled");
    expect(await grants.get(`g-${connectionId}`)).toBeNull();
    expect((await approvals.current(lang, "rev-a")).status).toBe("retiring");
  });
});
