import { NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { v4 } from "uuid";
import { getFirestore } from "../firebase.js";
import { generateNonce } from "../utils.js";

const buildCreateApiKey = ({ db }) => async ({ uid }) => {
  const id = v4();
  const token = await generateNonce(64);

  const batchWriter = db.batch();

  const apiKeyPrivateRef = db.doc(`api-keys-private/${id}`);
  batchWriter.create(apiKeyPrivateRef, { token });

  const apiKeyRef = db.doc(`api-keys/${id}`);
  batchWriter.create(apiKeyRef, {
    uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batchWriter.commit();

  return { uid, token };
};

const buildGetApiKey = ({ db }) => async (apiKey) => {
  const querySnapshot = await db.collection("api-keys-private")
    .where("token", "==", apiKey)
    .get();
  if (querySnapshot.empty) {
    throw new NotFoundError("api-key does not exist");
  }
  if (querySnapshot.size > 1) {
    console.warn("Trying to get multiple api-keys");
  }
  const apiKeyPrivateDoc = querySnapshot.docs[0];
  const apiKeyRef = db.doc(`api-keys/${apiKeyPrivateDoc.id}`);
  const apiKeyDoc = await apiKeyRef.get();
  const { uid } = apiKeyDoc.data();
  return { uid };
};

const buildDeleteApiKey = ({ db }) => async (apiKey) => {
  const querySnapshot = await db.collection("api-keys-private")
    .where("token", "==", apiKey)
    .get();
  if (querySnapshot.size > 1) {
    console.warn("Trying to delete multiple api-keys");
  }

  const batchWriter = db.batch();
  querySnapshot.docs.forEach(documentSnapshot => {
    batchWriter.delete(documentSnapshot.ref);
    batchWriter.delete(db.doc(`api-keys/${documentSnapshot.id}`));
  });
  await batchWriter.commit();
};

export const buildApiKeyStorer = () => {
  const db = getFirestore();
  const createApiKey = buildCreateApiKey({ db });
  const deleteApiKey = buildDeleteApiKey({ db });
  const getApiKey = buildGetApiKey({ db });
  return { createApiKey, deleteApiKey, getApiKey };
};
