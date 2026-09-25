// Runs against the Firestore emulator only (FIRESTORE_EMULATOR_HOST set), e.g.
//   firebase emulators:exec --only firestore "npx jest src/firestore.spec.js"
import { randomBytes, randomUUID } from "node:crypto";
import admin from "firebase-admin";
import {
  createFirestoreOnceStore,
  createFirestoreReceiptStore,
  createFirestoreSecretStore,
  createSecretBox
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

  it("stores secrets sealed and returns them opened", async () => {
    const box = createSecretBox({ key: randomBytes(32).toString("hex") });
    const secrets = createFirestoreSecretStore(db, { box });
    const conn = randomUUID();
    await secrets.put(conn, { key: "k", secret: "s3cret" });
    const raw = (await db.collection("connection-secrets").doc(conn).get()).data();
    expect(JSON.stringify(raw)).not.toContain("s3cret");
    expect(await secrets.get(conn)).toEqual({ key: "k", secret: "s3cret" });
    expect(await secrets.get(randomUUID())).toBeNull();
  });
});
