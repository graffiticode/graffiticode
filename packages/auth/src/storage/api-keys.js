import { NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { getFirestore } from "../firebase.js";
import { generateNonce } from "../utils.js";

const buildCreateApiKey = ({ db }) => async ({ uid }) => {
  const apiKey = await generateNonce(64);
  await db.collection("api-keys").add({
    apiKey,
    uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return apiKey;
};

const buildGetApiKey = ({ db }) => async (apiKey) => {
  const querySnapshot = await db.collection("api-keys")
    .where("apiKey", "==", apiKey)
    .get();
  if (querySnapshot.empty) {
    throw new NotFoundError(`${apiKey} does not exist`);
  }
  if (querySnapshot.size > 1) {
    console.warn(`Trying to get multiple api-keys for ${apiKey}`);
  }
  const { uid } = querySnapshot.docs[0].data();
  return { uid };
};

const buildDeleteApiKey = ({ db }) => async (apiKey) => {
  const querySnapshot = await db.collection("api-keys")
    .where("apiKey", "==", apiKey)
    .get();
  if (querySnapshot.size > 1) {
    console.warn(`Trying to delete multiple api-keys for ${apiKey}`);
  }
  await Promise.all(querySnapshot.docs.map(documentSnapshot => documentSnapshot.ref.delete()));
};

export const buildApiKeyStorer = () => {
  const db = getFirestore();
  const createApiKey = buildCreateApiKey({ db });
  const deleteApiKey = buildDeleteApiKey({ db });
  const getApiKey = buildGetApiKey({ db });
  return { createApiKey, deleteApiKey, getApiKey };
};
