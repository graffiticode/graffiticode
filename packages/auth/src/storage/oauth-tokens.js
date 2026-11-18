/* eslint-disable camelcase */
import { NotFoundError } from "@graffiticode/common/errors";
import { v4 } from "uuid";
import { getFirestore } from "../firebase.js";
import { deleteTokenIndex, readTokenIndex, tokenIndexRef } from "./token-index.js";
import { assertUnfenced } from "./oauth-migration.js";

const ACCESS = "oauth-links/-indexes-/access-token";
const REFRESH = "oauth-links/-indexes-/refresh-token";

/**
 * Storage module for OAuth tokens stored in oauth-links/{linkId}/tokens/{tokenId}
 *
 * Tokens are stored as subcollections under oauth-links with indexes for lookup by
 * access_token and refresh_token.
 *
 * Every write is a transaction that first reads the migration fence
 * (oauth-migration.js): once Graffiticode's OAuth records are fenced, none
 * commits. Reads are unaffected, and report the migration's marks (migration,
 * revoked_at) as stored; the routes present them (withMarks).
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

  await db.runTransaction(async tx => {
    await assertUnfenced(tx, db);
    writeToken(tx, db, linkId, tokenId, tokenData, createdAt);
  });

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

// The token document and both index entries (token-index.js), in `writer`.
const writeToken = (writer, db, linkId, tokenId, tokenData, createdAt) => {
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
  writer.create(db.doc(`oauth-links/${linkId}/tokens/${tokenId}`), {
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
  writer.create(tokenIndexRef(db, ACCESS, access_token), { link_id: linkId, token_id: tokenId });
  writer.create(tokenIndexRef(db, REFRESH, refresh_token), { link_id: linkId, token_id: tokenId });
};

/** @param {any} writer @param {any} db @param {any} ref @param {Record<string, any>} data */
const deleteToken = (writer, db, ref, { access_token, refresh_token }) => {
  writer.delete(ref);
  if (access_token) deleteTokenIndex(writer, db, ACCESS, access_token);
  if (refresh_token) deleteTokenIndex(writer, db, REFRESH, refresh_token);
};

const buildFindByAccessToken = () => async (accessToken) => {
  const db = getFirestore();

  // Use index to find the token
  const index = await readTokenIndex(db, ACCESS, accessToken);

  if (!index) {
    return null;
  }

  const { link_id, token_id } = index;
  const tokenRef = db.doc(`oauth-links/${link_id}/tokens/${token_id}`);
  const tokenDoc = await tokenRef.get();

  if (!tokenDoc.exists) {
    return null;
  }

  const data = tokenDoc.data();
  // A refresh token that no index reaches can't be refreshed: it's reported
  // absent, as the migration contract presents the token (oauth-migration.js,
  // usableToken), so a caller keys and migrates what's usable and nothing more.
  const refresh = data.refresh_token ? await readTokenIndex(db, REFRESH, data.refresh_token) : null;
  const refreshUsable = refresh?.link_id === link_id && refresh?.token_id === token_id;
  return {
    id: token_id,
    link_id,
    ...data,
    ...(data.refresh_token && !refreshUsable ? { refresh_token: null } : {}),
  };
};

const buildFindByRefreshToken = () => async (refreshToken) => {
  const db = getFirestore();

  // Use index to find the token
  const index = await readTokenIndex(db, REFRESH, refreshToken);

  if (!index) {
    return null;
  }

  const { link_id, token_id } = index;
  const tokenRef = db.doc(`oauth-links/${link_id}/tokens/${token_id}`);
  const tokenDoc = await tokenRef.get();

  if (!tokenDoc.exists) {
    return null;
  }

  const data = tokenDoc.data();
  // Whether its access token still authenticates (an index reaches it), as
  // the migration contract presents the token (oauth-migration.js,
  // usableToken): an importer never revives one that doesn't.
  const access = data.access_token ? await readTokenIndex(db, ACCESS, data.access_token) : null;
  return {
    id: token_id,
    link_id,
    ...data,
    access_usable: access?.link_id === link_id && access?.token_id === token_id,
  };
};

const buildUpdate = () => async (linkId, tokenId, updates) => {
  const db = getFirestore();

  const tokenRef = db.doc(`oauth-links/${linkId}/tokens/${tokenId}`);
  const data = await db.runTransaction(async tx => {
    await assertUnfenced(tx, db);
    const tokenDoc = await tx.get(tokenRef);
    if (!tokenDoc.exists) {
      throw new NotFoundError("Token not found");
    }
    tx.update(tokenRef, updates);
    return { ...tokenDoc.data(), ...updates };
  });
  return {
    id: tokenId,
    link_id: linkId,
    ...data,
  };
};

const buildRemove = () => async (linkId, tokenId) => {
  const db = getFirestore();

  const tokenRef = db.doc(`oauth-links/${linkId}/tokens/${tokenId}`);
  await db.runTransaction(async tx => {
    await assertUnfenced(tx, db);
    const tokenDoc = await tx.get(tokenRef);
    if (!tokenDoc.exists) {
      throw new NotFoundError("Token not found");
    }
    // The token and both index entries, under both names (token-index.js)
    deleteToken(tx, db, tokenRef, tokenDoc.data());
  });
};

const buildRemoveByClientId = () => async (linkId, clientId) => {
  const db = getFirestore();

  // Find existing token for this client
  const tokensRef = db.collection(`oauth-links/${linkId}/tokens`);
  await db.runTransaction(async tx => {
    await assertUnfenced(tx, db);
    const snapshot = await tx.get(tokensRef.where("client_id", "==", clientId).limit(1));
    if (snapshot.empty) {
      return; // No existing token for this client
    }
    const doc = snapshot.docs[0];
    deleteToken(tx, db, doc.ref, doc.data());
  });
};

// Replace the token a refresh token belongs to with a new one, in one
// transaction: never the old one gone and the new one refused.
const buildRotate = () => async (oldRefreshToken, tokenData) => {
  const db = getFirestore();
  const index = await readTokenIndex(db, REFRESH, oldRefreshToken);
  if (!index) {
    throw new NotFoundError("Token not found");
  }
  const { link_id, token_id } = index;
  const oldRef = db.doc(`oauth-links/${link_id}/tokens/${token_id}`);
  const tokenId = v4();
  const createdAt = Date.now();
  await db.runTransaction(async tx => {
    await assertUnfenced(tx, db);
    const old = await tx.get(oldRef);
    if (!old.exists) {
      throw new NotFoundError("Token not found");
    }
    deleteToken(tx, db, oldRef, old.data());
    writeToken(tx, db, link_id, tokenId, tokenData, createdAt);
  });
  const { access_token, refresh_token, firebase_id_token, firebase_refresh_token, firebase_token_expires_at, client_id, client_name, scope, resource } = tokenData;
  return {
    id: tokenId,
    link_id,
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
  const rotate = buildRotate();
  const listByLinkId = buildListByLinkId();

  return {
    create,
    findByAccessToken,
    findByRefreshToken,
    update,
    remove,
    removeByClientId,
    rotate,
    listByLinkId,
  };
};
