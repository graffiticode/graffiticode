import { getFirestore } from "../firebase.js";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildApiKeyStorer } from "./api-keys.js";
import { deleteTokenIndex, hashedTokenId, readTokenIndex, tokenIndexRef } from "./token-index.js";

// Index documents are named by the token's hash, never the token (a
// document's name shows in audit logs); entries named the old way are still
// found, and moved.
describe("storage/token-index", () => {
  const BASE = "api-keys/-indexes-/token-to-id";

  beforeEach(async () => {
    await cleanUpFirebase();
  });

  it("names an entry by the token's SHA-256, never the token", () => {
    const id = hashedTokenId("secret-token");
    expect(id).toMatch(/^h:[0-9a-f]{64}$/);
    expect(id).not.toContain("secret-token");
    expect(hashedTokenId("secret-token")).toBe(id);
  });

  it("finds a legacy entry named by the raw token, and moves it to the hashed name", async () => {
    const db = getFirestore();
    await db.doc(`${BASE}/legacy-token`).set({ id: "key-1" });

    await expect(readTokenIndex(db, BASE, "legacy-token")).resolves.toEqual({ id: "key-1" });

    expect((await db.doc(`${BASE}/legacy-token`).get()).exists).toBe(false);
    expect((await tokenIndexRef(db, BASE, "legacy-token").get()).data()).toEqual({ id: "key-1" });
    // Found again under its new name.
    await expect(readTokenIndex(db, BASE, "legacy-token")).resolves.toEqual({ id: "key-1" });
  });

  it("answers null for a token with no entry", async () => {
    await expect(readTokenIndex(getFirestore(), BASE, "unknown")).resolves.toBeNull();
  });

  it("deletes both names", async () => {
    const db = getFirestore();
    await db.doc(`${BASE}/old`).set({ id: "a" });
    await tokenIndexRef(db, BASE, "old").set({ id: "a" });
    await deleteTokenIndex(db.batch(), db, BASE, "old").commit();
    expect((await db.doc(`${BASE}/old`).get()).exists).toBe(false);
    expect((await tokenIndexRef(db, BASE, "old").get()).exists).toBe(false);
  });

  it("an API key keeps working across the change: a legacy key authenticates, and a new key is never named by its token", async () => {
    const db = getFirestore();
    const storer = buildApiKeyStorer();
    // A key made before the change: its index entry is named by the token.
    const { id, token } = await storer.create({ uid: "user-1" });
    const hashed = await tokenIndexRef(db, BASE, token).get();
    expect(hashed.exists).toBe(true);
    expect((await db.doc(`${BASE}/${token}`).get()).exists).toBe(false);
    await db.doc(`${BASE}/${token}`).set(hashed.data());
    await tokenIndexRef(db, BASE, token).delete();

    await expect(storer.findByToken(token)).resolves.toMatchObject({ id, uid: "user-1" });
    expect((await db.doc(`${BASE}/${token}`).get()).exists).toBe(false);

    await storer.removeById(id);
    await expect(storer.findByToken(token)).rejects.toThrow(/does not exist/);
  });
});
