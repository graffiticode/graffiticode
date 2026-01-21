/* eslint-disable camelcase */
import { NotFoundError } from "@graffiticode/common/errors";
import { v4 } from "uuid";
import { getFirestore } from "../firebase.js";

/**
 * Storage module for OAuth tokens stored in oauth-links/{linkId}/tokens/{tokenId}
 *
 * Tokens are stored as subcollections under oauth-links with indexes for lookup by
 * access_token and refresh_token.
 */

const buildCreate = () => async (linkId, tokenData) => {
  const db = getFirestore();
  const tokenId = v4();
  const createdAt = Date.now();

  const {
    access_token,
    refresh_token,
    firebase_id_token,
    firebase_refresh_token,
    firebase_token_expires_at,
    client_id,
    client_name,
    scope,
    resource,
  } = tokenData;

  const batchWriter = db.batch();

  // Main token document in subcollection
  const tokenRef = db.doc(`oauth-links/${linkId}/tokens/${tokenId}`);
  batchWriter.create(tokenRef, {
    access_token,
    refresh_token,
    firebase_id_token,
    firebase_refresh_token,
    firebase_token_expires_at,
    client_id,
    client_name,
    scope,
    resource,
    created_at: createdAt,
  });

  // Index for looking up by access_token
  const accessTokenIndexRef = db.doc(`oauth-links/-indexes-/access-token/${access_token}`);
  batchWriter.create(accessTokenIndexRef, { link_id: linkId, token_id: tokenId });

  // Index for looking up by refresh_token
  const refreshTokenIndexRef = db.doc(`oauth-links/-indexes-/refresh-token/${refresh_token}`);
  batchWriter.create(refreshTokenIndexRef, { link_id: linkId, token_id: tokenId });

  await batchWriter.commit();

  return {
    id: tokenId,
    link_id: linkId,
    access_token,
    refresh_token,
    firebase_id_token,
    firebase_refresh_token,
    firebase_token_expires_at,
    client_id,
    client_name,
    scope,
    resource,
    created_at: createdAt,
  };
};

const buildFindByAccessToken = () => async (accessToken) => {
  const db = getFirestore();

  // Use index to find the token
  const indexRef = db.doc(`oauth-links/-indexes-/access-token/${accessToken}`);
  const indexDoc = await indexRef.get();

  if (!indexDoc.exists) {
    return null;
  }

  const { link_id, token_id } = indexDoc.data();
  const tokenRef = db.doc(`oauth-links/${link_id}/tokens/${token_id}`);
  const tokenDoc = await tokenRef.get();

  if (!tokenDoc.exists) {
    return null;
  }

  const data = tokenDoc.data();
  return {
    id: token_id,
    link_id,
    ...data,
  };
};

const buildFindByRefreshToken = () => async (refreshToken) => {
  const db = getFirestore();

  // Use index to find the token
  const indexRef = db.doc(`oauth-links/-indexes-/refresh-token/${refreshToken}`);
  const indexDoc = await indexRef.get();

  if (!indexDoc.exists) {
    return null;
  }

  const { link_id, token_id } = indexDoc.data();
  const tokenRef = db.doc(`oauth-links/${link_id}/tokens/${token_id}`);
  const tokenDoc = await tokenRef.get();

  if (!tokenDoc.exists) {
    return null;
  }

  const data = tokenDoc.data();
  return {
    id: token_id,
    link_id,
    ...data,
  };
};

const buildUpdate = () => async (linkId, tokenId, updates) => {
  const db = getFirestore();

  const tokenRef = db.doc(`oauth-links/${linkId}/tokens/${tokenId}`);
  const tokenDoc = await tokenRef.get();

  if (!tokenDoc.exists) {
    throw new NotFoundError("Token not found");
  }

  await tokenRef.update(updates);

  const updatedDoc = await tokenRef.get();
  return {
    id: tokenId,
    link_id: linkId,
    ...updatedDoc.data(),
  };
};

const buildRemove = () => async (linkId, tokenId) => {
  const db = getFirestore();

  const tokenRef = db.doc(`oauth-links/${linkId}/tokens/${tokenId}`);
  const tokenDoc = await tokenRef.get();

  if (!tokenDoc.exists) {
    throw new NotFoundError("Token not found");
  }

  const { access_token, refresh_token } = tokenDoc.data();

  const batchWriter = db.batch();

  // Delete main token document
  batchWriter.delete(tokenRef);

  // Delete access_token index
  const accessTokenIndexRef = db.doc(`oauth-links/-indexes-/access-token/${access_token}`);
  batchWriter.delete(accessTokenIndexRef);

  // Delete refresh_token index
  const refreshTokenIndexRef = db.doc(`oauth-links/-indexes-/refresh-token/${refresh_token}`);
  batchWriter.delete(refreshTokenIndexRef);

  await batchWriter.commit();
};

const buildRemoveByClientId = () => async (linkId, clientId) => {
  const db = getFirestore();

  // Find existing token for this client
  const tokensRef = db.collection(`oauth-links/${linkId}/tokens`);
  const snapshot = await tokensRef.where("client_id", "==", clientId).limit(1).get();

  if (snapshot.empty) {
    return; // No existing token for this client
  }

  const doc = snapshot.docs[0];
  const { access_token, refresh_token } = doc.data();

  const batchWriter = db.batch();

  // Delete main token document
  batchWriter.delete(doc.ref);

  // Delete access_token index
  const accessTokenIndexRef = db.doc(`oauth-links/-indexes-/access-token/${access_token}`);
  batchWriter.delete(accessTokenIndexRef);

  // Delete refresh_token index
  const refreshTokenIndexRef = db.doc(`oauth-links/-indexes-/refresh-token/${refresh_token}`);
  batchWriter.delete(refreshTokenIndexRef);

  await batchWriter.commit();
};

const buildListByLinkId = () => async (linkId) => {
  const db = getFirestore();

  const tokensRef = db.collection(`oauth-links/${linkId}/tokens`);
  const snapshot = await tokensRef.orderBy("created_at", "desc").get();

  return snapshot.docs.map(doc => ({
    id: doc.id,
    link_id: linkId,
    ...doc.data(),
  }));
};

export const buildOAuthTokenStorer = () => {
  const create = buildCreate();
  const findByAccessToken = buildFindByAccessToken();
  const findByRefreshToken = buildFindByRefreshToken();
  const update = buildUpdate();
  const remove = buildRemove();
  const removeByClientId = buildRemoveByClientId();
  const listByLinkId = buildListByLinkId();

  return {
    create,
    findByAccessToken,
    findByRefreshToken,
    update,
    remove,
    removeByClientId,
    listByLinkId,
  };
};
