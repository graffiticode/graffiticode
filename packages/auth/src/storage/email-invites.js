import { NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { v4 } from "uuid";
import { getFirestore } from "../firebase.js";
import { normalizeEmail } from "./linked-emails.js";

const FieldValue = admin.firestore.FieldValue;

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

const toRecord = (doc) => {
  const data = doc.data();
  return {
    id: doc.id,
    uid: data.uid,
    email: data.email,
    status: data.status,
    createdAt: data.createdAt,
    expiresAt: data.expiresAt,
    confirmedAt: data.confirmedAt,
    declinedAt: data.declinedAt,
  };
};

const buildCreate = () => async ({ uid, email }) => {
  const db = getFirestore();
  const id = v4();
  const normalizedEmail = normalizeEmail(email);
  const now = Date.now();
  const ref = db.doc(`email-invites/${id}`);
  await ref.create({
    uid,
    email: normalizedEmail,
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: new Date(now + INVITE_TTL_MS),
  });
  const snap = await ref.get();
  return toRecord(snap);
};

const buildFindById = () => async ({ id }) => {
  const db = getFirestore();
  const snap = await db.doc(`email-invites/${id}`).get();
  if (!snap.exists) return null;
  return toRecord(snap);
};

const buildListPendingByUid = () => async ({ uid }) => {
  const db = getFirestore();
  const snap = await db
    .collection("email-invites")
    .where("uid", "==", uid)
    .where("status", "==", "pending")
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map(toRecord);
};

const buildListPendingByEmail = () => async ({ email }) => {
  const db = getFirestore();
  const snap = await db
    .collection("email-invites")
    .where("email", "==", normalizeEmail(email))
    .where("status", "==", "pending")
    .get();
  return snap.docs.map(toRecord);
};

const buildMarkStatus = (status, timestampField) => async ({ id }) => {
  const db = getFirestore();
  const ref = db.doc(`email-invites/${id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new NotFoundError("email-invite not found");
  }
  await ref.update({
    status,
    [timestampField]: FieldValue.serverTimestamp(),
  });
  const updated = await ref.get();
  return toRecord(updated);
};

const buildRemove = () => async ({ id }) => {
  const db = getFirestore();
  await db.doc(`email-invites/${id}`).delete();
};

export const buildEmailInviteStorer = () => ({
  create: buildCreate(),
  findById: buildFindById(),
  listPendingByUid: buildListPendingByUid(),
  listPendingByEmail: buildListPendingByEmail(),
  markConfirmed: buildMarkStatus("confirmed", "confirmedAt"),
  markDeclined: buildMarkStatus("declined", "declinedAt"),
  markExpired: buildMarkStatus("expired", "expiredAt"),
  remove: buildRemove(),
});

export const EMAIL_INVITE_TTL_MS = INVITE_TTL_MS;
