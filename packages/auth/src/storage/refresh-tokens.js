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

export const buildRefreshTokenStorer = () => {
  const db = getFirestore();
  const createRefreshToken = buildCreateRefreshToken({ db });
  const deleteRefreshToken = buildDeleteRefreshToken({ db });
  const getRefreshToken = buildGetRefreshToken({ db });
  return { createRefreshToken, deleteRefreshToken, getRefreshToken };
};
