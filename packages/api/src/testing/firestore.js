import { admin } from "../storage/firebase.js";

export const clearFirestore = async () => {
  const db = admin.firestore();
  const cols = await db.listCollections();
  await Promise.all(cols.map(c => db.recursiveDelete(c)));
};
