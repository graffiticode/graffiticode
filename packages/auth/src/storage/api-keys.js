import { NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { v4 } from "uuid";
import { getFirestore } from "../firebase.js";
import { generateNonce } from "../utils.js";

const buildCreate = ({ db }) => async ({ uid }) => {
  const id = v4();
  const token = await generateNonce(64);
  const createdAt = admin.firestore.FieldValue.serverTimestamp();

  const batchWriter = db.batch();

  const apiKeyPrivateRef = db.doc(`api-keys-private/${id}`);
  batchWriter.create(apiKeyPrivateRef, { token });

  const apiKeyRef = db.doc(`api-keys/${id}`);
  batchWriter.create(apiKeyRef, { uid, createdAt });

  await batchWriter.commit();

  return { id, uid, token };
};

const buildFindByToken = ({ db }) => async (token) => {
  const querySnapshot = await db.collection("api-keys-private")
    .where("token", "==", token)
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

const buildFindById = ({ db }) => async (id) => {
  const apiKeyRef = db.doc(`api-keys/${id}`);
  const apiKeyDoc = await apiKeyRef.get();
  if (!apiKeyDoc.exists) {
    throw new NotFoundError();
  }
  const { uid, createdAt } = apiKeyDoc.data();
  return { uid, createdAt };
};

const buildRemoveById = ({ db }) => async (id) => {
  const batchWriter = db.batch();
  batchWriter.delete(db.doc(`api-keys/${id}`));
  batchWriter.delete(db.doc(`api-keys-private/${id}`));
  await batchWriter.commit();
};

export const buildApiKeyStorer = () => {
  const db = getFirestore();
  const create = buildCreate({ db });
  const findById = buildFindById({ db });
  const findByToken = buildFindByToken({ db });
  const removeById = buildRemoveById({ db });
  return { create, findById, findByToken, removeById };
};
