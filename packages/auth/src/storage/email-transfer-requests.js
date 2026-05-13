import crypto from "crypto";
import { NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { v4 } from "uuid";
import { getFirestore } from "../firebase.js";
import { normalizeEmail } from "./linked-emails.js";

const FieldValue = admin.firestore.FieldValue;

const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const hashCode = (code, salt) =>
  crypto.createHash("sha256").update(`${salt}:${code}`).digest("hex");

const toRecord = (doc) => {
  const data = doc.data();
  return {
    id: doc.id,
    email: data.email,
    fromUid: data.fromUid,
    toUid: data.toUid,
    status: data.status,
    attempts: data.attempts ?? 0,
    salt: data.salt,
    otpHash: data.otpHash,
    createdAt: data.createdAt,
    expiresAt: data.expiresAt,
  };
};

const buildCreate = () => async ({ email, fromUid, toUid, otp }) => {
  const db = getFirestore();
  const id = v4();
  const salt = crypto.randomBytes(16).toString("hex");
  const otpHash = hashCode(otp, salt);
  const now = Date.now();

  const ref = db.doc(`email-transfer-requests/${id}`);
  await ref.create({
    email: normalizeEmail(email),
    fromUid,
    toUid,
    status: "pending",
    attempts: 0,
    salt,
    otpHash,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: new Date(now + TRANSFER_TTL_MS),
  });
  const snap = await ref.get();
  return toRecord(snap);
};

const buildFindById = () => async ({ id }) => {
  const db = getFirestore();
  const snap = await db.doc(`email-transfer-requests/${id}`).get();
  if (!snap.exists) return null;
  return toRecord(snap);
};

const buildIncrementAttempts = () => async ({ id }) => {
  const db = getFirestore();
  await db.doc(`email-transfer-requests/${id}`).update({
    attempts: FieldValue.increment(1),
  });
};

const buildMarkStatus = (status, timestampField) => async ({ id }) => {
  const db = getFirestore();
  const ref = db.doc(`email-transfer-requests/${id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new NotFoundError("email-transfer-request not found");
  }
  await ref.update({
    status,
    [timestampField]: FieldValue.serverTimestamp(),
  });
  const updated = await ref.get();
  return toRecord(updated);
};

export const buildEmailTransferRequestStorer = () => ({
  create: buildCreate(),
  findById: buildFindById(),
  incrementAttempts: buildIncrementAttempts(),
  markCompleted: buildMarkStatus("completed", "completedAt"),
  markFailed: buildMarkStatus("failed", "failedAt"),
  markExpired: buildMarkStatus("expired", "expiredAt"),
});

export const verifyTransferOtp = (record, code) =>
  hashCode(code, record.salt) === record.otpHash;

export const EMAIL_TRANSFER_TTL_MS = TRANSFER_TTL_MS;
export const EMAIL_TRANSFER_MAX_ATTEMPTS = MAX_ATTEMPTS;
