import { NotFoundError } from "@graffiticode/common/src/errors.js";
import admin from "firebase-admin";
import { getFirestore } from "../../firebase.js";
import { generateNonce } from "../../utils.js";

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

const buildCreateRefreshToken = ({ db }) => async ({ uid }) => {
  const refreshToken = await generateNonce(64);
  await db.collection("refreshTokens").add({
    refreshToken,
    uid,
    count: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return refreshToken;
};

const buildGetRefreshToken = ({ db }) => async (refreshToken) => {
  const querySnapshot = await db.collection("refreshTokens")
    .where("refreshToken", "==", refreshToken)
    .where("createdAt", ">", admin.firestore.Timestamp.fromMillis(Date.now() - THIRTY_DAYS))
    .get();
  if (querySnapshot.empty) {
    throw new NotFoundError(`${refreshToken} does not exist`);
  }
  if (querySnapshot.size > 1) {
    console.warn(`Trying to get multiple refresh tokens for ${refreshToken}`);
  }
  const { uid } = querySnapshot.docs[0].data();
  return { uid };
};

const buildDeleteRefreshToken = ({ db }) => async (refreshToken) => {
  const querySnapshot = await db.collection("refreshTokens")
    .where("refreshToken", "==", refreshToken)
    .where("createdAt", ">", admin.firestore.Timestamp.fromMillis(Date.now() - THIRTY_DAYS))
    .get();
  if (querySnapshot.size > 1) {
    console.warn(`Trying to delete multiple refresh tokens for ${refreshToken}`);
  }
  await Promise.all(querySnapshot.docs.map(documentSnapshot => documentSnapshot.ref.delete()));
};

export const buildFirestoreTokenStorer = () => {
  const db = getFirestore();
  const createRefreshToken = buildCreateRefreshToken({ db });
  const deleteRefreshToken = buildDeleteRefreshToken({ db });
  const getRefreshToken = buildGetRefreshToken({ db });
  return { createRefreshToken, deleteRefreshToken, getRefreshToken };
};
