import { InvalidArgumentError, NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { v4 } from "uuid";
import { getFirestore } from "../firebase.js";
import { generateNonce } from "../utils.js";

const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const buildCreate = ({ db }) => async ({ uid }) => {
  const id = v4();
  const token = await generateNonce(64);
  const createdAt = FieldValue.serverTimestamp();

  const db = getFirestore();
  const batchWriter = db.batch();

  const apiKeyRef = db.doc(`api-keys/${id}`);
  batchWriter.create(apiKeyRef, { uid, createdAt });

  const apiKeyPrivateRef = db.doc(`api-keys/${id}/private/key`);
  batchWriter.create(apiKeyPrivateRef, { token });

  await batchWriter.commit();

  return { id, uid, token };
};

const buildRemoveById = ({ db }) => async (id) => {
  const batchWriter = db.batch();
  batchWriter.delete(db.doc(`api-keys/${id}`));
  batchWriter.delete(db.doc(`api-keys/${id}/private/key`));
  await batchWriter.commit();
};

const buildFindByToken = ({ db }) => async (token) => {
  try {
    console.log("buildFindByToken() token=" + token);
    const querySnapshot = await db.collectionGroup("private")
          .where("token", "==", token)
          .get();
    console.log("buildFindByToken() querySnapshot=" + JSON.stringify(querySnapshot, null, 2));
    if (querySnapshot.empty) {
      throw new NotFoundError("api-key does not exist");
    }
    if (querySnapshot.size > 1) {
      console.warn("Trying to get multiple api-keys");
    }
    const apiKeyPrivateDoc = querySnapshot.docs[0];
    if (apiKeyPrivateDoc.ref.parent.parent === null) {
      throw new Error("API Key private doc is not in a sub collection");
    }
    if (apiKeyPrivateDoc.ref.parent.parent.parent.id !== "api-keys") {
      throw new Error("API Key private doc is not in the api-keys collection");
    }

    const apiKeyRef = apiKeyPrivateDoc.ref.parent.parent;
    const apiKeyDoc = await apiKeyRef.get();
    const { uid, createdAt } = apiKeyDoc.data();
    return { id: apiKeyRef.id, uid, createdAt };
  } catch (x) {
    console.log("buildFindByToken() x=" + x.stack);
    throw x;
  }
};

const buildFindById = ({ db }) => async (id) => {
  const apiKeyRef = db.doc(`api-keys/${id}`);
  const apiKeyDoc = await apiKeyRef.get();
  if (!apiKeyDoc.exists) {
    throw new NotFoundError();
  }
  const { uid, createdAt } = apiKeyDoc.data();
  return { id, uid, createdAt };
};

const buildList = ({ db }) => async ({ uid, limit, createdAfterMillis }) => {
  if (!Number.isInteger(limit)) {
    limit = 100;
  } else if (limit < 5) {
    limit = 5;
  }

  const db = getFirestore();
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
  const db = getFirestore();
  const create = buildCreate({ db });
  const removeById = buildRemoveById({ db });
  const findById = buildFindById({ db });
  const findByToken = buildFindByToken({ db });
  const list = buildList({ db });
  return { create, removeById, findById, findByToken, list };
};
