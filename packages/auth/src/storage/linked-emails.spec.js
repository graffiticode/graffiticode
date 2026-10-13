// Characterization tests: these pin the CURRENT behavior of
// storage/linked-emails.js (written before the TypeScript migration), not a
// judgment of it. Runs against the Firestore emulator.
import crypto from "crypto";
import { ConflictError, NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { getFirestore } from "../firebase.js";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildLinkedEmailStorer, linkedEmailDocId, normalizeEmail } from "./linked-emails.js";

const Timestamp = admin.firestore.Timestamp;
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

describe("storage/linked-emails", () => {
  let storer;
  beforeEach(() => {
    storer = buildLinkedEmailStorer();
  });

  afterEach(cleanUpFirebase);

  it("normalizes by trimming and lowercasing, and ids are sha256 of that", () => {
    expect(normalizeEmail("  A@Example.COM ")).toBe("a@example.com");
    expect(normalizeEmail(42)).toBe("42");
    expect(linkedEmailDocId(" A@Example.com")).toBe(sha256("a@example.com"));
  });

  describe("create", () => {
    it("stores the normalized email and returns the record with server timestamps", async () => {
      const record = await storer.create({ uid: "u1", email: " A@Example.com " });
      expect(record).toEqual({
        id: sha256("a@example.com"),
        uid: "u1",
        email: "a@example.com",
        createdAt: expect.any(Timestamp),
        verifiedAt: expect.any(Timestamp),
      });
    });

    it("keeps a provided verifiedAt", async () => {
      const verifiedAt = Timestamp.fromMillis(1_700_000_000_000);
      const record = await storer.create({ uid: "u1", email: "a@x.com", verifiedAt });
      expect(record.verifiedAt.toMillis()).toBe(1_700_000_000_000);
    });

    it("throws ConflictError naming the owner when the email is already linked", async () => {
      await storer.create({ uid: "u1", email: "a@x.com" });
      const attempt = storer.create({ uid: "u2", email: "A@X.com" });
      await expect(attempt).rejects.toThrow(ConflictError);
      await expect(storer.create({ uid: "u1", email: "a@x.com" })).rejects.toMatchObject({
        message: "email already linked to uid u1",
        details: { conflictUid: "u1", email: "a@x.com" },
      });
    });
  });

  it("findByEmail normalizes; findById takes the doc id; both return null when absent", async () => {
    const { id } = await storer.create({ uid: "u1", email: "a@x.com" });
    await expect(storer.findByEmail({ email: " A@X.COM" })).resolves.toMatchObject({ id, uid: "u1" });
    await expect(storer.findById({ id })).resolves.toMatchObject({ id, uid: "u1", email: "a@x.com" });
    await expect(storer.findByEmail({ email: "b@x.com" })).resolves.toBeNull();
    await expect(storer.findById({ id: "nope" })).resolves.toBeNull();
  });

  it("listByUid returns only that uid's emails, oldest first", async () => {
    await storer.create({ uid: "u1", email: "first@x.com" });
    await new Promise(resolve => setTimeout(resolve, 5));
    await storer.create({ uid: "u1", email: "second@x.com" });
    await storer.create({ uid: "u2", email: "other@x.com" });

    const records = await storer.listByUid({ uid: "u1" });

    expect(records.map(r => r.email)).toEqual(["first@x.com", "second@x.com"]);
    await expect(storer.listByUid({ uid: "nobody" })).resolves.toEqual([]);
  });

  describe("removeById", () => {
    it("deletes the record", async () => {
      const { id } = await storer.create({ uid: "u1", email: "a@x.com" });
      await expect(storer.removeById({ id })).resolves.toBeUndefined();
      await expect(storer.findById({ id })).resolves.toBeNull();
    });

    it("deletes only when the uid matches, if a uid is given", async () => {
      const { id } = await storer.create({ uid: "u1", email: "a@x.com" });
      await expect(storer.removeById({ id, uid: "u2" })).rejects.toThrow(new NotFoundError("linked-email not found"));
      await expect(storer.findById({ id })).resolves.not.toBeNull();
      await expect(storer.removeById({ id, uid: "u1" })).resolves.toBeUndefined();
    });

    it("throws NotFoundError for a missing record", async () => {
      await expect(storer.removeById({ id: "nope" })).rejects.toThrow(new NotFoundError("linked-email not found"));
    });
  });

  describe("transferEmail", () => {
    it("moves the email to toUid and resets verifiedAt", async () => {
      const verifiedAt = Timestamp.fromMillis(1_700_000_000_000);
      await storer.create({ uid: "u1", email: "a@x.com", verifiedAt });

      const record = await storer.transferEmail({ email: "A@X.com", fromUid: "u1", toUid: "u2" });

      expect(record).toMatchObject({ uid: "u2", email: "a@x.com" });
      expect(record.verifiedAt.toMillis()).toBeGreaterThan(1_700_000_000_000);
    });

    it("throws NotFoundError for an unlinked email", async () => {
      await expect(storer.transferEmail({ email: "a@x.com", fromUid: "u1", toUid: "u2" }))
        .rejects.toThrow(new NotFoundError("linked-email not found"));
    });

    it("throws ConflictError naming the owner when fromUid does not own it", async () => {
      await storer.create({ uid: "u1", email: "a@x.com" });
      await expect(storer.transferEmail({ email: "a@x.com", fromUid: "u3", toUid: "u2" })).rejects.toMatchObject({
        message: "linked-email is not owned by fromUid",
        details: { conflictUid: "u1" },
      });
      await expect(storer.findByEmail({ email: "a@x.com" })).resolves.toHaveProperty("uid", "u1");
    });
  });

  describe("searchUidsByEmailFragment", () => {
    it("returns distinct owning uids whose email contains the normalized fragment", async () => {
      await storer.create({ uid: "u1", email: "alice@example.com" });
      await storer.create({ uid: "u1", email: "alice@work.com" });
      await storer.create({ uid: "u2", email: "bob@example.com" });

      const uids = await storer.searchUidsByEmailFragment({ fragment: " EXAMPLE ", limit: 10 });
      expect(uids.sort()).toEqual(["u1", "u2"]);
      await expect(storer.searchUidsByEmailFragment({ fragment: "alice", limit: 10 })).resolves.toEqual(["u1"]);
      await expect(storer.searchUidsByEmailFragment({ fragment: "zzz", limit: 10 })).resolves.toEqual([]);
    });

    it("stops at limit", async () => {
      await storer.create({ uid: "u1", email: "a@example.com" });
      await storer.create({ uid: "u2", email: "b@example.com" });
      await expect(storer.searchUidsByEmailFragment({ fragment: "example", limit: 1 })).resolves.toHaveLength(1);
    });

    it("skips rows with no uid or a non-string email", async () => {
      const db = getFirestore();
      await db.doc("linked-emails/no-uid").set({ email: "x@example.com" });
      await db.doc("linked-emails/bad-email").set({ uid: "u9", email: 7 });
      await expect(storer.searchUidsByEmailFragment({ fragment: "example", limit: 10 })).resolves.toEqual([]);
    });
  });
});
