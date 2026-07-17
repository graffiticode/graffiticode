import { NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { cleanUpFirebase } from "../testing/firebase.js";
import { getFirestore } from "../firebase.js";
import { buildRefreshTokenStorer } from "./refresh-tokens.js";

describe("storage/refresh-tokens", () => {
  let storer;
  beforeEach(async () => {
    storer = buildRefreshTokenStorer();
  });

  afterEach(cleanUpFirebase);

  it("should throw NotFoundError if refresh token does not exist", async () => {
    await expect(storer.getRefreshToken("abc123")).rejects.toThrow(NotFoundError);
  });

  it("should create refresh token that can retrieve data", async () => {
    const uid = "abc123";
    const { token } = await storer.createRefreshToken({ uid });

    const data = await storer.getRefreshToken(token);

    expect(data).toHaveProperty("uid", uid);
  });

  it("should throw NotFoundError for delete refresh token", async () => {
    const uid = "abc123";
    const { token } = await storer.createRefreshToken({ uid });
    await storer.deleteRefreshToken(token);

    await expect(storer.getRefreshToken(token)).rejects.toThrow(NotFoundError);
  });

  it("should delete a non-existing refresh token", async () => {
    await expect(storer.deleteRefreshToken("does-not-exist")).resolves.toBe();
  });

  it("should create refresh token that can retrieve additional claims data", async () => {
    const uid = "abc123";
    const { token } = await storer.createRefreshToken({ uid, additionalClaims: { apiKey: true } });

    const data = await storer.getRefreshToken(token);

    expect(data).toHaveProperty("uid", uid);
    expect(data).toHaveProperty("additionalClaims.apiKey", true);
  });

  it("should clean expired refresh tokens", async () => {
    const uid = "abc123";
    const db = getFirestore();

    // Create two refresh tokens
    const { token: activeToken } = await storer.createRefreshToken({ uid });
    const { token: expiredToken } = await storer.createRefreshToken({ uid });

    // Look up the expired token's ID to modify its expiresAt
    const tokenToIdRef = db.doc(`refresh-tokens/-indexes-/token-to-id/${expiredToken}`);
    const tokenToIdDoc = await tokenToIdRef.get();
    const expiredId = tokenToIdDoc.get("id");

    // Set expiresAt to 1 hour ago
    const pastTime = admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
    await db.doc(`refresh-tokens/${expiredId}`).update({ expiresAt: pastTime });

    // Clean expired refresh tokens
    await storer.cleanExpiredRefreshTokens();

    // The active one should still exist
    const activeData = await storer.getRefreshToken(activeToken);
    expect(activeData).toHaveProperty("uid", uid);

    // The expired one should be deleted
    await expect(storer.getRefreshToken(expiredToken)).rejects.toThrow(NotFoundError);

    // Ensure all references for the expired one are deleted
    const mainDoc = await db.doc(`refresh-tokens/${expiredId}`).get();
    const privateKeyDoc = await db.doc(`refresh-tokens/${expiredId}/private/key`).get();
    const indexDoc = await db.doc(`refresh-tokens/-indexes-/token-to-id/${expiredToken}`).get();

    expect(mainDoc.exists).toBe(false);
    expect(privateKeyDoc.exists).toBe(false);
    expect(indexDoc.exists).toBe(false);
  });

  it("should list active sessions, delete a session, and delete all sessions", async () => {
    const uid = "abc123";
    const db = getFirestore();

    // Create 3 sessions
    const { token: t1 } = await storer.createRefreshToken({ uid, additionalClaims: { session: 1 } });
    const { token: t2 } = await storer.createRefreshToken({ uid, additionalClaims: { session: 2 } });
    const { token: t3 } = await storer.createRefreshToken({ uid, additionalClaims: { session: 3 } });

    // Get the IDs
    const id1 = (await db.doc(`refresh-tokens/-indexes-/token-to-id/${t1}`).get()).get("id");
    const id2 = (await db.doc(`refresh-tokens/-indexes-/token-to-id/${t2}`).get()).get("id");
    const id3 = (await db.doc(`refresh-tokens/-indexes-/token-to-id/${t3}`).get()).get("id");

    // List sessions
    let sessions = await storer.listSessions({ uid });
    expect(sessions).toHaveLength(3);
    expect(sessions.map(s => s.id).sort()).toEqual([id1, id2, id3].sort());

    // Delete one session (id1)
    await storer.deleteSession({ uid, id: id1 });

    // Verify list session has 2 remaining
    sessions = await storer.listSessions({ uid });
    expect(sessions).toHaveLength(2);
    expect(sessions.map(s => s.id).sort()).toEqual([id2, id3].sort());

    // Verify deleting it again throws NotFoundError or similar
    await expect(storer.deleteSession({ uid, id: id1 })).rejects.toThrow(NotFoundError);

    // Try deleting someone else's session
    const otherUid = "other456";
    await expect(storer.deleteSession({ uid: otherUid, id: id2 })).rejects.toThrow();

    // Delete all sessions for uid
    await storer.deleteAllSessions({ uid });
    sessions = await storer.listSessions({ uid });
    expect(sessions).toHaveLength(0);
  });
});
