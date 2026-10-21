import { NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { v4 } from "uuid";
import { getFirestore } from "../firebase.js";
import { generateNonce } from "../utils.js";

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
// lastUsedAt is rewritten at most this often, so a busy session costs one write an hour.
const LAST_USED_RESOLUTION = 60 * 60 * 1000;
const MAX_USER_AGENT_LENGTH = 512;
export const SESSION_METHODS = ["wallet", "email", "google"];

// What the sessions page shows about a session: how it signed in, and from which browser.
/** @param {{ method?: string, userAgent?: unknown }} [meta] */
const sessionMeta = ({ method, userAgent } = {}) => ({
  method: SESSION_METHODS.includes(method) ? method : null,
  userAgent: typeof userAgent === "string" && userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
});

const buildCreateRefreshToken = ({ db }) => async ({ uid, additionalClaims = {}, meta = {} }) => {
  const id = v4();
  const token = await generateNonce(64);
  const createdAt = admin.firestore.FieldValue.serverTimestamp();
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + THIRTY_DAYS);

  const batchWriter = db.batch();

  const refreshTokenRef = db.doc(`refresh-tokens/${id}`);
  batchWriter.create(refreshTokenRef, { uid, additionalClaims, createdAt, expiresAt, lastUsedAt: createdAt, ...sessionMeta(meta) });

  const refreshTokenPrivateRef = db.doc(`refresh-tokens/${id}/private/key`);
  batchWriter.create(refreshTokenPrivateRef, { token });

  const tokenToIdRef = db.doc(`refresh-tokens/-indexes-/token-to-id/${token}`);
  batchWriter.create(tokenToIdRef, { id });

  await batchWriter.commit();

  return { uid, additionalClaims, token };
};

const buildGetRefreshToken = ({ db }) => async (token) => {
  const tokenToIdRef = db.doc(`refresh-tokens/-indexes-/token-to-id/${token}`);
  const tokenToIdDoc = await tokenToIdRef.get();
  if (!tokenToIdDoc.exists) {
    throw new NotFoundError("token does not exist");
  }

  const id = tokenToIdDoc.get("id");
  const refreshTokenRef = db.doc(`refresh-tokens/${id}`);
  const refreshTokenDoc = await refreshTokenRef.get();
  const { uid, additionalClaims, expiresAt, lastUsedAt } = refreshTokenDoc.data();
  // Every exchange reads the token, so this is where its last use is recorded. Throttled, and
  // a failed write is only logged: recording use never fails the exchange.
  if (!lastUsedAt || Date.now() - lastUsedAt.toMillis() > LAST_USED_RESOLUTION) {
    await refreshTokenRef.update({ lastUsedAt: admin.firestore.FieldValue.serverTimestamp() })
      .catch(err => console.warn(`Failed to record refresh token use: ${err.message}`));
  }
  return { uid, additionalClaims, expiresAt };
};

const buildDeleteRefreshToken = ({ db }) => async (token) => {
  const db = getFirestore();
  const tokenToIdRef = db.doc(`refresh-tokens/-indexes-/token-to-id/${token}`);
  const tokenToIdDoc = await tokenToIdRef.get();
  if (!tokenToIdDoc.exists) {
    return;
  }

  const id = tokenToIdDoc.get("id");
  const refreshTokenRef = db.doc(`refresh-tokens/${id}`);
  const refreshTokenPrivateRef = db.doc(`refresh-tokens/${id}/private/key`);

  await db.batch()
    .delete(tokenToIdRef)
    .delete(refreshTokenPrivateRef)
    .delete(refreshTokenRef)
    .commit();
};

// Each token owns three docs (main, private key, index); stay under the
// 500-write batch limit.
const DELETE_CHUNK_SIZE = 150;

const deleteTokensById = async ({ db, ids }) => {
  for (let i = 0; i < ids.length; i += DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + DELETE_CHUNK_SIZE);
    const privateKeyDocs = await Promise.all(
      chunk.map(id => db.doc(`refresh-tokens/${id}/private/key`).get())
    );
    const batch = db.batch();
    chunk.forEach((id, index) => {
      const token = privateKeyDocs[index].get("token");
      if (token) {
        batch.delete(db.doc(`refresh-tokens/-indexes-/token-to-id/${token}`));
      }
      batch.delete(db.doc(`refresh-tokens/${id}/private/key`));
      batch.delete(db.doc(`refresh-tokens/${id}`));
    });
    await batch.commit();
  }
};

const buildCleanExpiredRefreshTokens = ({ db }) => async () => {
  const now = admin.firestore.Timestamp.now();
  const expiredDocs = await db.collection("refresh-tokens")
    .where("expiresAt", "<", now)
    .get();
  await deleteTokensById({ db, ids: expiredDocs.docs.map(doc => doc.id) });
};

const toIso = ts => (ts && typeof ts.toDate === "function" ? ts.toDate().toISOString() : null);

// Active sessions, most recently used first. `currentToken` (the caller's own refresh token)
// marks its row `current`. Sessions made before metadata was recorded have null method,
// userAgent and lastUsedAt, except that a Google sign-in is known from its claims.
const buildListSessions = ({ db }) => async ({ uid, currentToken }) => {
  const now = admin.firestore.Timestamp.now();
  const [sessionsSnapshot, currentIndex] = await Promise.all([
    db.collection("refresh-tokens")
      .where("uid", "==", uid)
      .where("expiresAt", ">", now)
      .get(),
    currentToken ? db.doc(`refresh-tokens/-indexes-/token-to-id/${currentToken}`).get() : null,
  ]);
  const currentId = currentIndex?.exists ? currentIndex.get("id") : null;

  const sessions = sessionsSnapshot.docs.map(doc => {
    const data = doc.data();
    const method = data.method ?? (data.additionalClaims?.oauthProvider === "google" ? "google" : null);
    return {
      id: doc.id,
      createdAt: toIso(data.createdAt),
      expiresAt: toIso(data.expiresAt),
      lastUsedAt: toIso(data.lastUsedAt),
      method,
      userAgent: data.userAgent ?? null,
      additionalClaims: data.additionalClaims,
      current: doc.id === currentId,
    };
  });
  const recency = s => s.lastUsedAt ?? s.createdAt ?? "";
  return sessions.sort((a, b) => recency(b).localeCompare(recency(a)));
};

const buildDeleteSession = ({ db }) => async ({ uid, id }) => {
  const sessionDoc = await db.doc(`refresh-tokens/${id}`).get();
  // Another user's session is reported as missing so ids can't be probed.
  if (!sessionDoc.exists || sessionDoc.get("uid") !== uid) {
    throw new NotFoundError("session does not exist");
  }
  await deleteTokensById({ db, ids: [id] });
};

const buildDeleteAllSessions = ({ db }) => async ({ uid, exceptToken }) => {
  let exceptId = null;
  if (exceptToken) {
    const tokenToIdDoc = await db.doc(`refresh-tokens/-indexes-/token-to-id/${exceptToken}`).get();
    if (tokenToIdDoc.exists) {
      exceptId = tokenToIdDoc.get("id");
    }
  }
  const sessionsSnapshot = await db.collection("refresh-tokens")
    .where("uid", "==", uid)
    .get();
  const ids = sessionsSnapshot.docs
    .map(doc => doc.id)
    .filter(id => id !== exceptId);
  await deleteTokensById({ db, ids });
};

export const buildRefreshTokenStorer = () => {
  const db = getFirestore();
  const createRefreshToken = buildCreateRefreshToken({ db });
  const deleteRefreshToken = buildDeleteRefreshToken({ db });
  const getRefreshToken = buildGetRefreshToken({ db });
  const cleanExpiredRefreshTokens = buildCleanExpiredRefreshTokens({ db });
  const listSessions = buildListSessions({ db });
  const deleteSession = buildDeleteSession({ db });
  const deleteAllSessions = buildDeleteAllSessions({ db });
  return {
    createRefreshToken,
    deleteRefreshToken,
    getRefreshToken,
    cleanExpiredRefreshTokens,
    listSessions,
    deleteSession,
    deleteAllSessions,
  };
};
