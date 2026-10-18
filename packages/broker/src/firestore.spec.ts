/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
// Runs against the Firestore emulator only (FIRESTORE_EMULATOR_HOST set), e.g.
//   firebase emulators:exec --only firestore "npx jest src/firestore.spec.js"
import { randomBytes, randomUUID } from "node:crypto";
import admin from "firebase-admin";
import { generateKeyPair, exportJWK, decodeJwt } from "jose";
import {
  createPolicy,
  createLocalSigner,
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
  StepConflict
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
