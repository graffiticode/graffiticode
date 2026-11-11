import { InvalidArgumentError, NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { v4 } from "uuid";
import { getFirestore } from "../firebase.js";
import { generateNonce } from "../utils.js";
import { deleteTokenIndex, readTokenIndex, tokenIndexRef } from "./token-index.js";

const INDEX = "api-keys/-indexes-/token-to-id";

const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const buildCreate = () => async ({ uid }) => {
  const db = getFirestore();
  const id = v4();
  const token = await generateNonce(64);
  const createdAt = FieldValue.serverTimestamp();

  const batchWriter = db.batch();

  const apiKeyRef = db.doc(`api-keys/${id}`);
  batchWriter.create(apiKeyRef, { uid, createdAt });

  const apiKeyPrivateRef = db.doc(`api-keys/${id}/private/key`);
  batchWriter.create(apiKeyPrivateRef, { token });

  batchWriter.create(tokenIndexRef(db, INDEX, token), { id });

  await batchWriter.commit();

  return { id, uid, token };
};

const buildRemoveById = () => async (id) => {
  const db = getFirestore();
  const apiKeyRef = db.doc(`api-keys/${id}`);
  const apiKeyPrivateRef = db.doc(`api-keys/${id}/private/key`);
  await db.runTransaction(async t => {
    const apiKeyPrivateDoc = await t.get(apiKeyPrivateRef);
    const token = apiKeyPrivateDoc.get("token");
    if (token) deleteTokenIndex(t, db, INDEX, token);
    t.delete(apiKeyPrivateRef)
      .delete(apiKeyRef);
  });
};

const buildFindByToken = () => async (token) => {
  const db = getFirestore();
  const index = await readTokenIndex(db, INDEX, token);
  if (!index) {
    throw new NotFoundError("api-key does not exist");
  }

  const id = index.id;
  const apiKeyRef = db.doc(`api-keys/${id}`);
  const apiKeyDoc = await apiKeyRef.get();
  const { uid, createdAt } = apiKeyDoc.data();
  return { id, uid, createdAt };
};

const buildFindById = () => async (id) => {
  const db = getFirestore();
  const apiKeyRef = db.doc(`api-keys/${id}`);
  const apiKeyDoc = await apiKeyRef.get();
  if (!apiKeyDoc.exists) {
    throw new NotFoundError();
  }
  const { uid, createdAt } = apiKeyDoc.data();
  return { id, uid, createdAt };
};

const buildList = () => async ({ uid, limit, createdAfterMillis }) => {
  const db = getFirestore();
  if (!Number.isInteger(limit)) {
    limit = 100;
  } else if (limit < 5) {
    limit = 5;
  }

  let query = db.collection("api-keys")
    .where("uid", "==", uid)
    .orderBy("createdAt")
    .limit(limit);
  if (Number.isInteger(createdAfterMillis)) {
    if (createdAfterMillis < 0) {
      throw new InvalidArgumentError("must provide positive createdAfterMillis");
    }
    query = query.startAfter(Timestamp.fromMillis(createdAfterMillis));
  }
  const apiKeysSnap = await query.get();

  const apiKeys = apiKeysSnap.docs.map(apiKeySnap => ({
    id: apiKeySnap.id,
    uid: apiKeySnap.get("uid"),
    createdAt: apiKeySnap.get("createdAt"),
  }));

  return apiKeys;
};

export const buildApiKeyStorer = () => {
  const create = buildCreate();
  const removeById = buildRemoveById();
  const findById = buildFindById();
  const findByToken = buildFindByToken();
  const list = buildList();
  return { create, removeById, findById, findByToken, list };
};
