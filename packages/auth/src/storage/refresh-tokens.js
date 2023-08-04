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

  await batchWriter.commit();

  return { uid, additionalClaims, token };
};

const buildGetRefreshToken = ({ db }) => async (token) => {
  const querySnapshot = await db.collectionGroup("private")
    .where("token", "==", token)
    .get();
  if (querySnapshot.empty) {
    throw new NotFoundError("token does not exist");
  }
  if (querySnapshot.size > 1) {
    console.warn("Trying to get multiple refresh tokens");
  }
  const refreshTokenPrivateDoc = querySnapshot.docs[0];
  if (refreshTokenPrivateDoc.ref.parent.parent === null) {
    throw new Error("Refresh Token private doc is not in a sub collection");
  }
  if (refreshTokenPrivateDoc.ref.parent.parent.parent.id !== "refresh-tokens") {
    throw new Error("Refresh Token private doc is not in the refresh-tokens collection");
  }

  const refreshTokenRef = refreshTokenPrivateDoc.ref.parent.parent;
  const refreshTokenDoc = await refreshTokenRef.get();
  const { uid, additionalClaims, expiresAt } = refreshTokenDoc.data();
  return { uid, additionalClaims, expiresAt };
};

const buildDeleteRefreshToken = ({ db }) => async (token) => {
  const querySnapshot = await db.collectionGroup("private")
    .where("token", "==", token)
    .get();
  if (querySnapshot.size > 1) {
    console.warn("Trying to delete multiple refresh tokens");
  }

  const batchWriter = db.batch();
  querySnapshot.docs.forEach(documentSnapshot => {
    batchWriter.delete(documentSnapshot.ref);
    batchWriter.delete(db.doc(`refresh-tokens/${documentSnapshot.ref.parent.parent}`));
  });
  await batchWriter.commit();
};

export const buildRefreshTokenStorer = () => {
  const db = getFirestore();
  const createRefreshToken = buildCreateRefreshToken({ db });
  const deleteRefreshToken = buildDeleteRefreshToken({ db });
  const getRefreshToken = buildGetRefreshToken({ db });
  return { createRefreshToken, deleteRefreshToken, getRefreshToken };
};
