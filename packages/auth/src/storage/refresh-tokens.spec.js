import { NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { cleanUpFirebase } from "../testing/firebase.js";
import { getFirestore } from "../firebase.js";
import { IDLE_TIMEOUT, buildRefreshTokenStorer } from "./refresh-tokens.js";

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
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
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

  const idOf = async token => (await getFirestore().doc(`refresh-tokens/-indexes-/token-to-id/${token}`).get()).get("id");
  const ago = ms => admin.firestore.Timestamp.fromMillis(Date.now() - ms);
  const DAY = 24 * 60 * 60 * 1000;

  it("should refuse a token past expiresAt before cleanup runs", async () => {
    const { token } = await storer.createRefreshToken({ uid: "abc123" });
    await getFirestore().doc(`refresh-tokens/${await idOf(token)}`).update({ expiresAt: ago(60 * 1000) });

    await expect(storer.getRefreshToken(token)).rejects.toThrow(NotFoundError);
  });

  it("should end a session idle for 14 days, and not record its use", async () => {
    const uid = "abc123";
    const db = getFirestore();
    const { token: idle } = await storer.createRefreshToken({ uid });
    const { token: active } = await storer.createRefreshToken({ uid });
    const idleId = await idOf(idle);
    const activeId = await idOf(active);
    await db.doc(`refresh-tokens/${idleId}`).update({ createdAt: ago(20 * DAY), lastUsedAt: ago(IDLE_TIMEOUT + 60 * 1000) });
    await db.doc(`refresh-tokens/${activeId}`).update({ createdAt: ago(20 * DAY), lastUsedAt: ago(13 * DAY) });

    await expect(storer.getRefreshToken(idle)).rejects.toThrow(NotFoundError);
    await expect(storer.getRefreshToken(active)).resolves.toHaveProperty("uid", uid);
    const idleUsed = (await db.doc(`refresh-tokens/${idleId}`).get()).get("lastUsedAt");
    expect(idleUsed.toMillis()).toBeLessThan(Date.now() - IDLE_TIMEOUT);

    const sessions = await storer.listSessions({ uid });
    expect(sessions.map(s => s.id)).toEqual([activeId]);
  });

  it("should count a session made before use was recorded as idle from its creation", async () => {
    const uid = "abc123";
    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 10 * DAY);
    await getFirestore().doc("refresh-tokens/old-idle").set({ uid, additionalClaims: {}, createdAt: ago(15 * DAY), expiresAt });
    await getFirestore().doc("refresh-tokens/old-recent").set({ uid, additionalClaims: {}, createdAt: ago(DAY), expiresAt });

    const sessions = await storer.listSessions({ uid });
    expect(sessions.map(s => s.id)).toEqual(["old-recent"]);
  });

  it("should clean idle sessions and keep old ones still in use", async () => {
    const uid = "abc123";
    const db = getFirestore();
    const { token: idle } = await storer.createRefreshToken({ uid });
    const { token: inUse } = await storer.createRefreshToken({ uid });
    const idleId = await idOf(idle);
    await db.doc(`refresh-tokens/${idleId}`).update({ createdAt: ago(20 * DAY), lastUsedAt: ago(15 * DAY) });
    await db.doc(`refresh-tokens/${await idOf(inUse)}`).update({ createdAt: ago(20 * DAY), lastUsedAt: ago(DAY) });
    await db.doc("refresh-tokens/old-idle").set({ uid, additionalClaims: {}, createdAt: ago(15 * DAY), expiresAt: ago(-10 * DAY) });

    await storer.cleanExpiredRefreshTokens();

    expect((await db.doc(`refresh-tokens/${idleId}`).get()).exists).toBe(false);
    expect((await db.doc(`refresh-tokens/${idleId}/private/key`).get()).exists).toBe(false);
    expect((await db.doc(`refresh-tokens/-indexes-/token-to-id/${idle}`).get()).exists).toBe(false);
    expect((await db.doc("refresh-tokens/old-idle").get()).exists).toBe(false);
    await expect(storer.getRefreshToken(inUse)).resolves.toHaveProperty("uid", uid);
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

    // Deleting someone else's session looks the same as a missing one
    const otherUid = "other456";
    await expect(storer.deleteSession({ uid: otherUid, id: id2 })).rejects.toThrow(NotFoundError);
    sessions = await storer.listSessions({ uid });
    expect(sessions).toHaveLength(2);

    // Delete all sessions for uid
    await storer.deleteAllSessions({ uid });
    sessions = await storer.listSessions({ uid });
    expect(sessions).toHaveLength(0);
  });

  it("should record session metadata and list it with ISO timestamps", async () => {
    const uid = "abc123";
    const db = getFirestore();
    const longAgent = "Mozilla/5.0 " + "x".repeat(1000);
    const { token: wallet } = await storer.createRefreshToken({ uid, meta: { method: "wallet", userAgent: longAgent } });
    const { token: bogus } = await storer.createRefreshToken({ uid, meta: { method: "sorcery", userAgent: 42 } });
    const walletId = (await db.doc(`refresh-tokens/-indexes-/token-to-id/${wallet}`).get()).get("id");
    const bogusId = (await db.doc(`refresh-tokens/-indexes-/token-to-id/${bogus}`).get()).get("id");

    const sessions = await storer.listSessions({ uid, currentToken: wallet });
    const w = sessions.find(s => s.id === walletId);
    expect(w).toMatchObject({ method: "wallet", current: true });
    expect(w.userAgent).toHaveLength(512);
    for (const field of ["createdAt", "expiresAt", "lastUsedAt"]) {
      expect(new Date(w[field]).toISOString()).toBe(w[field]);
    }
    expect(sessions.find(s => s.id === bogusId)).toMatchObject({ method: null, userAgent: null, current: false });
  });

  it("should list a session made before metadata was recorded", async () => {
    const uid = "abc123";
    const db = getFirestore();
    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 60000);
    const createdAt = admin.firestore.Timestamp.fromMillis(Date.now() - 60000);
    await db.doc("refresh-tokens/old-google").set({ uid, additionalClaims: { oauth: true, oauthProvider: "google" }, createdAt, expiresAt });
    await db.doc("refresh-tokens/old-wallet").set({ uid, additionalClaims: {}, createdAt, expiresAt });

    const sessions = await storer.listSessions({ uid, currentToken: "not-a-token" });
    expect(sessions.find(s => s.id === "old-google")).toMatchObject({ method: "google", userAgent: null, lastUsedAt: null, current: false });
    expect(sessions.find(s => s.id === "old-wallet")).toMatchObject({ method: null, createdAt: createdAt.toDate().toISOString() });
  });

  it("should record use on read, at most once an hour, and sort by last use", async () => {
    const uid = "abc123";
    const db = getFirestore();
    const { token: older } = await storer.createRefreshToken({ uid });
    const { token: newer } = await storer.createRefreshToken({ uid });
    const olderId = (await db.doc(`refresh-tokens/-indexes-/token-to-id/${older}`).get()).get("id");
    const newerId = (await db.doc(`refresh-tokens/-indexes-/token-to-id/${newer}`).get()).get("id");
    const twoHoursAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 2 * 60 * 60 * 1000);
    const tenMinutesAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 10 * 60 * 1000);
    await db.doc(`refresh-tokens/${olderId}`).update({ lastUsedAt: twoHoursAgo });
    await db.doc(`refresh-tokens/${newerId}`).update({ lastUsedAt: tenMinutesAgo });

    await storer.getRefreshToken(older);
    await storer.getRefreshToken(newer);

    const olderUsed = (await db.doc(`refresh-tokens/${olderId}`).get()).get("lastUsedAt");
    expect(olderUsed.toMillis()).toBeGreaterThan(Date.now() - 60000);
    const newerUsed = (await db.doc(`refresh-tokens/${newerId}`).get()).get("lastUsedAt");
    expect(newerUsed.toMillis()).toBe(tenMinutesAgo.toMillis());

    const sessions = await storer.listSessions({ uid });
    expect(sessions.map(s => s.id)).toEqual([olderId, newerId]);
  });

  it("should clean more expired tokens than fit in one batch", async () => {
    const uid = "abc123";
    const db = getFirestore();
    const count = 200;
    const tokens = [];
    for (let i = 0; i < count; i++) {
      const { token } = await storer.createRefreshToken({ uid });
      tokens.push(token);
    }
    const pastTime = admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
    const snapshot = await db.collection("refresh-tokens").where("uid", "==", uid).get();
    expect(snapshot.size).toBe(count);
    const writer = db.bulkWriter();
    snapshot.docs.forEach(doc => writer.update(doc.ref, { expiresAt: pastTime }));
    await writer.close();

    await storer.cleanExpiredRefreshTokens();

    const remaining = await db.collection("refresh-tokens").where("uid", "==", uid).get();
    expect(remaining.size).toBe(0);
    await expect(storer.getRefreshToken(tokens[0])).rejects.toThrow(NotFoundError);
    await expect(storer.getRefreshToken(tokens[count - 1])).rejects.toThrow(NotFoundError);
  }, 60000);

  it("should delete all sessions except the given token", async () => {
    const uid = "abc123";
    const { token: keep } = await storer.createRefreshToken({ uid });
    await storer.createRefreshToken({ uid });
    await storer.createRefreshToken({ uid });
    const { token: other } = await storer.createRefreshToken({ uid: "other456" });

    await storer.deleteAllSessions({ uid, exceptToken: keep });

    const sessions = await storer.listSessions({ uid });
    expect(sessions).toHaveLength(1);
    await expect(storer.getRefreshToken(keep)).resolves.toHaveProperty("uid", uid);
    await expect(storer.getRefreshToken(other)).resolves.toHaveProperty("uid", "other456");
  });

  it("should not spare another user's session named as exceptToken", async () => {
    const uid = "abc123";
    await storer.createRefreshToken({ uid });
    const { token: foreign } = await storer.createRefreshToken({ uid: "other456" });

    await storer.deleteAllSessions({ uid, exceptToken: foreign });

    expect(await storer.listSessions({ uid })).toHaveLength(0);
    expect(await storer.listSessions({ uid: "other456" })).toHaveLength(1);
  });
});
