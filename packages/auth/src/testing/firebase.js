import { getAuth, getFirestore } from "../firebase.js";

export const cleanUpFirebase = async () => {
  // Clean up auth
  const auth = getAuth();
  const { users } = await auth.listUsers();
  await auth.deleteUsers(users.map(user => user.uid));

  // Clean up firestore
  const db = getFirestore();
  const cols = await db.listCollections();
  await Promise.all(cols.map(c => db.recursiveDelete(c)));
};
