#!/usr/bin/env node
/*
 * Backfill linked_emails rows from existing oauth-links docs.
 *
 * For every doc in `oauth-links` with a populated `email` field, attempt to
 * create the corresponding linked_emails doc keyed by sha256(normalizedEmail).
 *
 * Usage:
 *   node tools/backfill-linked-emails.js            # dry-run
 *   node tools/backfill-linked-emails.js --apply    # actually write
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS (or running against the firestore
 * emulator) to identify the target project.
 */
import admin from "firebase-admin";
import { buildLinkedEmailStorer, normalizeEmail } from "../src/storage/linked-emails.js";

const apply = process.argv.includes("--apply");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  const db = admin.firestore();
  const linkedEmailStorer = buildLinkedEmailStorer();

  const snap = await db.collection("oauth-links").get();
  console.log(`Found ${snap.size} oauth-links docs`);

  let migrated = 0;
  let skippedNoEmail = 0;
  let skippedSameUid = 0;
  let conflicts = 0;

  for (const doc of snap.docs) {
    if (doc.id === "-indexes-") continue;
    const data = doc.data();
    const { uid, email } = data;
    if (!uid || !email) {
      skippedNoEmail += 1;
      continue;
    }
    const normalized = normalizeEmail(email);

    if (!apply) {
      console.log(`would migrate ${normalized} → ${uid}`);
      migrated += 1;
      continue;
    }

    try {
      await linkedEmailStorer.create({ uid, email: normalized });
      migrated += 1;
      console.log(`migrated ${normalized} → ${uid}`);
    } catch (err) {
      if (err?.details?.conflictUid === uid) {
        skippedSameUid += 1;
        continue;
      }
      if (err?.details?.conflictUid) {
        conflicts += 1;
        console.error(
          `CONFLICT: email=${normalized} oauth_uid=${uid} linked_uid=${err.details.conflictUid}`,
        );
        continue;
      }
      console.error(`error for ${normalized} (${uid}):`, err.message);
    }

    // Polite throttle so we don't hammer Firestore on big tables.
    if (migrated % 50 === 0) {
      await sleep(50);
    }
  }

  console.log("---");
  console.log(`Migrated:        ${migrated}`);
  console.log(`Skipped (no email): ${skippedNoEmail}`);
  console.log(`Skipped (same uid): ${skippedSameUid}`);
  console.log(`Conflicts:       ${conflicts}`);
  if (!apply) {
    console.log("\nDry-run. Re-run with --apply to write.");
  }
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
