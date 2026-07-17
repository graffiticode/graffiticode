import { NotFoundError, UnauthorizedError } from "@graffiticode/common/errors";
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

const cleanExpiredRefreshTokens = ({ db }) => async () => {
  const now = admin.firestore.Timestamp.now();
  const expiredDocs = await db.collection("refresh-tokens")
    .where("expiresAt", "<", now)
    .get();

  if (expiredDocs.empty) {
    return;
  }

  const batch = db.batch();
  await Promise.all(expiredDocs.docs.map(async (doc) => {
    const id = doc.id;
    const privateKeyRef = db.doc(`refresh-tokens/${id}/private/key`);
    const privateKeyDoc = await privateKeyRef.get();
    if (privateKeyDoc.exists) {
      const token = privateKeyDoc.get("token");
      if (token) {
        const tokenToIdRef = db.doc(`refresh-tokens/-indexes-/token-to-id/${token}`);
        batch.delete(tokenToIdRef);
      }
    }
    batch.delete(privateKeyRef);
    batch.delete(doc.ref);
  }));

  await batch.commit();
};

const listSessions = ({ db }) => async ({ uid }) => {
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

const deleteSession = ({ db }) => async ({ uid, id }) => {
  const sessionRef = db.doc(`refresh-tokens/${id}`);
  const sessionDoc = await sessionRef.get();
  if (!sessionDoc.exists) {
    throw new NotFoundError("Session not found");
  }
  if (sessionDoc.get("uid") !== uid) {
    throw new UnauthorizedError("Unauthorized to delete session");
  }

  const privateKeyRef = db.doc(`refresh-tokens/${id}/private/key`);
  const privateKeyDoc = await privateKeyRef.get();
  const batch = db.batch();
  if (privateKeyDoc.exists) {
    const token = privateKeyDoc.get("token");
    if (token) {
      const tokenToIdRef = db.doc(`refresh-tokens/-indexes-/token-to-id/${token}`);
      batch.delete(tokenToIdRef);
    }
  }
  batch.delete(privateKeyRef);
  batch.delete(sessionRef);
  await batch.commit();
};

const deleteAllSessions = ({ db }) => async ({ uid, exceptTokenId }) => {
  const sessionsSnapshot = await db.collection("refresh-tokens")
    .where("uid", "==", uid)
    .get();

  if (sessionsSnapshot.empty) {
    return;
  }

  const batch = db.batch();
  await Promise.all(sessionsSnapshot.docs.map(async (doc) => {
    const id = doc.id;
    if (exceptTokenId && id === exceptTokenId) {
      return;
    }
    const privateKeyRef = db.doc(`refresh-tokens/${id}/private/key`);
    const privateKeyDoc = await privateKeyRef.get();
    if (privateKeyDoc.exists) {
      const token = privateKeyDoc.get("token");
      if (token) {
        const tokenToIdRef = db.doc(`refresh-tokens/-indexes-/token-to-id/${token}`);
        batch.delete(tokenToIdRef);
      }
    }
    batch.delete(privateKeyRef);
    batch.delete(doc.ref);
  }));

  await batch.commit();
};

export const buildRefreshTokenStorer = () => {
  const db = getFirestore();
  const createRefreshToken = buildCreateRefreshToken({ db });
  const deleteRefreshToken = buildDeleteRefreshToken({ db });
  const getRefreshToken = buildGetRefreshToken({ db });
  return {
    createRefreshToken,
    deleteRefreshToken,
    getRefreshToken,
    cleanExpiredRefreshTokens: cleanExpiredRefreshTokens({ db }),
    listSessions: listSessions({ db }),
    deleteSession: deleteSession({ db }),
    deleteAllSessions: deleteAllSessions({ db }),
  };
};
