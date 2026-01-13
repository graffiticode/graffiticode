import { NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { v4 } from "uuid";
import { getFirestore } from "../firebase.js";

const FieldValue = admin.firestore.FieldValue;

const buildCreate = () => async ({ uid, provider, providerId, email }) => {
  const db = getFirestore();
  const id = v4();
  const createdAt = FieldValue.serverTimestamp();

  const batchWriter = db.batch();

  // Main oauth-links document
  const oauthLinkRef = db.doc(`oauth-links/${id}`);
  batchWriter.create(oauthLinkRef, { uid, provider, providerId, email, createdAt });

  // Index for looking up by providerId
  const providerIdIndexRef = db.doc(`oauth-links/-indexes-/provider-id/${provider}_${providerId}`);
  batchWriter.create(providerIdIndexRef, { id });

  await batchWriter.commit();

  return { id, uid, provider, providerId, email };
};

const buildRemoveByUidAndProvider = () => async ({ uid, provider }) => {
  const db = getFirestore();

  // Find the oauth link by uid and provider
  const snapshot = await db.collection("oauth-links")
    .where("uid", "==", uid)
    .where("provider", "==", provider)
    .limit(1)
    .get();

  if (snapshot.empty) {
    throw new NotFoundError("oauth-link does not exist");
  }

  const doc = snapshot.docs[0];
  const { providerId } = doc.data();

  const batchWriter = db.batch();

  // Delete main document
  batchWriter.delete(doc.ref);

  // Delete provider ID index
  const providerIdIndexRef = db.doc(`oauth-links/-indexes-/provider-id/${provider}_${providerId}`);
  batchWriter.delete(providerIdIndexRef);

  await batchWriter.commit();
};

const buildFindByProviderId = () => async ({ provider, providerId }) => {
  const db = getFirestore();

  // Use index to find the oauth link
  const indexRef = db.doc(`oauth-links/-indexes-/provider-id/${provider}_${providerId}`);
  const indexDoc = await indexRef.get();

  if (!indexDoc.exists) {
    throw new NotFoundError("oauth-link does not exist");
  }

  const id = indexDoc.get("id");
  const oauthLinkRef = db.doc(`oauth-links/${id}`);
  const oauthLinkDoc = await oauthLinkRef.get();

  if (!oauthLinkDoc.exists) {
    throw new NotFoundError("oauth-link does not exist");
  }

  const { uid, provider: prov, email, createdAt } = oauthLinkDoc.data();
  return { id, uid, provider: prov, providerId, email, createdAt };
};

const buildListByUid = () => async ({ uid }) => {
  const db = getFirestore();

  const snapshot = await db.collection("oauth-links")
    .where("uid", "==", uid)
    .orderBy("createdAt")
    .get();

  return snapshot.docs.map(doc => ({
    id: doc.id,
    uid: doc.get("uid"),
    provider: doc.get("provider"),
    providerId: doc.get("providerId"),
    email: doc.get("email"),
    createdAt: doc.get("createdAt"),
  }));
};

const buildExistsByProviderId = () => async ({ provider, providerId }) => {
  const db = getFirestore();

  const indexRef = db.doc(`oauth-links/-indexes-/provider-id/${provider}_${providerId}`);
  const indexDoc = await indexRef.get();

  return indexDoc.exists;
};

export const buildOAuthLinkStorer = () => {
  const create = buildCreate();
  const removeByUidAndProvider = buildRemoveByUidAndProvider();
  const findByProviderId = buildFindByProviderId();
  const listByUid = buildListByUid();
  const existsByProviderId = buildExistsByProviderId();
  return { create, removeByUidAndProvider, findByProviderId, listByUid, existsByProviderId };
};
