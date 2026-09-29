import { NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { v4 } from "uuid";
import { getFirestore } from "../firebase.js";
import { generateNonce } from "../utils.js";

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

const buildCreateRefreshToken = ({ db }) => async ({ uid, additionalClaims = {} }) => {
  const id = v4();
  const token = await generateNonce(64);
  const createdAt = admin.firestore.FieldValue.serverTimestamp();
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + THIRTY_DAYS);

  const batchWriter = db.batch();

  const refreshTokenRef = db.doc(`refresh-tokens/${id}`);
  batchWriter.create(refreshTokenRef, { uid, additionalClaims, createdAt, expiresAt });

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
  const { uid, additionalClaims, expiresAt } = refreshTokenDoc.data();
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

const buildListSessions = ({ db }) => async ({ uid }) => {
  const now = admin.firestore.Timestamp.now();
  const sessionsSnapshot = await db.collection("refresh-tokens")
    .where("uid", "==", uid)
    .where("expiresAt", ">", now)
    .get();

  return sessionsSnapshot.docs.map(doc => {
    const data = doc.data();
    return {
      id: doc.id,
      createdAt: data.createdAt,
      expiresAt: data.expiresAt,
      additionalClaims: data.additionalClaims,
    };
  });
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
