import { admin } from "../storage/firebase.js";

// Deletes every collection in the default database, for tests. Refuses unless
// the Firebase Admin SDK is pointed at the emulator: without
// FIRESTORE_EMULATOR_HOST it would reach the real project with the caller's
// credentials, and on 2026-11-10 a run of a spec without the emulator deleted
// production collections this way.
export const clearFirestore = async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("clearFirestore: FIRESTORE_EMULATOR_HOST is not set; refusing to delete collections outside the emulator");
  }
  const db = admin.firestore();
  const cols = await db.listCollections();
  await Promise.all(cols.map(c => db.recursiveDelete(c)));
};
