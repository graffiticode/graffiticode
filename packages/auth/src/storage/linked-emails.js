import crypto from "crypto";
import { ConflictError, NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { getFirestore } from "../firebase.js";

const FieldValue = admin.firestore.FieldValue;

// Doc id is the sha256 of the normalized email — provides global uniqueness
// without worrying about email-character edge cases in Firestore IDs.
const normalize = (email) => String(email).trim().toLowerCase();
const docIdFor = (email) =>
  crypto.createHash("sha256").update(normalize(email)).digest("hex");

const toRecord = (doc) => {
  const data = doc.data();
  return {
    id: doc.id,
    uid: data.uid,
    email: data.email,
    createdAt: data.createdAt,
    verifiedAt: data.verifiedAt,
  };
};

const buildCreate = () => async ({ uid, email, verifiedAt }) => {
  const db = getFirestore();
  const normalizedEmail = normalize(email);
  const id = docIdFor(normalizedEmail);
  const ref = db.doc(`linked-emails/${id}`);

  try {
    await ref.create({
      uid,
      email: normalizedEmail,
      createdAt: FieldValue.serverTimestamp(),
      verifiedAt: verifiedAt ?? FieldValue.serverTimestamp(),
    });
  } catch (err) {
    if (err.code === 6 /* ALREADY_EXISTS */) {
      const existing = await ref.get();
      const data = existing.data() || {};
      throw new ConflictError(
        `email already linked to uid ${data.uid}`,
        { conflictUid: data.uid, email: normalizedEmail },
      );
    }
    throw err;
  }

  const snap = await ref.get();
  return toRecord(snap);
};

const buildFindByEmail = () => async ({ email }) => {
  const db = getFirestore();
  const id = docIdFor(email);
  const snap = await db.doc(`linked-emails/${id}`).get();
  if (!snap.exists) return null;
  return toRecord(snap);
};

const buildFindById = () => async ({ id }) => {
  const db = getFirestore();
  const snap = await db.doc(`linked-emails/${id}`).get();
  if (!snap.exists) return null;
  return toRecord(snap);
};

const buildListByUid = () => async ({ uid }) => {
  const db = getFirestore();
  const snap = await db
    .collection("linked-emails")
    .where("uid", "==", uid)
    .orderBy("createdAt")
    .get();
  return snap.docs.map(toRecord);
};

const buildRemoveById = () => async ({ id, uid }) => {
  const db = getFirestore();
  const ref = db.doc(`linked-emails/${id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new NotFoundError("linked-email not found");
  }
  const data = snap.data();
  if (uid !== undefined && data.uid !== uid) {
    // Defensive: don't let one uid delete another's row even with a guessed id.
    throw new NotFoundError("linked-email not found");
  }
  await ref.delete();
};

const buildTransferEmail = () => async ({ email, fromUid, toUid }) => {
  const db = getFirestore();
  const id = docIdFor(email);
  const ref = db.doc(`linked-emails/${id}`);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new NotFoundError("linked-email not found");
    }
    const data = snap.data();
    if (data.uid !== fromUid) {
      throw new ConflictError("linked-email is not owned by fromUid", {
        conflictUid: data.uid,
      });
    }
    tx.update(ref, {
      uid: toUid,
      verifiedAt: FieldValue.serverTimestamp(),
    });
  });

  const snap = await ref.get();
  return toRecord(snap);
};

// Substring search over linked emails, returning owning uids only. Reads the
// whole collection (email + uid fields) and filters in memory: fine while the
// collection is small, but it is a full scan per call. If linked-emails grows,
// replace this with an index (e.g. n-gram tokens) or a search service.
const buildSearchUidsByEmailFragment = () => async ({ fragment, limit }) => {
  const db = getFirestore();
  const needle = normalize(fragment);
  const snap = await db.collection("linked-emails").select("uid", "email").get();
  const uids = [];
  const seen = new Set();
  for (const doc of snap.docs) {
    const { uid, email } = doc.data() || {};
    if (!uid || seen.has(uid) || typeof email !== "string") continue;
    if (!email.includes(needle)) continue;
    seen.add(uid);
    uids.push(uid);
    if (uids.length >= limit) break;
  }
  return uids;
};

export const buildLinkedEmailStorer = () => ({
  create: buildCreate(),
  findByEmail: buildFindByEmail(),
  findById: buildFindById(),
  listByUid: buildListByUid(),
  removeById: buildRemoveById(),
  transferEmail: buildTransferEmail(),
  searchUidsByEmailFragment: buildSearchUidsByEmailFragment(),
});

// Exported for tests + email-invite/transfer storage modules that share the
// hashing scheme.
export const normalizeEmail = normalize;
export const linkedEmailDocId = docIdFor;
