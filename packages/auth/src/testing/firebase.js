import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, getIdToken, signInWithCustomToken } from "firebase/auth";
import { getAuth as getAdminAuth, getFirestore } from "../firebase.js";

const firebaseConfig = {
  apiKey: "AIzaSyAoVuUNi8ElnS7cn6wc3D8XExML-URLw0I",
  authDomain: "graffiticode.firebaseapp.com",
  databaseURL: "https://graffiticode.firebaseio.com",
  projectId: "graffiticode",
  storageBucket: "graffiticode.appspot.com",
  messagingSenderId: "656973052505",
  appId: "1:656973052505:web:f3f3cc6397a844599c8f48",
  measurementId: "G-KRPK1CDB19"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });

export const signInAndGetIdToken = async (customToken) => {
  const { user } = await signInWithCustomToken(auth, customToken);
  const token = await getIdToken(user);
  return token;
};

export const cleanUpFirebase = async () => {
  // Deletes every user and every collection: only ever against the emulators.
  // Without these, the Admin SDK reaches the real project with the caller's
  // credentials (on 2026-11-10 the api's equivalent deleted production data).
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error("cleanUpFirebase: FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST must be set; refusing to delete outside the emulators");
  }
  // Clean up auth
  const auth = getAdminAuth();
  const { users } = await auth.listUsers();
  await auth.deleteUsers(users.map(user => user.uid));

  // Clean up firestore
  const db = getFirestore();
  const cols = await db.listCollections();
  await Promise.all(cols.map(c => db.recursiveDelete(c)));
};
