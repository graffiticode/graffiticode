import { createFirestoreDb } from "../storage/firestore.js";

export const clearFirestore = async () => {
  const db = createFirestoreDb({});
  const cols = await db.listCollections();
  await Promise.all(cols.map(c => db.recursiveDelete(c)));
};
