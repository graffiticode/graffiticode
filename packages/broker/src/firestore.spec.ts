// Runs against the Firestore emulator only (FIRESTORE_EMULATOR_HOST set), e.g.
//   firebase emulators:exec --only firestore "npx jest src/firestore.spec.js"
import { randomBytes, randomUUID } from "node:crypto";
import admin from "firebase-admin";
import {
  createFirestoreOnceStore,
  createFirestoreReceiptStore,
  createFirestoreSecretStore,
  createFirestoreActivityStore,
  createSecretBox,
  StepConflict
} from "./index.js";

const run = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

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
