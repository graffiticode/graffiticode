/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
// Runs against the Firestore emulator only (FIRESTORE_EMULATOR_HOST set), e.g.
//   firebase emulators:exec --only firestore "npx jest src/firestore.spec.js"
import { createHash, randomBytes, randomUUID } from "node:crypto";
import admin from "firebase-admin";
import { generateKeyPair, exportJWK, decodeJwt } from "jose";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import {
  createPolicy,
  createLocalSigner,
  issueToken,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createProtectedSwitch,
  createAudit,
  createPseudonymizer
} from "@graffiticode/policy";
import {
  createBroker,
  BrokerRefused,
  buildOperations,
  argsDigest,
  localAuthorizer,
  createFirestoreOnceStore,
  createFirestoreReceiptStore,
  createFirestoreSecretStore,
  createFirestoreActivityStore,
  createFirestoreSessionSlotStore,
  SYSTEM_SESSION_SLOTS,
  DEFAULT_SYSTEM_SESSION_MAX_SIGNINGS,
  MAX_EXECUTION_TOKEN_LIFETIME_S,
  SLOT_RETENTION_MARGIN_S,
  createSecretBox,
  StepConflict,
  RunFenced,
  buildThumbnailOperations,
  createMemorySecretStore,
  createReceiptReader,
  stagingRefusalOutcome
} from "./index.js";

const run = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

// A system preview session's signature allowance (the system-preview rate
// limits plan, design point 3), with Policy in process and every Broker
// store in the emulator's Firestore, shared by however many Broker instances
// a test makes: what two Cloud Run instances, or a restart, see.
run("system preview sessions' signature slots in Firestore", () => {
  const SYSTEM = "0xgraffiticode";
  const L0176 = { role: "compiler", lang: "0176" };
  const OP = "learnosity.sign-questions-preview";
  const PREVIEW = { id: "t", name: "T", session_id: "s1", questions: [{ response_id: "r-0", type: "mcq", stimulus: "Q" }] };
  const N = DEFAULT_SYSTEM_SESSION_MAX_SIGNINGS;
  let db;
  let policy;
  let jwks;
  let connectionId;
  let secrets;
  let records;
  let signatures;
  // Seconds added to Policy's signing clock (a session issued in the past).
  let skew;
  const on = createProtectedSwitch({ readFlag: async () => ({ enabled: true }) });

  beforeAll(() => {
    const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: "demo-graffiticode" });
    db = app.firestore();
  });

  beforeEach(async () => {
    skew = 0;
    records = [];
    signatures = 0;
    connectionId = `conn-sys-${randomUUID()}`;
    const pair = await generateKeyPair("ES256", { extractable: true });
    const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1", now: () => Math.floor(Date.now() / 1000) + skew });
    jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
    policy = createPolicy({
      protectedSwitch: on,
      signer,
      jwks,
      connections: createMemoryConnectionStore([{ connectionId, ownerUid: SYSTEM, backend: "learnosity", status: "active" }]),
      invocations: createMemoryInvocationStore(),
      systemConnections: { learnosity: connectionId },
      audit: async () => {},
    } as unknown as Parameters<typeof createPolicy>[0]);
    secrets = createFirestoreSecretStore(db, { box: createSecretBox({ key: randomBytes(32).toString("hex") }) });
    await secrets.create(connectionId, { ownerUid: SYSTEM, backend: "learnosity", key: "system-key", secret: "s" });
  });

  // A Broker instance: its own store objects on the shared database.
  const brokerInstance = () => createBroker({
    protectedSwitch: on,
    jwks,
    operations: buildOperations({ sdk: { init: (service, consumer, secret, body) => { signatures++; return { service, body }; } }, domain: "d", dataApi: async () => ({}) }),
    secrets,
    // As in production (AT-10 rev 9): the system connection is the preview consumer.
    previewConnections: { learnosity: connectionId },
    once: createFirestoreOnceStore(db),
    receipts: createFirestoreReceiptStore(db),
    activity: createFirestoreActivityStore(db),
    slots: createFirestoreSessionSlotStore(db),
    authorize: localAuthorizer(policy),
    audit: createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) }),
  });
  const newSession = async () => (await policy.previewSession({ caller: L0176, lang: "0176" })).sessionToken;
  const mintIn = async (sessionToken, n) =>
    (await policy.mint({ caller: L0176, sessionToken, fn: "init", op: OP, occurrenceId: `init.${n}`, argsDigest: argsDigest(PREVIEW) })).executionToken;
  const sign = (broker, token) => broker.execute({ caller: L0176, token, op: OP, payload: PREVIEW });
  const slotsOf = async sid => (await db.collection(SYSTEM_SESSION_SLOTS).where("sid", "==", sid).get()).docs;

  it("repeated init: one session signs N times, and the N+1th is refused session-exhausted, audited, before any signing", async () => {
    const broker = brokerInstance();
    const s = await newSession();
    for (let n = 0; n < N; n++) await expect(sign(broker, await mintIn(s, n))).resolves.toMatchObject({ status: "succeeded" });
    const err = await sign(broker, await mintIn(s, N)).catch(e => e);
    expect(err).toBeInstanceOf(BrokerRefused);
    expect(err).toMatchObject({ reason: "session-exhausted", status: 429 });
    expect(records.at(-1)).toMatchObject({ event: "execute", outcome: "denied", reason: "session-exhausted", category: "unavailable", provenance: "system" });
    expect(signatures).toBe(N);
    expect(await slotsOf(decodeJwt(s).jti)).toHaveLength(N);
  });

  it("concurrency: N+2 concurrent executions on one session across two Broker instances give exactly N signatures", async () => {
    const [a, b] = [brokerInstance(), brokerInstance()];
    const s = await newSession();
    const tokens = await Promise.all(Array.from({ length: N + 2 }, (_, n) => mintIn(s, n)));
    const results = await Promise.allSettled(tokens.map((t, i) => sign(i % 2 ? b : a, t)));
    expect(results.filter(r => r.status === "fulfilled" && r.value.status === "succeeded")).toHaveLength(N);
    const refusals = results.filter(r => r.status === "rejected").map(r => (r as PromiseRejectedResult).reason);
    expect(refusals.map(e => e.reason)).toEqual(["session-exhausted", "session-exhausted"]);
    expect(signatures).toBe(N);
    expect((await slotsOf(decodeJwt(s).jti)).map(d => d.data().k).sort()).toEqual([...Array(N).keys()]);
  });

  it("instance changes: a Broker restart between signatures keeps the count", async () => {
    const s = await newSession();
    for (let n = 0; n < N; n++) await sign(brokerInstance(), await mintIn(s, n));
    await expect(sign(brokerInstance(), await mintIn(s, N))).rejects.toMatchObject({ reason: "session-exhausted" });
    expect(signatures).toBe(N);
  });

  it("late tokens: a token minted just before sexp executes after the session expired, and TTL cleanup at sexp leaves the count intact", async () => {
    // A session issued long enough ago that it expires in about 4 s.
    skew = -(15 * 60 - 4);
    const s = await newSession();
    skew = 0;
    const { exp: sexp, jti: sid } = decodeJwt(s);
    const broker = brokerInstance();
    for (let n = 0; n < N - 1; n++) await sign(broker, await mintIn(s, n));
    // Two more, minted while the session is still valid.
    const late = [await mintIn(s, N - 1), await mintIn(s, N)];
    expect(late.map(t => decodeJwt(t).sexp)).toEqual([sexp, sexp]);
    // Wait out the session.
    while (Date.now() / 1000 <= sexp) await new Promise(resolve => setTimeout(resolve, 100));
    // Policy mints nothing more for it.
    await expect(mintIn(s, N + 1)).rejects.toMatchObject({ reason: "bad-session" });
    // Storage TTL cleanup at sexp finds no slot expired: each outlives every token the session produced.
    const expired = await db.collection(SYSTEM_SESSION_SLOTS).where("sid", "==", sid).where("expiresAt", "<=", new Date(sexp * 1000)).get();
    await Promise.all(expired.docs.map(d => d.ref.delete()));
    expect(expired.size).toBe(0);
    const kept = await slotsOf(sid);
    expect(kept).toHaveLength(N - 1);
    for (const d of kept) expect(d.data().expiresAt.toMillis()).toBe((sexp + MAX_EXECUTION_TOKEN_LIFETIME_S + SLOT_RETENTION_MARGIN_S) * 1000);
    // The late tokens still count against the session.
    await expect(sign(broker, late[0])).resolves.toMatchObject({ status: "succeeded" });
    await expect(sign(broker, late[1])).rejects.toMatchObject({ reason: "session-exhausted" });
    expect(signatures).toBe(N);
  }, 20_000);
});

run("firestore broker stores", () => {
  let db;
  beforeAll(() => {
    const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: "demo-graffiticode" });
    db = app.firestore();
  });

  it("claims a jti once, even under concurrency", async () => {
    const once = createFirestoreOnceStore(db);
    const jti = randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => once.claim(jti, Date.now() / 1000 + 60)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("keeps a write's evidence on its claim, created with it (W5, WRITE-02)", async () => {
    const receipts = createFirestoreReceiptStore(db);
    const op = `${randomUUID()}/s0/n1.0`;
    const evidence = { format: 1, mark: { questions: "data.metadata.gc_operation", items: "metadata.gc_operation" }, records: [{ step: "questions", kind: "question", reference: "q-0", digest: "d".repeat(64) }] };
    await receipts.claim(op, { principal: "u" }, { evidence });
    expect((await receipts.claim(op, { principal: "u" })).claim.evidence).toEqual(evidence);
    // A later claim attempt can't replace it.
    await receipts.claim(op, { principal: "u" }, { evidence: { ...evidence, format: 2 } });
    expect((await receipts.claim(op, { principal: "u" })).claim.evidence.format).toBe(1);
  });

  it("names its plan on the claim, where retiring a revision looks for it (W4)", async () => {
    const receipts = createFirestoreReceiptStore(db);
    const op = `${randomUUID()}/s1/n1.0`;
    const pld = randomUUID().replace(/-/g, "").padEnd(64, "a");
    await receipts.claim(op, { principal: "u" }, { pld });
    const found = await db.collection("receipts").where("pld", "==", pld).get();
    expect(found.docs.map(d => d.data().operationId)).toEqual([op]);
    const unbound = `${randomUUID()}/s0/n1.0`;
    await receipts.claim(unbound, { principal: "u" });
    expect((await receipts.claim(unbound, { principal: "u" })).claim.pld).toBeUndefined();
  });

  it("claims an operation receipt once, and records its outcome once", async () => {
    const receipts = createFirestoreReceiptStore(db);
    const op = `${randomUUID()}/n1.0`;
    const binding = { principal: "u", connectionId: "c", fn: "f", op: "o", argsDigest: "d" };
    const results = await Promise.all(Array.from({ length: 10 }, () => receipts.claim(op, binding)));
    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(results.find(r => !r.created).claim.binding).toEqual(binding);
    expect(await receipts.getOutcome(op)).toBeNull();
    await receipts.putOutcome(op, { status: "succeeded", steps: ["questions"], result: null });
    await expect(receipts.putOutcome(op, { status: "failed", steps: [], result: null })).rejects.toThrow();
    expect((await receipts.getOutcome(op)).status).toBe("succeeded");
  });

  // P1b: a replay token reads a claim and must never create one.
  it("reads a receipt's claim without ever creating one", async () => {
    const receipts = createFirestoreReceiptStore(db);
    const op = `${randomUUID()}/n1.0`;
    expect(await receipts.getClaim(op)).toBeNull();
    expect((await db.collection("receipts").where("operationId", "==", op).get()).size).toBe(0);
    const binding = { principal: "u", connectionId: "c", fn: "f", op: "o", argsDigest: "d" };
    await receipts.claim(op, binding);
    expect((await receipts.getClaim(op)).binding).toEqual(binding);
  });

  it("counts active executions until they end or expire", async () => {
    const activity = createFirestoreActivityStore(db);
    const now = Date.now();
    const base = await activity.count(now);
    const a = `${randomUUID()}/n1.0`;
    const b = `${randomUUID()}/n1.0`;
    await activity.begin(a, now + 60_000);
    await activity.begin(b, now + 1_000);
    expect(await activity.count(now)).toBe(base + 2);
    expect(await activity.count(now + 2_000)).toBe(base + 1);
    await activity.end(a);
    await activity.end(b);
    expect(await activity.count(now)).toBe(base);
  });

  it("records each step once, in order, acknowledging an identical repeat and refusing a different one", async () => {
    const receipts = createFirestoreReceiptStore(db);
    const op = `${randomUUID()}/n1.0`;
    expect(await receipts.getSteps(op)).toEqual([]);
    await receipts.putStep(op, 1, "items");
    await receipts.putStep(op, 0, "questions");
    await expect(receipts.putStep(op, 0, "questions")).resolves.toBeUndefined();
    await expect(receipts.putStep(op, 0, "items")).rejects.toBeInstanceOf(StepConflict);
    const racers = await Promise.allSettled(["a", "b"].map(step => receipts.putStep(op, 2, step)));
    expect(racers.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await receipts.getSteps(op)).toEqual(["questions", "items", racers[0].status === "fulfilled" ? "a" : "b"]);
  });

  // C5 (broker.js 7e): one run record, read and written with the outcome in
  // one transaction, so an abort, the outcome and the next run exclude each
  // other, and an outcome is fenced to its run.
  it("aborts a run, starts the next one exactly once, and fences outcomes to their run", async () => {
    const receipts = createFirestoreReceiptStore(db);
    const op = `${randomUUID()}/s0/o1`;
    expect(await receipts.getRunState(op)).toEqual({ run: 0, aborted: false });
    expect(await receipts.startRun(op, 1)).toBe(false);
    await receipts.abortRun(op, 0, { reason: "authorization-unavailable" });
    await expect(receipts.abortRun(op, 0, { reason: "again" })).rejects.toBeInstanceOf(RunFenced);
    await expect(receipts.putOutcome(op, { status: "failed" }, { run: 0 })).rejects.toBeInstanceOf(RunFenced);
    expect(await receipts.getRunState(op)).toEqual({ run: 0, aborted: true });
    const racers = await Promise.all(Array.from({ length: 4 }, () => receipts.startRun(op, 1)));
    expect(racers.filter(Boolean)).toHaveLength(1);
    expect(await receipts.getRunState(op)).toEqual({ run: 1, aborted: false });
    // An abort and an outcome racing on the open run: exactly one lands.
    const race = await Promise.allSettled([receipts.abortRun(op, 1, { reason: "late" }), receipts.putOutcome(op, { status: "succeeded" }, { run: 1 })]);
    expect(race.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const outcome = await receipts.getOutcome(op);
    expect(Boolean(outcome) !== (await receipts.getRunState(op)).aborted).toBe(true);
    // A superseded run is fenced first, whatever was recorded since.
    await expect(receipts.putOutcome(op, { status: "failed" }, { run: 0 })).rejects.toBeInstanceOf(RunFenced);
  }, 30_000);

  // C5 (decision 5): what a step observed, and a conditional step's attempts.
  it("keeps a step's observation, and each attempt of a conditional step once, in order", async () => {
    const receipts = createFirestoreReceiptStore(db);
    const op = `${randomUUID()}/s0/o1`;
    await receipts.putStepAttempt(op, 2, { step: "publish", attempt: 2, decisionId: "decision-0002", observed: "published" });
    await receipts.putStepAttempt(op, 1, { step: "publish", attempt: 1, decisionId: "decision-0001", observed: "precondition-failed" });
    await expect(receipts.putStepAttempt(op, 1, { step: "publish", attempt: 1, decisionId: "decision-0009", observed: "published" })).rejects.toThrow(/already recorded/);
    await expect(receipts.putStepAttempt(op, 3, { step: "publish", attempt: 2, decisionId: "decision-0003", observed: "published" })).rejects.toThrow(/attempt index/);
    expect((await receipts.getStepAttempts(op)).map(({ k, step, attempt, decisionId, observed }) => ({ k, step, attempt, decisionId, observed }))).toEqual([
      { k: 1, step: "publish", attempt: 1, decisionId: "decision-0001", observed: "precondition-failed" },
      { k: 2, step: "publish", attempt: 2, decisionId: "decision-0002", observed: "published" },
    ]);
    await receipts.putStep(op, 0, "publish", { observed: "published", other: "dropped" });
    expect(await receipts.getSteps(op)).toEqual(["publish"]);
    expect((await receipts.getStepRecords(op)).map(({ n, step, observed, other }) => ({ n, step, observed, other }))).toEqual([{ n: 0, step: "publish", observed: "published", other: undefined }]);
  });

  it("claims a session's slots once each, in order, under concurrency, and refuses past the allowance", async () => {
    const slots = createFirestoreSessionSlotStore(db);
    const sid = randomUUID();
    const expiresAt = Date.now() + 3_600_000;
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => slots.claim(sid, 4, { expiresAt, jti: `j-${i}`, opid: `sys-1/preview/p.${i}` })));
    expect(results.filter(k => k !== null).sort()).toEqual([0, 1, 2, 3]);
    expect(results.filter(k => k === null)).toHaveLength(6);
    const docs = await db.collection(SYSTEM_SESSION_SLOTS).where("sid", "==", sid).get();
    expect(docs.docs.map(d => d.id).sort()).toEqual([0, 1, 2, 3].map(k => `${sid}:${k}`));
    expect(docs.docs[0].data().expiresAt.toMillis()).toBe(expiresAt);
  });

  it("stores secrets sealed and bound to their owner and backend", async () => {
    const box = createSecretBox({ key: randomBytes(32).toString("hex") });
    const secrets = createFirestoreSecretStore(db, { box });
    const conn = randomUUID();
    const cred = { ownerUid: "u1", backend: "learnosity", key: "k", secret: "s3cret" };
    await secrets.create(conn, cred);
    const doc = db.collection("connection-secrets").doc(conn);
    expect(JSON.stringify((await doc.get()).data())).not.toContain("s3cret");
    expect(await secrets.get(conn)).toEqual(cred);
    expect(await secrets.get(randomUUID())).toBeNull();

    await expect(secrets.create(conn, cred)).rejects.toThrow(/already used/);
    await expect(secrets.rotate(conn, { ...cred, key: "k2" })).rejects.toThrow(/provider account/);
    await secrets.rotate(conn, { ...cred, secret: "s4" });
    expect((await secrets.get(conn)).secret).toBe("s4");

    // Editing the stored owner does not rebind the secret; it stops decrypting.
    await doc.update({ ownerUid: "u2" });
    await expect(secrets.get(conn)).rejects.toThrow();

    await secrets.delete(conn);
    expect(await secrets.get(conn)).toBeNull();
    await expect(secrets.create(conn, cred)).rejects.toThrow(/already used/);
  });
});

// C5d (docs/c5d-refusal-and-hold-plan.md decision 1 and §4): a definite
// staging refusal's claim and outcome, or its reopened run and outcome, are
// one Firestore transaction. A crash inside it leaves neither record, and the
// claim's create-once decides every race.
run("the staging refusal's transaction in Firestore (C5d)", () => {
  let db;
  beforeAll(() => {
    const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: "demo-graffiticode" });
    db = app.firestore();
  });
  const BINDING = { principal: "u", scope: { kind: "item", id: "item-1" }, op: "gcs.put-thumbnail", registryVersion: 10, argsDigest: "d" };
  const newOp = () => `inv-${randomUUID()}/s0/o1`;
  const receiptDoc = op => db.collection("receipts").doc(createHash("sha256").update(op).digest("hex"));

  // The database, with each transaction made to throw right after its
  // `after`-th write (create or set) is staged, before it commits: a process
  // dying inside the transaction. Not a seam in the store: only the db.
  const crashingDb = after => ({
    collection: (...args) => db.collection(...args),
    runTransaction: (fn, options) => db.runTransaction(tx => {
      let writes = 0;
      const wrote = () => { if (++writes === after) throw new Error("process died inside the transaction"); };
      const wrapped = {
        get: (...args) => tx.get(...args),
        create: (ref, data) => { tx.create(ref, data); wrote(); return wrapped; },
        set: (ref, data, opts) => { tx.set(ref, data, opts); wrote(); return wrapped; },
        update: (...args) => { tx.update(...args); wrote(); return wrapped; },
      };
      return fn(wrapped);
    }, options),
  });

  it("claimRefused creates the claim and the outcome together, once", async () => {
    const receipts = createFirestoreReceiptStore(db);
    const op = newOp();
    expect(await receipts.claimRefused(op, BINDING, { pld: "p".repeat(64), evidence: { refused: "staging-unavailable" } }, stagingRefusalOutcome())).toEqual({ created: true });
    expect(await receipts.getClaim(op)).toMatchObject({ operationId: op, binding: BINDING, pld: "p".repeat(64), evidence: { refused: "staging-unavailable" } });
    expect(await receipts.getOutcome(op)).toMatchObject(stagingRefusalOutcome());
    const again = await receipts.claimRefused(op, { ...BINDING, principal: "other" }, {}, { status: "succeeded", steps: [] });
    expect(again).toMatchObject({ created: false, claim: { binding: BINDING } });
    expect(await receipts.getOutcome(op)).toMatchObject({ status: "failed" });
    // A claim that exists first: returned, nothing written.
    const claimed = newOp();
    await receipts.claim(claimed, BINDING);
    expect(await receipts.claimRefused(claimed, BINDING, {}, stagingRefusalOutcome())).toMatchObject({ created: false });
    expect(await receipts.getOutcome(claimed)).toBeNull();
  });

  it.each([[1, "after the claim's create, before the outcome's"], [2, "after both creates, before the commit"]])(
    "leaves neither record when claimRefused crashes %s (%s), and the retry records once",
    async after => {
      const op = newOp();
      await expect(createFirestoreReceiptStore(crashingDb(after)).claimRefused(op, BINDING, { evidence: { refused: "staging-unavailable" } }, stagingRefusalOutcome())).rejects.toThrow(/inside the transaction/);
      const receipts = createFirestoreReceiptStore(db);
      expect((await receiptDoc(op).get()).exists).toBe(false);
      expect(await receipts.getClaim(op)).toBeNull();
      expect(await receipts.getOutcome(op)).toBeNull();
      expect(await createReceiptReader({ receipts })({ invocationId: op.split("/")[0] })).toEqual({ invocationId: op.split("/")[0], operations: [] });
      expect(await receipts.claimRefused(op, BINDING, { evidence: { refused: "staging-unavailable" } }, stagingRefusalOutcome())).toEqual({ created: true });
      expect(await receipts.claimRefused(op, BINDING, { evidence: { refused: "staging-unavailable" } }, stagingRefusalOutcome())).toMatchObject({ created: false });
      expect(await receipts.getOutcome(op)).toMatchObject({ status: "failed", reason: "staging-unavailable" });
    },
  );

  it.each([[1, "after the run's set, before the outcome's create"], [2, "after both, before the commit"]])(
    "leaves the aborted run and no outcome when refuseRun crashes %s (%s), and the retry records once",
    async after => {
      const receipts = createFirestoreReceiptStore(db);
      const op = newOp();
      await receipts.claim(op, BINDING, { evidence: { format: "gcs-thumbnail-1" } });
      await receipts.abortRun(op, 0, { reason: "authorization-unavailable" });
      await expect(createFirestoreReceiptStore(crashingDb(after)).refuseRun(op, 1, stagingRefusalOutcome())).rejects.toThrow(/inside the transaction/);
      expect(await receipts.getRunState(op)).toEqual({ run: 0, aborted: true });
      expect(await receipts.getOutcome(op)).toBeNull();
      expect(await receipts.refuseRun(op, 1, stagingRefusalOutcome())).toBe(true);
      expect(await receipts.refuseRun(op, 1, stagingRefusalOutcome())).toBe(false);
      expect(await receipts.getRunState(op)).toEqual({ run: 1, aborted: false });
      expect(await receipts.getOutcome(op)).toMatchObject({ status: "failed", reason: "staging-unavailable" });
    },
  );

  it("refuseRun only where startRun would succeed", async () => {
    const receipts = createFirestoreReceiptStore(db);
    const op = newOp();
    await receipts.claim(op, BINDING);
    expect(await receipts.refuseRun(op, 1, stagingRefusalOutcome())).toBe(false);
    await receipts.abortRun(op, 0, { reason: "authorization-unavailable" });
    expect(await receipts.refuseRun(op, 2, stagingRefusalOutcome())).toBe(false);
    expect(await receipts.getOutcome(op)).toBeNull();
    expect(await receipts.refuseRun(op, 1, stagingRefusalOutcome())).toBe(true);
    await expect(receipts.abortRun(op, 1, { reason: "late" })).rejects.toBeInstanceOf(RunFenced);
    expect(await receipts.startRun(op, 2)).toBe(false);
  });

  it("a claim racing claimRefused: exactly one wins, and the loser writes nothing", async () => {
    const receipts = createFirestoreReceiptStore(db);
    for (let i = 0; i < 5; i++) {
      const op = newOp();
      const [claimed, refused] = await Promise.all([receipts.claim(op, { ...BINDING, principal: "claimer" }), receipts.claimRefused(op, { ...BINDING, principal: "refuser" }, {}, stagingRefusalOutcome())]);
      expect([claimed.created, refused.created].filter(Boolean)).toHaveLength(1);
      const outcome = await receipts.getOutcome(op);
      if (claimed.created) {
        expect(refused.claim.binding.principal).toBe("claimer");
        expect(outcome).toBeNull();
      } else {
        expect(claimed.claim.binding.principal).toBe("refuser");
        expect(outcome).toMatchObject({ status: "failed" });
      }
    }
  }, 30_000);

  it("concurrent claimRefused calls record one outcome", async () => {
    const receipts = createFirestoreReceiptStore(db);
    const op = newOp();
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => receipts.claimRefused(op, { ...BINDING, principal: `r${i}` }, {}, stagingRefusalOutcome())));
    expect(results.filter(r => r.created)).toHaveLength(1);
    const winner = (await receipts.getClaim(op)).binding.principal;
    expect(results.filter(r => !r.created).every(r => r.claim.binding.principal === winner)).toBe(true);
  }, 30_000);

  it("startRun racing refuseRun, and two refuseRuns: exactly one succeeds", async () => {
    const receipts = createFirestoreReceiptStore(db);
    const reopened = async () => {
      const op = newOp();
      await receipts.claim(op, BINDING);
      await receipts.abortRun(op, 0, { reason: "authorization-unavailable" });
      return op;
    };
    for (let i = 0; i < 3; i++) {
      const op = await reopened();
      const [started, refused] = await Promise.all([receipts.startRun(op, 1), receipts.refuseRun(op, 1, stagingRefusalOutcome())]);
      expect([started, refused].filter(Boolean)).toHaveLength(1);
      expect(Boolean(await receipts.getOutcome(op))).toBe(refused);
      const again = await reopened();
      const both = await Promise.all([receipts.refuseRun(again, 1, stagingRefusalOutcome()), receipts.refuseRun(again, 1, stagingRefusalOutcome())]);
      expect(both.filter(Boolean)).toHaveLength(1);
    }
  }, 30_000);

  // The whole Broker over Firestore: two requests that both find staging
  // missing record one refusal, and both answer.
  it("two Broker instances refusing the same operation together record one outcome", async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
    const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
    const payload = { item: "itemFs0000000000001", sha256: "c".repeat(64), captureSequence: 1 };
    const instance = () => createBroker({
      protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
      jwks,
      operations: buildThumbnailOperations({ storage: { read: async () => null, getMetadata: async () => null, prepareUpload: async () => { throw new Error("never"); } }, buckets: { thumbnails: "graffiticode-c5a-gate", staging: "graffiticode-command-staging" }, attempts: 4 }),
      secrets: createMemorySecretStore({}),
      once: createFirestoreOnceStore(db),
      receipts: createFirestoreReceiptStore(db),
      activity: createFirestoreActivityStore(db),
      authorize: async () => ({ decisionId: `decision-${randomUUID()}` }),
      audit: async () => {},
    });
    const opid = `inv-${randomUUID()}/s0/o1`;
    const token = () => issueToken(signer, "execution", { sub: "0xowner", lang: "0013", fn: "snap", op: "gcs.put-thumbnail", sid: "session-1", opid, argd: argsDigest(payload), rv: REGISTRY_VERSION, prv: "user", cv: 3, scp: { kind: "item", id: payload.item }, pld: "b".repeat(64), stg: "s0", cmd: `c:${"a".repeat(64)}`, fg: 1 });
    const L0013 = { role: "compiler", lang: "0013" };
    const [a, b] = [instance(), instance()];
    const answers = await Promise.all([a, b].map(async broker => broker.execute({ caller: L0013, token: await token(), op: "gcs.put-thumbnail", payload }).then(v => v, e => e)));
    for (const answer of answers) {
      if (answer instanceof BrokerRefused) expect(answer).toMatchObject({ reason: "staging-unavailable", status: 409 });
      else expect(answer).toMatchObject({ status: "failed", reason: "staging-unavailable", replayed: true });
    }
    expect(answers.filter(x => x instanceof BrokerRefused).length).toBeGreaterThanOrEqual(1);
    const receipts = createFirestoreReceiptStore(db);
    expect(await receipts.getOutcome(opid)).toMatchObject({ status: "failed", steps: [], reason: "staging-unavailable" });
    expect((await receipts.getClaim(opid)).evidence).toEqual({ refused: "staging-unavailable" });
  }, 30_000);
});
